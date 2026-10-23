import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"
import { performance } from "node:perf_hooks"
import { transformWithEsbuild } from "vite"
import { encodePayload } from "./encoding.mjs"

const directory = fileURLToPath(new URL("../", import.meta.url))
const output = path.join(directory, ".cache/size")
await mkdir(output, { recursive: true })
const source = await readFile(path.join(directory, ".cache/bundle/app.mjs"), "utf8")
const started = performance.now()
const minified = await transformWithEsbuild(source, "opencode-standalone.mjs", {
  loader: "js", target: "node26", minify: true, keepNames: true, legalComments: "none", tsconfigRaw: "{}",
})
await writeFile(path.join(output, "app.min.mjs"), minified.code)
const measurements = [{ action: "minify-keep-names", before: Buffer.byteLength(source), after: Buffer.byteLength(minified.code), milliseconds: performance.now() - started }]
for (const [name, value] of [["original-app", Buffer.from(source)], ["minified-app", Buffer.from(minified.code)]]) {
  for (const quality of [6, 11]) {
    const at = performance.now()
    const bytes = brotliCompressSync(value, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })
    if (!brotliDecompressSync(bytes).equals(value)) throw new Error(`Compression mismatch: ${name}`)
    measurements.push({ name, quality, bytes: bytes.length, base64: bytes.toString("base64").length, base95: encodePayload(bytes).length, milliseconds: performance.now() - at })
  }
}
const web = await readFile(path.join(directory, ".cache/web/app.archive"))
const at = performance.now()
const compressed = brotliCompressSync(web, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
if (!brotliDecompressSync(compressed).equals(web)) throw new Error("Web compression mismatch")
measurements.push({ name: "outer-web", before: web.length, quality: 6, bytes: compressed.length, base64: compressed.toString("base64").length, base95: encodePayload(compressed).length, milliseconds: performance.now() - at })
await writeFile(path.join(output, "measurements.json"), JSON.stringify(measurements, null, 2) + "\n")
console.log(JSON.stringify(measurements, null, 2))
