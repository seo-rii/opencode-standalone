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
const oldIndexLength = old.readUInt32LE(0)
const oldStart = 4 + oldIndexLength
assert.ok(oldStart <= old.length, "Previous browser archive index is truncated")
const oldIndex = JSON.parse(old.subarray(4, oldStart).toString("utf8"))
const bytes = await readFile(new URL("../.cache/web/app.archive", import.meta.url))
const current = decodeAssetArchive(bytes)
const keys = Object.keys(current.files).sort()
assert.deepEqual(keys, Object.keys(oldIndex).sort(), "Browser URLs changed")
for (const key of keys) {
  const [offset, size] = oldIndex[key]
  const body = brotliDecompressSync(old.subarray(oldStart + offset, oldStart + offset + size))
  assert.deepEqual(Buffer.from(current.files[key]), body, `Browser bytes changed: ${key}`)
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
