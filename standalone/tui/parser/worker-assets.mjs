import { brotliDecompressSync } from "node:zlib"
import { parserAssets } from "opencode:tui-parser-assets"

const decoded = new Map()

export function embeddedParserBytes(source) {
  if (!source.startsWith("opencode:opentui/")) return undefined
  const path = source.slice("opencode:opentui/".length)
  if (decoded.has(path)) return decoded.get(path)
  const asset = parserAssets[path]
  if (!asset) throw new Error(`Unknown embedded OpenTUI parser asset: ${path}`)
  const bytes = brotliDecompressSync(Buffer.from(asset.data, "base64"), { maxOutputLength: asset.bytes })
  if (bytes.length !== asset.bytes) throw new Error(`Invalid embedded OpenTUI parser asset length: ${path}`)
  decoded.set(path, bytes)
  return bytes
}
