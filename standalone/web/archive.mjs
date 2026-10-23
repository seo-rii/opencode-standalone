import { readFile, readdir } from "node:fs/promises"
import { extname, join, relative, sep } from "node:path"
import { createHash } from "node:crypto"
import { brotliCompress, brotliDecompressSync, constants } from "node:zlib"
import { promisify } from "node:util"
import { archiveMagic, archiveFormat, maxRawGroupBytes } from "./runtime.mjs"

const compress = promisify(brotliCompress)
const rawExtensions = new Set([".js", ".ttf", ".css", ".svg", ".html", ".json", ".txt", ".xml", ".webmanifest"])

/** Share compression dictionaries without recompressing large HTTP responses. */
export async function archiveDirectory(directory, options = {}) {
  const paths = (await files(directory)).filter((path) => !path.endsWith(".map")).sort()
  if (!paths.includes("index.html") || !paths.includes("sw.js"))
    throw new Error("The browser build must contain index.html and its actual service worker")
  const groupBytes = options.groupBytes ?? maxRawGroupBytes
  if (!Number.isSafeInteger(groupBytes) || groupBytes < 1 || groupBytes > maxRawGroupBytes)
    throw new Error("Invalid standalone raw group size")
  const quality = 11
  const concurrency = 4
  const entries = new Array(paths.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (next < paths.length) {
      const position = next++
      const path = paths[position]
      const raw = await readFile(join(directory, path))
      entries[position] = { path, raw, sha256: createHash("sha256").update(raw).digest("hex") }
    }
  }))
  const unique = new Map()
  const groups = []
  const current = new Map()
  // Assign groups after reads finish, in sorted path order. I/O completion order
  // cannot change deduplication, group boundaries, indexes, or archive bytes.
  for (const entry of entries) {
    if (unique.has(entry.sha256)) continue
    const extension = extname(entry.path)
    const grouped = entry.raw.length <= groupBytes && (rawExtensions.has(extension) || entry.path === "_headers")
    let group = grouped ? current.get(extension) : undefined
    if (!group || group.rawBytes + entry.raw.length > groupBytes) {
      group = { mode: grouped ? 0 : 1, entries: [], rawBytes: 0, index: groups.length }
      groups.push(group)
      if (grouped) current.set(extension, group)
    }
    unique.set(entry.sha256, { group: group.index, offset: group.rawBytes, bytes: entry.raw.length })
    group.entries.push(entry)
    group.rawBytes += entry.raw.length
  }
  next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
    while (next < groups.length) {
      const group = groups[next++]
      const raw = Buffer.concat(group.entries.map((entry) => entry.raw))
      const previous = group.mode === 1 ? options.brotli?.[group.entries[0].path] : undefined
      const cached = group.mode === 0 && options.compressedGroups ? options.compressedGroups.get(createHash("sha256").update(raw).digest("hex")) : undefined
      group.compressed = cached && brotliDecompressSync(cached).equals(raw) ? Buffer.from(cached) : previous && brotliDecompressSync(previous).equals(raw) ? Buffer.from(previous) : await compress(raw, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: quality,
          [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          ...(group.mode === 0 ? { [constants.BROTLI_PARAM_LGWIN]: 24 } : {}),
        },
      })
      if (!brotliDecompressSync(group.compressed).equals(raw)) throw new Error("Archive compression round-trip failed")
    }
  }))
  const index = Object.create(null)
  const groupIndex = []
  let offset = 0
  for (const group of groups) {
    groupIndex.push([offset, group.compressed.length, group.rawBytes, group.mode])
    offset += group.compressed.length
  }
  for (const entry of entries) {
    const location = unique.get(entry.sha256)
    index[entry.path] = [location.group, location.offset, location.bytes]
  }
  const encodedIndex = Buffer.from(JSON.stringify({ groups: groupIndex, files: index }))
  const header = Buffer.alloc(12)
  header.write(archiveMagic, 0, "ascii")
  header.writeUInt32LE(encodedIndex.length, 8)
  return {
    bytes: Buffer.concat([header, encodedIndex, ...groups.map((group) => group.compressed)]),
    files: entries.map((entry) => {
      const location = unique.get(entry.sha256)
      const group = groups[location.group]
      return {
        path: entry.path, bytes: entry.raw.length, sha256: entry.sha256,
        group: location.group, groupOffset: location.offset,
        groupStoredBytes: group.compressed.length, compression: group.mode === 0 ? "group-brotli" : "brotli",
      }
    }),
    compression: {
      format: archiveFormat, brotliQuality: quality, concurrency,
      uniqueAssets: unique.size, duplicateAssets: entries.length - unique.size,
      groups: groups.length, rawGroups: groups.filter((group) => group.mode === 0).length,
      passthroughGroups: groups.filter((group) => group.mode === 1).length,
      maxRawGroupBytes: Math.max(0, ...groups.filter((group) => group.mode === 0).map((group) => group.rawBytes)),
      rawGroupLimitBytes: groupBytes,
    },
  }
}

async function files(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(root, path)
    return [relative(root, path).split(sep).join("/")]
  }))).flat()
}
