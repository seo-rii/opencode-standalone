import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { archiveDirectory } from "./archive.mjs"
import { archiveMagic, decodeAssetArchive } from "./runtime.mjs"

// Reuse the browser's emitted files, notices, and already-compressed binary
// assets. No Vite rebuild changes its hashed URLs or service-worker manifest.
const cache = fileURLToPath(new URL("../.cache/web/", import.meta.url))
const manifest = JSON.parse(await readFile(join(cache, "manifest.json"), "utf8"))
const previous = await readFile(join(cache, "app.archive"))
if (createHash("sha256").update(previous).digest("hex") !== manifest.archive.sha256)
  throw new Error("The cached browser archive does not match its manifest")
const brotli = previous.subarray(0, 8).toString("ascii") === archiveMagic ? decodeAssetArchive(previous).brotli : legacy(previous)
const archive = await archiveDirectory(join(cache, "dist"), { brotli })
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
