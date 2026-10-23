import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { brotliCompress, brotliDecompressSync, constants } from "node:zlib"
import { promisify } from "node:util"

const compress = promisify(brotliCompress)
const cache = fileURLToPath(new URL("../.cache/web/", import.meta.url))
const manifest = JSON.parse(await readFile(join(cache, "manifest.json"), "utf8"))
if (process.argv.slice(2).some((argument) => argument !== "--http"))
  throw new Error("Usage: node web/benchmark.mjs [--http]")
const http = process.argv.includes("--http")
const selected = (http ? ["wasm"] : ["wasm", "ttf", "js", "svg", "woff2"]).flatMap((type) =>
  manifest.files.filter((file) => file.path.endsWith(`.${type}`)).sort((a, b) => b.bytes - a.bytes).slice(0, http ? undefined : 2),
)

// Independent Brotli jobs share libuv's four-thread pool. Keep both memory and
// CPU bounded while comparing the large assets that dominate the archive.
const jobs = selected.flatMap((file) => (http ? [0, 1, 2, 3, 4] : [8, 9, 10, 11]).map((quality) => ({ file, quality })))
const results = []
await Promise.all(Array.from({ length: 4 }, async () => {
  while (jobs.length) {
    const job = jobs.shift()
    await measure(job)
  }
}))

console.log(JSON.stringify({ mode: http ? "http-response" : "storage", baseline: manifest.archive, results: results.sort((a, b) => a.path.localeCompare(b.path) || a.quality - b.quality) }, null, 2))

async function measure({ file, quality }) {
  const body = await readFile(join(cache, "dist", file.path))
  const started = performance.now()
  const compressed = await compress(body, {
    params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: body.length },
  })
  if (!brotliDecompressSync(compressed).equals(body)) throw new Error(`Round-trip failed: ${file.path}`)
  results.push({ path: file.path, bytes: body.length, quality, compressedBytes: compressed.length, baselineCompression: file.compression, baselineGroupBytes: file.groupStoredBytes, milliseconds: Math.round(performance.now() - started) })
}
