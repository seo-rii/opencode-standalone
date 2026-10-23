import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { brotliDecompressSync } from "node:zlib"
import { archiveDirectory } from "./archive.mjs"
import { decodeAssetArchive, legacyArchiveMagic, maxRawGroupBytes, maxWasmGroupBytes } from "./runtime.mjs"

async function fixture(input, options) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-web-runtime-"))
  try {
    const files = { "index.html": Buffer.from("<main />"), "sw.js": Buffer.from("install()"), ...input }
    await Promise.all(Object.entries(files).map(async ([path, bytes]) => {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), bytes)
    }))
    return (await archiveDirectory(directory, options)).bytes
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function metadata(bytes, mutate) {
  const bodyAt = 12 + bytes.readUInt32LE(8)
  const index = JSON.parse(bytes.subarray(12, bodyAt))
  mutate(index)
  const encoded = Buffer.from(JSON.stringify(index))
  const header = Buffer.from(bytes.subarray(0, 12))
  header.writeUInt32LE(encoded.length, 8)
  return Buffer.concat([header, encoded, bytes.subarray(bodyAt)])
}

test("index inspection and passthrough responses leave unrelated raw groups compressed", async () => {
  const raw = Buffer.from("real terminal font data".repeat(20))
  const bytes = await fixture({ "font.ttf": raw, "binary.woff2": Buffer.from([0, 97, 115, 109]) })
  const bodyAt = 12 + bytes.readUInt32LE(8)
  const index = JSON.parse(bytes.subarray(12, bodyAt))
  const fontGroup = index.groups[index.files["font.ttf"][0]]
  bytes.fill(255, bodyAt + fontGroup[0], bodyAt + fontGroup[0] + fontGroup[1])
  const decoded = decodeAssetArchive(bytes)
  assert.ok(Object.hasOwn(decoded.brotli, "font.ttf"))
  assert.ok(Object.keys(decoded.files).includes("font.ttf"))
  assert.deepEqual(brotliDecompressSync(decoded.brotli["binary.woff2"]), Buffer.from([0, 97, 115, 109]))
  assert.equal(decoded.files["index.html"], "<main />")
  assert.throws(() => decoded.files["font.ttf"])
})

test("WASM group inspection stays lazy and version 2 archives remain readable", async () => {
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
  const bytes = await fixture({ "binary.wasm": wasm })
  const bodyAt = 12 + bytes.readUInt32LE(8)
  const index = JSON.parse(bytes.subarray(12, bodyAt))
  const group = index.groups[index.files["binary.wasm"][0]]
  bytes.fill(255, bodyAt + group[0], bodyAt + group[0] + group[1])
  const decoded = decodeAssetArchive(bytes)
  assert.ok(Object.hasOwn(decoded.files, "binary.wasm"))
  assert.ok(Object.keys(decoded.brotli).includes("binary.wasm"))
  assert.equal(decoded.files["index.html"], "<main />")
  assert.throws(() => decoded.brotli["binary.wasm"])

  const font = Buffer.from("legacy font bytes")
  const legacy = await fixture({ "font.ttf": font, "binary.woff2": wasm })
  legacy.write(legacyArchiveMagic, 0, "ascii")
  const prior = decodeAssetArchive(legacy)
  assert.equal(prior.files["index.html"], "<main />")
  assert.deepEqual(prior.files["font.ttf"], font)
  assert.deepEqual(brotliDecompressSync(prior.brotli["binary.woff2"]), wasm)
  assert.throws(() => decodeAssetArchive(metadata(legacy, (value) => { value.groups[0][3] = 2 })), /bounds/)
})

test("raw and response caches evict their least recently used groups within their byte limits", async () => {
  const a = Buffer.alloc(300, 49)
  const b = Buffer.alloc(300, 50)
  const bytes = await fixture({ "a.ttf": a, "b.ttf": b }, { groupBytes: 300 })
  const probe = decodeAssetArchive(bytes)
  const brotliCacheBytes = probe.brotli["a.ttf"].length + probe.brotli["b.ttf"].length - 1
  const decoded = decodeAssetArchive(bytes, { rawCacheBytes: 300, brotliCacheBytes })
  const a1 = decoded.files["a.ttf"]
  const cached = decoded.files["a.ttf"]
  assert.ok(cached.buffer === a1.buffer && cached.byteOffset === a1.byteOffset)
  assert.deepEqual(decoded.files["b.ttf"], b)
  const a2 = decoded.files["a.ttf"]
  assert.deepEqual(a2, a)
  assert.ok(a2.buffer !== a1.buffer || a2.byteOffset !== a1.byteOffset)
  const brA1 = decoded.brotli["a.ttf"]
  assert.equal(decoded.brotli["a.ttf"], brA1)
  assert.deepEqual(brotliDecompressSync(decoded.brotli["b.ttf"]), b)
  const brA2 = decoded.brotli["a.ttf"]
  assert.notEqual(brA2, brA1)
  assert.deepEqual(brotliDecompressSync(brA2), a)
})

test("oversized cache entries remain correct without bypassing the selected limit", async () => {
  const bytes = await fixture({ "font.ttf": Buffer.alloc(300, 1) })
  const decoded = decodeAssetArchive(bytes, { rawCacheBytes: 0, brotliCacheBytes: 0 })
  const a = decoded.files["font.ttf"]
  const b = decoded.files["font.ttf"]
  assert.deepEqual(a, b)
  assert.ok(a.buffer !== b.buffer || a.byteOffset !== b.byteOffset)
  assert.notEqual(decoded.brotli["font.ttf"], decoded.brotli["font.ttf"])
})

test("archive boundaries reject bad headers, truncation, invalid groups and invalid file views", async () => {
  const bytes = await fixture({ "font.ttf": Buffer.alloc(70, 1) })
  assert.throws(() => decodeAssetArchive(bytes.subarray(0, 11)), /header/)
  const header = Buffer.from(bytes)
  header[0] = 0
  assert.throws(() => decodeAssetArchive(header), /header/)
  assert.throws(() => decodeAssetArchive(bytes.subarray(0, bytes.length - 1)), /bounds/)
  assert.throws(() => decodeAssetArchive(metadata(bytes, (index) => { index.groups[0][0] = -1 })), /bounds/)
  assert.throws(() => decodeAssetArchive(metadata(bytes, (index) => { index.groups[0][3] = 4 })), /bounds/)
  assert.throws(() => decodeAssetArchive(metadata(bytes, (index) => { index.groups[0][2] = maxRawGroupBytes + 1 })), /bounds/)
  assert.throws(() => decodeAssetArchive(metadata(bytes, (index) => { index.files["font.ttf"][1] = 99999 })), /group/)
  assert.throws(() => decodeAssetArchive(metadata(bytes, (index) => { index.files["font.ttf"][0] = 99999 })), /group/)
  assert.throws(() => decodeAssetArchive(bytes, { rawCacheBytes: -1 }), /cache size/)
  const mismatch = decodeAssetArchive(metadata(bytes, (index) => {
    index.groups[index.files["font.ttf"][0]][2] += 1
  }))
  assert.throws(() => mismatch.files["font.ttf"], /raw size differs/)
  const wasm = await fixture({ "binary.wasm": Buffer.from([0, 97, 115, 109]) })
  assert.throws(() => decodeAssetArchive(metadata(wasm, (index) => {
    index.groups[index.files["binary.wasm"][0]][2] = maxWasmGroupBytes + 1
  })), /bounds/)
})
