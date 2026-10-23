import { readFile, readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { createHash } from "node:crypto"
import { brotliCompress, brotliDecompressSync, constants } from "node:zlib"
import { promisify } from "node:util"

const compress = promisify(brotliCompress)

/** The upstream AppArchive wire format, using only Node build-time APIs. */
export async function archiveDirectory(directory) {
  const paths = (await files(directory)).filter((path) => !path.endsWith(".map")).sort()
  if (!paths.includes("index.html") || !paths.includes("sw.js")) {
    throw new Error("The browser build must contain index.html and its actual service worker")
  }
  const quality = 11
  const concurrency = 4
  const entries = new Array(paths.length)
  const compressed = new Map()
  let next = 0
  // Limit active reads and Brotli jobs instead of scheduling every asset at
  // once. Keep results in path order so completion order cannot change bytes.
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (next < paths.length) {
      const position = next++
      const path = paths[position]
      const body = await readFile(join(directory, path))
      const sha256 = createHash("sha256").update(body).digest("hex")
      if (!compressed.has(sha256)) {
        compressed.set(sha256, compress(body, {
          params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: body.length },
        }).then((bytes) => {
          if (!brotliDecompressSync(bytes).equals(body)) throw new Error(`Archive round-trip failed: ${path}`)
          return bytes
        }))
      }
      entries[position] = { path, bytes: body.length, sha256, compressed: await compressed.get(sha256) }
    }
  }))
  const index = Object.create(null)
  const offsets = new Map()
  const payloads = []
  let offset = 0
  for (const entry of entries) {
    // The upstream decoder returns independent views. Equal assets can share
    // one payload while every original URL keeps its own index entry.
    if (!offsets.has(entry.sha256)) {
      offsets.set(entry.sha256, [offset, entry.compressed.length])
      offset += entry.compressed.length
      payloads.push(entry.compressed)
    }
    index[entry.path] = offsets.get(entry.sha256)
  }
  const encodedIndex = Buffer.from(JSON.stringify(index))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(encodedIndex.length)
  return {
    bytes: Buffer.concat([header, encodedIndex, ...payloads]),
    files: entries.map((entry) => ({ path: entry.path, bytes: entry.bytes, compressedBytes: entry.compressed.length, sha256: entry.sha256 })),
    compression: {
      brotliQuality: quality,
      concurrency,
      uniqueAssets: offsets.size,
      duplicateAssets: entries.length - offsets.size,
      deduplicatedBytes: entries.reduce((bytes, entry) => bytes + entry.compressed.length, 0) - offset,
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

