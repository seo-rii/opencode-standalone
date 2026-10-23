import { Worker } from "node:worker_threads"
import { parserWorkerSource, parserAssetPaths, defaultParsers } from "opencode:tui-parser-data"

const prefix = "opencode:opentui/"
let workerURL

export function embeddedParserAsset(relativePath) {
  if (!parserAssetPaths.includes(relativePath)) throw new Error(`Unknown embedded OpenTUI parser asset: ${relativePath}`)
  return prefix + relativePath
}

export function embeddedParserWorker() {
  workerURL ??= `data:text/javascript;base64,${Buffer.from(parserWorkerSource).toString("base64")}`
  return workerURL
}

export function embeddedTreeSitterWasm() {
  return prefix + "tree-sitter.wasm"
}

/** The raw Node worker is useful for protocol consumers; the published client keeps its own shim. */
export function createParserWorker(options = {}) {
  return new Worker(new URL(embeddedParserWorker()), options)
}

export function getEmbeddedParsers() {
  return defaultParsers.map((parser) => ({
    ...parser,
    wasm: embeddedParserAsset(parser.wasm),
    queries: {
      highlights: parser.queries.highlights.map(embeddedParserAsset),
      ...(parser.queries.injections ? { injections: parser.queries.injections.map(embeddedParserAsset) } : {}),
    },
  }))
}
