import { createHash } from "node:crypto"

export type Entry = { path: string; oid: string; mode: string }

/** Read SHA-1 indexes without asking Git to rewrite the user's index. */
export function readIndex(bytes: Buffer): Map<string, Entry> {
  if (bytes.length < 32 || bytes.toString("ascii", 0, 4) !== "DIRC") throw new Error("Invalid Git index")
  const version = bytes.readUInt32BE(4)
  if (![2, 3, 4].includes(version)) throw new Error(`Unsupported Git index version ${version}`)
  const expected = bytes.subarray(-20)
  if (expected.some((byte) => byte !== 0) && !createHash("sha1").update(bytes.subarray(0, -20)).digest().equals(expected))
    throw new Error("Git index checksum mismatch")
  const entries = new Map<string, Entry>()
  let cursor = 12
  let previous: Buffer = Buffer.alloc(0)
  for (let i = 0; i < bytes.readUInt32BE(8); i++) {
    const start = cursor
    if (cursor + 62 > bytes.length - 20) throw new Error("Truncated Git index entry")
    const mode = bytes.readUInt32BE(cursor + 24).toString(8).padStart(6, "0")
    const oid = bytes.toString("hex", cursor + 40, cursor + 60)
    const flags = bytes.readUInt16BE(cursor + 60)
    if (flags & 0x3000) throw new Error("Snapshot seed has unresolved index conflicts")
    cursor += flags & 0x4000 ? 64 : 62
    if (version === 4) {
      let strip = bytes[cursor] & 0x7f
      while (bytes[cursor++] & 0x80) {
        if (cursor >= bytes.length - 20) throw new Error("Truncated Git index path prefix")
        strip = (strip + 1) * 128 + (bytes[cursor] & 0x7f)
      }
      if (strip > previous.length) throw new Error("Invalid Git index path prefix")
      previous = previous.subarray(0, previous.length - strip)
    }
    const end = bytes.indexOf(0, cursor)
    if (end < cursor || end >= bytes.length - 20) throw new Error("Truncated Git index path")
    const name = version === 4 ? Buffer.concat([previous, bytes.subarray(cursor, end)]) : bytes.subarray(cursor, end)
    const file = name.toString("utf8")
    if (!Buffer.from(file).equals(name)) throw new Error("Non-UTF-8 Git paths are not supported")
    entries.set(file, { path: file, oid, mode })
    previous = name
    cursor = version === 4 ? end + 1 : start + Math.ceil((end + 1 - start) / 8) * 8
  }
  while (cursor < bytes.length - 20) {
    if (cursor + 8 > bytes.length - 20) throw new Error("Truncated Git index extension")
    const signature = bytes.toString("ascii", cursor, cursor + 4)
    if (/^[a-z]/.test(signature)) throw new Error(`Unsupported mandatory Git index extension ${signature}`)
    cursor += 8 + bytes.readUInt32BE(cursor + 4)
  }
  if (cursor !== bytes.length - 20) throw new Error("Invalid Git index extension size")
  return entries
}

/** A normal v2 Git index, with no machine-specific stat cache or extensions. */
export function writeIndex(entries: ReadonlyMap<string, Entry>): Buffer {
  const header = Buffer.alloc(12)
  header.write("DIRC")
  header.writeUInt32BE(2, 4)
  header.writeUInt32BE(entries.size, 8)
  const chunks = [header]
  for (const entry of [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    const name = Buffer.from(entry.path)
    const bytes = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8)
    bytes.writeUInt32BE(parseInt(entry.mode, 8), 24)
    Buffer.from(entry.oid, "hex").copy(bytes, 40)
    bytes.writeUInt16BE(Math.min(name.length, 0xfff), 60)
    name.copy(bytes, 62)
    chunks.push(bytes)
  }
  const content = Buffer.concat(chunks)
  return Buffer.concat([content, createHash("sha1").update(content).digest()])
}
