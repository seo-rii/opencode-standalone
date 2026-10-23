import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"
import { archiveDirectory } from "./archive.mjs"
import { decodeAssetArchive, archiveFormat } from "./runtime.mjs"

test("hybrid archive preserves every URL and raw response with deterministic deduplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-web-archive-"))
  try {
    await mkdir(join(root, "_assets"))
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
    const input = {
      "index.html": Buffer.from('<div id="root">한국어</div>'),
      "sw.js": Buffer.from('self.addEventListener("install", () => {})'),
      "_assets/main.js": Buffer.from('document.body.dataset.loaded = "yes"'),
      "_assets/parser.wasm": wasm,
      "_assets/parser-alias.wasm": wasm,
      "_assets/other.wasm": Buffer.from([0, 97, 115, 109, 2, 0, 0, 0]),
      "_assets/font.woff2": Buffer.from("upstream WOFF2 bytes"),
      "_assets/empty.js": Buffer.alloc(0),
      "_assets/empty-alias.js": Buffer.alloc(0),
    }
    const priorFont = brotliCompressSync(input["_assets/font.woff2"])
    const options = { brotli: { "_assets/font.woff2": priorFont } }
    await Promise.all(Object.entries(input).map(([path, bytes]) => writeFile(join(root, path), bytes)))
    await writeFile(join(root, "_assets/main.js.map"), "not a runtime asset")
    const archive = await archiveDirectory(root, options)
    const decoded = decodeAssetArchive(archive.bytes)
    assert.equal(archive.compression.format, archiveFormat)
    assert.deepEqual(Object.keys(decoded.files), Object.keys(input).sort())
    assert.deepEqual(Object.keys(decoded.brotli), Object.keys(input).sort())
    for (const [path, bytes] of Object.entries(input)) {
      assert.deepEqual(Buffer.from(decoded.files[path]), bytes)
      assert.deepEqual(brotliDecompressSync(decoded.brotli[path]), bytes)
    }
    assert.equal(decoded.brotli["_assets/parser.wasm"], decoded.brotli["_assets/parser-alias.wasm"])
    assert.deepEqual(decoded.brotli["_assets/font.woff2"], priorFont)
    assert.equal(archive.compression.wasmGroups, 1)
    assert.equal(archive.files.find((file) => file.path === "_assets/parser.wasm").compression, "wasm-group-brotli")
    assert.equal(decoded.brotli["_assets/empty.js"], decoded.brotli["_assets/empty-alias.js"])
    const repeated = await archiveDirectory(root, options)
    assert.deepEqual(repeated.bytes, archive.bytes)
    assert.deepEqual(repeated.files, archive.files)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("WASM groups preserve empty files and use a separate bounded large-window dictionary", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-web-wasm-groups-"))
  try {
    const input = {
      "index.html": Buffer.from("<main />"), "sw.js": Buffer.from("install()"),
      "a.wasm": Buffer.alloc(8, 1), "alias.wasm": Buffer.alloc(8, 1),
      "b.wasm": Buffer.alloc(8, 2), "empty.wasm": Buffer.alloc(0), "large.wasm": Buffer.alloc(11, 3),
    }
    await Promise.all(Object.entries(input).map(([path, bytes]) => writeFile(join(root, path), bytes)))
    const archive = await archiveDirectory(root, { wasmGroupBytes: 10 })
    assert.ok(archive.compression.maxWasmGroupBytes <= 10)
    assert.equal(archive.compression.wasmBrotliWindow, 25)
    assert.equal(archive.files.find((file) => file.path === "large.wasm").compression, "brotli")
    assert.notEqual(archive.files.find((file) => file.path === "a.wasm").group, archive.files.find((file) => file.path === "b.wasm").group)
    const decoded = decodeAssetArchive(archive.bytes)
    for (const [path, bytes] of Object.entries(input)) {
      assert.deepEqual(Buffer.from(decoded.files[path]), bytes)
      // The default decoder rejects large-window HTTP streams, so this also
      // verifies that internal large-window data never leaks into responses.
      assert.deepEqual(brotliDecompressSync(decoded.brotli[path]), bytes)
    }
    assert.equal(decoded.brotli["a.wasm"], decoded.brotli["alias.wasm"])
    const bodyAt = 12 + archive.bytes.readUInt32LE(8)
    const index = JSON.parse(archive.bytes.subarray(12, bodyAt))
    const group = index.groups[index.files["a.wasm"][0]]
    const stored = archive.bytes.subarray(bodyAt + group[0], bodyAt + group[0] + group[1])
    assert.throws(() => brotliDecompressSync(stored))
    const raw = brotliDecompressSync(stored, { params: { [constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 } })
    const cached = await archiveDirectory(root, {
      wasmGroupBytes: 10,
      compressedGroups: new Map([[createHash("sha256").update(raw).digest("hex"), stored]]),
    })
    assert.deepEqual(cached.bytes, archive.bytes)
    await assert.rejects(archiveDirectory(root, { wasmGroupBytes: 0 }), /WASM group size/)
    await assert.rejects(archiveDirectory(root, { wasmGroupBytes: 41 * 1024 * 1024 }), /WASM group size/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("raw groups obey the selected bound while oversized files retain independent Brotli", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-web-groups-"))
  try {
    const input = {
      "index.html": Buffer.from("<main />"), "sw.js": Buffer.from("install()"),
      "a.ttf": Buffer.alloc(70, 1), "b.ttf": Buffer.alloc(70, 2), "large.js": Buffer.alloc(140, 3),
    }
    await Promise.all(Object.entries(input).map(([path, bytes]) => writeFile(join(root, path), bytes)))
    const archive = await archiveDirectory(root, { groupBytes: 100 })
    assert.ok(archive.compression.maxRawGroupBytes <= 100)
    assert.equal(archive.files.find((file) => file.path === "large.js").compression, "brotli")
    assert.notEqual(archive.files.find((file) => file.path === "a.ttf").group, archive.files.find((file) => file.path === "b.ttf").group)
    const decoded = decodeAssetArchive(archive.bytes)
    for (const [path, bytes] of Object.entries(input)) assert.deepEqual(Buffer.from(decoded.files[path]), bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
