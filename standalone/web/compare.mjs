import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { brotliDecompressSync } from "node:zlib"
import { archiveFormat, decodeAssetArchive } from "./runtime.mjs"

// Chain the historical comparison to every byte of the new hybrid archive.
// Run from standalone/: node web/compare.mjs <previous archive> <previous receipt>.
const [previousArchive, previousReceipt] = process.argv.slice(2)
if (!previousArchive || !previousReceipt) throw new Error("Usage: node web/compare.mjs <previous archive> <previous equivalence receipt>")
const old = await readFile(resolve(previousArchive))
const previous = JSON.parse(await readFile(resolve(previousReceipt), "utf8"))
assert.equal(previous.identical, true, "Previous browser archive was not verified")
assert.equal(old.length, previous.newArchiveBytes, "Previous browser archive size changed")
assert.equal(hash(old), previous.newArchiveSha256, "Previous browser archive hash changed")
const oldFiles = old.subarray(0, 5).toString("ascii") === "OCWEB" ? decodeAssetArchive(old).files : legacyFiles(old)
const bytes = await readFile(new URL("../.cache/web/app.archive", import.meta.url))
const current = decodeAssetArchive(bytes)
const keys = Object.keys(current.files).sort()
assert.deepEqual(keys, Object.keys(oldFiles).sort(), "Browser URLs changed")
for (const key of keys) {
  assert.deepEqual(Buffer.from(current.files[key]), Buffer.from(oldFiles[key]), `Browser bytes changed: ${key}`)
}
const receipt = {
  baselineSha256: previous.baselineSha256,
  baselineArchiveBytes: previous.baselineArchiveBytes,
  previousArchiveBytes: old.length,
  previousArchiveSha256: hash(old),
  newArchiveBytes: bytes.length,
  newArchiveSha256: hash(bytes),
  assetsCompared: keys.length,
  identical: true,
  format: archiveFormat,
}
const target = new URL("../.cache/size/web-equivalence.json", import.meta.url)
await mkdir(dirname(fileURLToPath(target)), { recursive: true })
await writeFile(target, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify(receipt))

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex") }

function legacyFiles(bytes) {
  const bodyAt = 4 + bytes.readUInt32LE(0)
  assert.ok(bodyAt <= bytes.length, "Previous browser archive index is truncated")
  const index = JSON.parse(bytes.subarray(4, bodyAt).toString("utf8"))
  const files = Object.create(null)
  for (const [key, [offset, size]] of Object.entries(index)) {
    assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && size <= bytes.length - bodyAt - offset, "Previous browser archive file exceeds its bounds")
    Object.defineProperty(files, key, {
      enumerable: true,
      get: () => brotliDecompressSync(bytes.subarray(bodyAt + offset, bodyAt + offset + size)),
    })
  }
  return files
}
