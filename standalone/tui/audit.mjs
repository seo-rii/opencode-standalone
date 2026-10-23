import { readFile, readdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const root = process.argv[2] ? resolve(process.argv[2]) : dirname(require.resolve("@opentui/core"))
const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
const files = await readdir(root)
const sources = new Map()
for (const name of files.filter((name) => /node.*\.js\.map$/.test(name))) {
  const map = JSON.parse(await readFile(resolve(root, name), "utf8"))
  for (const [index, path] of map.sources.entries()) sources.set(path, map.sourcesContent[index])
}
const abi = sources.get("../src/native-abi.generated.ts")
const ffi = sources.get("../src/platform/ffi.ts")
const zig = sources.get("../src/zig.ts")
if (!abi || !ffi || !zig) throw new Error("OpenTUI source map layout changed; inspect this version before accepting the audit.")
const symbolBlock = abi.slice(abi.indexOf("export const nativeSymbols = {"), abi.indexOf("export const nativeCallbacks = {"))
const symbols = [...symbolBlock.matchAll(/^  ([\w]+):/gm)].map((match) => match[1])
const report = {
  package: metadata.name,
  version: metadata.version,
  node: metadata.engines.node,
  nativePackages: Object.keys(metadata.optionalDependencies).filter((name) => name.startsWith("@opentui/core-")),
  generatedAbiSymbolCount: symbols.length,
  generatedAbiGroups: Object.fromEntries(["scene", "context", "session", "text", "edit", "unicode"].map((group) => [group, symbols.filter((name) => name.includes(`_${group}_`)).length])),
  hasNodeFfiLoader: ffi.includes('"node:ffi"'),
  hasFilesystemNativeLibraryCheck: zig.includes("existsSync(targetLibPath)"),
  hasNativeDlopen: zig.includes("dlopen(resolvedLibPath"),
  wasmFilesAtPackageRoot: files.filter((name) => name.endsWith(".wasm")),
  note: "Parser WASM assets are not an OpenTUI renderer backend. This audit does not claim a full WASM renderer exists.",
}
console.log(JSON.stringify(report, null, 2))
if (metadata.version !== "0.6.6" || !report.hasNodeFfiLoader || !report.hasNativeDlopen) {
  throw new Error("OpenTUI baseline changed; refresh the portability assessment.")
}

