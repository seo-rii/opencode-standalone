import { createHash } from "node:crypto"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { brotliCompress, constants } from "node:zlib"
import { build } from "esbuild"
import { adaptPublishedParserWorker, adaptPublishedParserSource } from "./adapt.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const published = JSON.parse(await readFile(join(directory, "published-sources.json"), "utf8"))
const compress = promisify(brotliCompress)
let parserData

/** Add this plugin, then compose adaptPublishedParserSource with the renderer's checked source transform. */
export async function standaloneParserPlugin() {
  const modules = await getParserRuntimeModules()
  return {
    name: "opentui-standalone-parser",
    setup(bundle) {
      bundle.onResolve({ filter: /^opencode:tui-parser(?:-data)?$/ }, ({ path }) => ({ path, namespace: "opentui-parser" }))
      bundle.onLoad({ filter: /^opencode:tui-parser/, namespace: "opentui-parser" }, ({ path }) => ({ contents: modules.get(path), loader: "js" }))
    },
  }
}

export { adaptPublishedParserSource }

/** Rollup/Vite can resolve these IDs to virtual modules and apply the pure checked source adapter. */
export async function getParserRuntimeModules() {
  parserData ??= buildParserData()
  return new Map([
    ["opencode:tui-parser", await readFile(join(directory, "runtime.mjs"), "utf8")],
    ["opencode:tui-parser-data", (await parserData).source],
  ])
}

/** Produce a portable, independent real-worker protocol fixture with no renderer construction. */
export async function bundleParserProof(destination) {
  await mkdir(dirname(destination), { recursive: true })
  const result = await build({
    entryPoints: [join(directory, "proof.mjs")],
    outfile: destination,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    minify: true,
    keepNames: true,
    legalComments: "none",
    banner: { js: `/*\n${await readFile(join(directory, "LICENSES.txt"), "utf8")}\n*/` },
    metafile: true,
    plugins: [await standaloneParserPlugin()],
  })
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (!dependency.path.startsWith("node:")) throw new Error(`External parser runtime dependency: ${dependency.path}`)
    }
  }
  const data = await parserData
  await writeFile(destination + ".json", JSON.stringify({
    package: published.package,
    version: published.version,
    workerBytes: Buffer.byteLength(data.worker),
    parserAssets: data.manifest,
    outputBytes: (await readFile(destination)).length,
    outputSha256: hash(await readFile(destination)),
  }, null, 2) + "\n")
  return destination
}

async function buildParserData() {
  const root = dirname(fileURLToPath(import.meta.resolve("@opentui/core")))
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  if (manifest.version !== published.version) throw new Error(`Expected ${published.package} ${published.version}`)
  const files = new Map()
  for (const [filename, checksum] of Object.entries(published.files)) {
    const content = await readFile(join(root, filename))
    if (hash(content) !== checksum) throw new Error(`Published OpenTUI parser source checksum mismatch: ${filename}`)
    files.set(filename, content)
  }
  const treeSitterWasm = await readFile(fileURLToPath(import.meta.resolve("web-tree-sitter/tree-sitter.wasm")))
  if (hash(treeSitterWasm) !== published.treeSitter.wasmSha256) throw new Error("Pinned web-tree-sitter WASM checksum mismatch")
  const assets = [...files].filter(([name]) => name.startsWith("assets/"))
  assets.push(["tree-sitter.wasm", treeSitterWasm])
  const compressed = await Promise.all(assets.map(async ([name, content]) => {
    const stored = await compress(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
    return [name, { bytes: content.length, data: stored.toString("base64"), storedBytes: stored.length, sha256: hash(content) }]
  }))
  const result = await build({
    stdin: { contents: adaptPublishedParserWorker(files.get("parser.worker.js").toString("utf8")), resolveDir: root, loader: "js" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    minify: true,
    keepNames: true,
    legalComments: "none",
    write: false,
    plugins: [{
      name: "opentui-parser-worker-bytes",
      setup(bundle) {
        bundle.onResolve({ filter: /^opencode:tui-parser-worker-assets$/ }, () => ({ path: join(directory, "worker-assets.mjs") }))
        bundle.onResolve({ filter: /^opencode:tui-parser-assets$/ }, () => ({ path: "assets", namespace: "opentui-parser" }))
        bundle.onLoad({ filter: /^assets$/, namespace: "opentui-parser" }, () => ({
          contents: `export const parserAssets = ${JSON.stringify(Object.fromEntries(compressed.map(([name, asset]) => [name, { bytes: asset.bytes, data: asset.data }])))};`,
          loader: "js",
        }))
      },
    }],
  })
  const worker = result.outputFiles[0].text
  const clientSource = files.get("chunk-node-2rg7pskw.js").toString("utf8")
  const start = clientSource.indexOf("var defaultParserDescriptors = [\n")
  const end = clientSource.indexOf("var defaultParserAssetPaths = [\n", start)
  if (start === -1 || end === -1) throw new Error("Pinned default parser descriptor seam did not match")
  return {
    worker,
    source: `${clientSource.slice(start, end)}\nexport const defaultParsers = defaultParserDescriptors;\nexport const parserAssetPaths = ${JSON.stringify(assets.filter(([name]) => name !== "tree-sitter.wasm").map(([name]) => name))};\nexport const parserWorkerSource = ${JSON.stringify(worker)};\n`,
    manifest: Object.fromEntries(compressed.map(([name, asset]) => [name, { bytes: asset.bytes, storedBytes: asset.storedBytes, sha256: asset.sha256 }])),
  }
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(await bundleParserProof(resolve(process.argv[2] ?? join(directory, ".cache/parser-proof.mjs"))))
}
