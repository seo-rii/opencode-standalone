import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { brotliDecompressSync } from "node:zlib"
import { fileURLToPath } from "node:url"
import { build } from "vite"
import { archiveDirectory } from "./archive.mjs"

test("browser archive is decoded losslessly by the actual upstream server format", async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    esbuild: { tsconfigRaw: "{}" },
    ssr: { noExternal: true },
    build: {
      ssr: fileURLToPath(new URL("../../packages/cli/src/app-archive.ts", import.meta.url)),
      write: false,
      minify: false,
      rollupOptions: { output: { format: "esm", inlineDynamicImports: true } },
    },
  })
  const { AppArchive } = await import("data:text/javascript;base64," + Buffer.from(result.output[0].code).toString("base64"))
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
      "_assets/empty.js": Buffer.alloc(0),
      "_assets/empty-alias.js": Buffer.alloc(0),
    }
    await Promise.all(Object.entries(input).map(([path, bytes]) => writeFile(join(root, path), bytes)))
    await writeFile(join(root, "_assets/main.js.map"), "not a runtime asset")
    const archive = await archiveDirectory(root)
    const decoded = AppArchive.decode(archive.bytes)
    assert.deepEqual(Object.keys(decoded), Object.keys(input).sort())
    for (const [path, bytes] of Object.entries(input)) assert.deepEqual(brotliDecompressSync(decoded[path]), bytes)
    assert.equal(decoded["_assets/parser.wasm"].byteOffset, decoded["_assets/parser-alias.wasm"].byteOffset)
    assert.equal(decoded["_assets/empty.js"].byteOffset, decoded["_assets/empty-alias.js"].byteOffset)
    assert.notEqual(decoded["_assets/parser.wasm"].byteOffset, decoded["_assets/other.wasm"].byteOffset)
    const repeated = await archiveDirectory(root)
    assert.deepEqual(repeated.bytes, archive.bytes)
    assert.deepEqual(repeated.files, archive.files)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
