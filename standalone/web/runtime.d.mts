export const archiveMagic: string
export const archiveFormat: string
export const maxRawGroupBytes: number
export function decodeAssetArchive(bytes: Uint8Array, options?: {
  rawCacheBytes?: number
  brotliCacheBytes?: number
}): {
  files: Readonly<Record<string, string | Uint8Array>>
  brotli: Readonly<Record<string, Uint8Array>>
}
