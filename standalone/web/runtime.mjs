import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"

export const archiveMagic = "OCWEB02\n"
export const archiveFormat = "standalone-hybrid-brotli-v2"
export const maxRawGroupBytes = 32 * 1024 * 1024

/** Browser responses stay lazy: only the requested raw group is decompressed. */
export function decodeAssetArchive(input, options = {}) {
  const archive = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (archive.length < 12 || archive.subarray(0, 8).toString("ascii") !== archiveMagic)
    throw new Error("Invalid standalone web archive header")
  const bodyAt = 12 + archive.readUInt32LE(8)
  if (bodyAt > archive.length) throw new Error("Truncated standalone web archive index")
  const index = JSON.parse(archive.subarray(12, bodyAt).toString("utf8"))
  if (!index || !Array.isArray(index.groups) || !index.files || typeof index.files !== "object" || Array.isArray(index.files))
    throw new Error("Invalid standalone web archive index")
  const groups = index.groups.map((row) => {
    if (!Array.isArray(row) || row.length !== 4 || !row.every(Number.isSafeInteger))
      throw new Error("Invalid standalone web archive group")
    const [offset, stored, raw, mode] = row
    if (offset < 0 || stored < 0 || raw < 0 || (mode !== 0 && mode !== 1) || stored > archive.length - bodyAt - offset || (mode === 0 && raw > maxRawGroupBytes))
      throw new Error("Standalone web archive group exceeds its bounds")
    return { bytes: archive.subarray(bodyAt + offset, bodyAt + offset + stored), raw, mode }
  })
  const rawCache = boundedCache(options.rawCacheBytes ?? 48 * 1024 * 1024)
  const brotliCache = boundedCache(options.brotliCacheBytes ?? 8 * 1024 * 1024)
  const files = Object.create(null)
  const brotli = Object.create(null)
  for (const [path, row] of Object.entries(index.files)) {
    if (!Array.isArray(row) || row.length !== 3 || !row.every(Number.isSafeInteger))
      throw new Error("Invalid standalone web archive file")
    const [groupIndex, offset, length] = row
    const group = groups[groupIndex]
    if (!group || offset < 0 || length < 0 || length > group.raw - offset || (group.mode === 1 && (offset !== 0 || length !== group.raw)))
      throw new Error("Standalone web archive file exceeds its group")
    const raw = () => {
      const bytes = rawCache(groupIndex, () => {
        const restored = brotliDecompressSync(group.bytes, { maxOutputLength: Math.max(1, group.raw) })
        if (restored.length !== group.raw) throw new Error("Standalone web archive raw size differs")
        return restored
      })
      return bytes.subarray(offset, offset + length)
    }
    Object.defineProperty(files, path, {
      enumerable: true,
      get: () => isText(path) ? raw().toString("utf8") : raw(),
    })
    Object.defineProperty(brotli, path, {
      enumerable: true,
      get: () => group.mode === 1 ? group.bytes : brotliCache(row.join(":"), () => brotliCompressSync(raw(), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      })),
    })
  }
  return { files, brotli }
}

function boundedCache(limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid standalone web cache size")
  const entries = new Map()
  let size = 0
  return (key, load) => {
    if (entries.has(key)) {
      const bytes = entries.get(key)
      entries.delete(key)
      entries.set(key, bytes)
      return bytes
    }
    const bytes = load()
    if (bytes.length > limit) return bytes
    while (size + bytes.length > limit) {
      const oldest = entries.keys().next().value
      size -= entries.get(oldest).length
      entries.delete(oldest)
    }
    entries.set(key, bytes)
    size += bytes.length
    return bytes
  }
}

function isText(file) {
  return file === "_headers" || /\.(?:css|html|js|json|svg|txt|webmanifest|xml)$/.test(file)
}
