import { basename } from "node:path"

/** Compose this checked transform with the renderer's onLoad hook for these same chunks. */
export function adaptPublishedParserSource(filename, source) {
  if (basename(filename) === "chunk-node-p43t2gam.js") {
    let contents = replace(source,
      'return Promise.resolve(resolveAssetPath(`${CORE_ASSET_PREFIX}${relativePath}`, fallbackPath));',
      'return Promise.resolve(resolveAssetRootPath(`${CORE_ASSET_PREFIX}${relativePath}`) ?? embeddedParserAsset(relativePath));')
    contents = replace(contents,
      "return resolveAssetPath(PARSER_WORKER_ASSET_KEY, fallbackPath);",
      "return resolveAssetRootPath(PARSER_WORKER_ASSET_KEY) ?? embeddedParserWorker();")
    contents = replace(contents,
      "return Promise.resolve(resolveAssetPath(TREE_SITTER_WASM_ASSET_KEY, () => new URL(import.meta.resolve(TREE_SITTER_WASM_ASSET_KEY))));",
      "return Promise.resolve(resolveAssetRootPath(TREE_SITTER_WASM_ASSET_KEY) ?? embeddedTreeSitterWasm());")
    return 'import { embeddedParserAsset, embeddedParserWorker, embeddedTreeSitterWasm } from "opencode:tui-parser";\n' + contents
  }
  if (basename(filename) === "chunk-node-2rg7pskw.js") {
    let contents = replace(source,
      'resolveDefaultParserAsset(relativePath, new URL(`./${relativePath}`, import.meta.url))',
      "resolveDefaultParserAsset(relativePath)")
    contents = replace(contents,
      'resolveDefaultTreeSitterWorkerPath(new URL("./parser.worker.js", import.meta.url))',
      "resolveDefaultTreeSitterWorkerPath()")
    contents = replace(contents,
      "if (!process.env.OTUI_ASSET_ROOT && !existsSync(workerPath)) {",
      'if (!process.env.OTUI_ASSET_ROOT && !String(workerPath).startsWith("data:") && !existsSync(workerPath)) {')
    return replace(contents,
      "if (isUrl(path)) {",
      'if (isUrl(path) || path.startsWith("opencode:opentui/")) {')
  }
  return source
}

export function adaptPublishedParserWorker(source) {
  let contents = replace(source,
    "var require = createRequire(import.meta.url);",
    "var require = createRequire(process.execPath);")
  contents = replace(contents,
    'static async downloadOrLoad(source, cacheDir, cacheSubdir, fileExtension, useHashForCache = true, filetype) {',
    'static async downloadOrLoad(source, cacheDir, cacheSubdir, fileExtension, useHashForCache = true, filetype) {\n    const embedded = embeddedParserBytes(source);\n    if (embedded) return { content: embedded, filePath: source };')
  contents = replace(contents,
    'treeSitterWasmPath ?? resolveAssetPath("web-tree-sitter/tree-sitter.wasm", () => new URL(import.meta.resolve("web-tree-sitter/tree-sitter.wasm")))',
    'treeSitterWasmPath ?? "opencode:opentui/tree-sitter.wasm"')
  contents = replace(contents,
    "await Parser.init({\n        locateFile() {",
    "await Parser.init({\n        wasmBinary: embeddedParserBytes(treeWasm),\n        locateFile() {")
  contents = replace(contents,
    "const language = await Language.load(normalizedPath);",
    "const language = await Language.load(result.content ?? normalizedPath);")
  return 'import { embeddedParserBytes } from "opencode:tui-parser-worker-assets";\n' + contents
}

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Pinned OpenTUI parser seam did not match once: ${before}`)
  return source.replace(before, after)
}
