import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { brotliDecompressSync, constants } from "node:zlib"
import { archiveDirectory } from "./archive.mjs"
import { archiveMagic, legacyArchiveMagic, maxWasmGroupBytes, decodeAssetArchive } from "./runtime.mjs"

// Reuse the browser's emitted files, notices, and already-compressed binary
// assets. No Vite rebuild changes its hashed URLs or service-worker manifest.
const cache = fileURLToPath(new URL("../.cache/web/", import.meta.url))
const manifest = JSON.parse(await readFile(join(cache, "manifest.json"), "utf8"))
const previous = await readFile(join(cache, "app.archive"))
if (createHash("sha256").update(previous).digest("hex") !== manifest.archive.sha256)
  throw new Error("The cached browser archive does not match its manifest")
const magic = previous.subarray(0, 8).toString("ascii")
const grouped = magic === archiveMagic || magic === legacyArchiveMagic
const brotli = grouped ? decodeAssetArchive(previous).brotli : legacy(previous)
const compressedGroups = new Map()
if (grouped) {
  const bodyAt = 12 + previous.readUInt32LE(8)
  const index = JSON.parse(previous.subarray(12, bodyAt).toString("utf8"))
  for (const [offset, stored, raw, mode] of index.groups) {
    if (mode === 1) continue
    const compressed = previous.subarray(bodyAt + offset, bodyAt + offset + stored)
    const bytes = brotliDecompressSync(compressed, {
      maxOutputLength: Math.max(1, raw),
      ...(mode === 2 ? { params: { [constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 } } : {}),
    })
    if (bytes.length !== raw) throw new Error("Cached browser group differs from its declared size")
    compressedGroups.set(createHash("sha256").update(bytes).digest("hex"), compressed)
  }
}
// Optional precomputed groups are content-addressed and round-trip checked by
// the packer. They allow compression experiments to become builds directly.
for (let at = 2; at < process.argv.length; at += 2) {
  if (process.argv[at] !== "--compressed-group" || !process.argv[at + 1])
    throw new Error("Usage: node web/repack.mjs [--compressed-group FILE]...")
  const compressed = await readFile(process.argv[at + 1])
  const bytes = brotliDecompressSync(compressed, {
    maxOutputLength: maxWasmGroupBytes,
    params: { [constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 },
  })
  compressedGroups.set(createHash("sha256").update(bytes).digest("hex"), compressed)
}
const archive = await archiveDirectory(join(cache, "dist"), { brotli, compressedGroups })
manifest.archive = {
  path: "app.archive", bytes: archive.bytes.length,
  sha256: createHash("sha256").update(archive.bytes).digest("hex"),
  ...archive.compression,
}
manifest.files = archive.files
await writeFile(join(cache, "app.archive"), archive.bytes)
await writeFile(join(cache, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(JSON.stringify({ archive: manifest.archive, assets: archive.files.length }))

function legacy(bytes) {
  const bodyAt = 4 + bytes.readUInt32LE(0)
  if (bodyAt > bytes.length) throw new Error("Truncated upstream browser archive index")
  const index = JSON.parse(bytes.subarray(4, bodyAt).toString("utf8"))
  return Object.fromEntries(Object.entries(index).map(([path, [offset, length]]) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > bytes.length - bodyAt - offset)
      throw new Error("Upstream browser archive asset exceeds its bounds")
    return [path, bytes.subarray(bodyAt + offset, bodyAt + offset + length)]
  }))
}
