import { readFile, writeFile, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire, isBuiltin } from "node:module"
import { brotliCompressSync, brotliDecompressSync } from "node:zlib"
import { createHash } from "node:crypto"
import { build, transformWithEsbuild } from "vite"
import solid from "vite-plugin-solid"
import { notices } from "./notices.mjs"
import { packArtifact } from "./pack.mjs"
import { pluginModules } from "./plugin-modules.mjs"
import { tuiRuntime } from "./tui-runtime.mjs"
import { standaloneTui } from "./tui-backend.mjs"

await import("./prepare.mjs")
const root = fileURLToPath(new URL("../../", import.meta.url))
const directory = path.join(root, "standalone")
// Keep the last verified artifact available while validating the full TUI.
const tuiPreview = process.argv.includes("--tui-preview")
const fromTuiPreview = process.argv.includes("--from-tui-preview")
const repack = process.argv.includes("--repack")
if (fromTuiPreview && !repack) throw new Error("--from-tui-preview requires --repack to explicitly select the compiled preview cache")
const tuiModule = "opencode-standalone:tui"
const require = createRequire(import.meta.url)
const source = JSON.parse(await readFile(path.join(directory, "UPSTREAM.json"), "utf8"))
const upstream = source.commit
const assets = new Map()
const embedded = async (specifier) => {
  if (assets.has(specifier)) return assets.get(specifier)
  const bytes = await readFile(require.resolve(specifier))
  const encoded = brotliCompressSync(bytes).toString("base64")
  const info = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), encoded }
  assets.set(specifier, info)
  return info
}
const sourceBytes = async (specifier) => {
  const value = await embedded(specifier)
  return `require("node:zlib").brotliDecompressSync(Buffer.from(${JSON.stringify(value.encoded)}, "base64"))`
}

function replace(code, before, after, file) {
  if (!code.includes(before)) throw new Error(`Upstream patch no longer matches ${file}: ${before}`)
  return code.replaceAll(before, after)
}

async function hostClipboardFingerprint() {
  const files = [
    "tui/clipboard.mjs", "tui/clipboard/x11.mjs", "tui/clipboard/wayland.mjs", "tui/clipboard/wayland-io.mjs",
    "tui/clipboard/macos.mjs", "tui/clipboard/macos-worker.mjs", "tui/clipboard/windows.mjs", "tui/clipboard/windows-worker.mjs",
    "tui/clipboard/image.mjs", "tui/clipboard/native-worker.mjs", "tui/clipboard/worker-entry.mjs",
    "scripts/clipboard-workers.mjs", "scripts/tui-backend.mjs",
  ]
  const hashes = await Promise.all(files.map(async (file) => [file, createHash("sha256").update(await readFile(path.join(directory, file))).digest("hex")]))
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex")
}

const aliases = new Map([
  ["packages/cli/src/commands/handlers/uninstall.ts", "standalone/src/uninstall.ts"],
  ["packages/cli/src/services/updater.ts", "standalone/src/updater.ts"],
  ["packages/core/src/ripgrep.ts", "standalone/filesystem/ripgrep.ts"],
  ["packages/core/src/filesystem/watcher-binding.ts", "standalone/filesystem/watcher-binding.ts"],
  ["packages/core/src/git.ts", "standalone/git/index.ts"],
])
const modules = new Set()
const pluginRuntime = await pluginModules(root)
const virtual = "\0opencode-standalone:"
function standalonePlugin() {
  return {
    name: "opencode-standalone",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source === "virtual:standalone-plugin-modules") return virtual + "plugin-modules"
      if (source === "virtual:standalone-plugin-namespaces") return virtual + "plugin-namespaces"
      if (source === "virtual:standalone-persistent-pty-wasm") return virtual + "persistent-pty-wasm"
      if (source === "virtual:upstream-git") return virtual + "upstream-git"
      if (importer === virtual + "upstream-git" && source.startsWith(".")) {
        if (source === "./git.js") return virtual + "upstream-git"
        return this.resolve(source, path.join(root, "packages/core/src/git.ts"), { ...options, skipSelf: true })
      }
      if (source === "virtual:opencode-app-assets") return virtual + "web-assets"
      if (source === "#shell-parser-wasm") return virtual + "shell-wasm"
      if (source === "#photon-wasm") return virtual + "photon-path"
      if (source === "#persistent-pty-binary") return path.join(directory, "src/persistent-pty.ts")
      if (source === "#pty") return path.join(directory, "pty/index.ts")
      if (source === "#fff") return path.join(root, "packages/core/src/filesystem/fff.workerd.ts")
      if (source === "@parcel/watcher/wrapper.js" || source === "@parcel/watcher")
        return path.join(directory, "filesystem/watcher.ts")
      if (!importer || isBuiltin(source) || source.startsWith("\0")) return
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved) return
      const replacement = aliases.get(path.relative(root, resolved.id).replaceAll("\\", "/"))
      if (!replacement) return
      const destination = path.join(root, replacement)
      if (!(await stat(destination).catch(() => undefined)))
        throw new Error(`Standalone adapter is missing: ${replacement}`)
      return destination
    },
    async load(id) {
      if (id === virtual + "plugin-modules") return pluginRuntime.registry
      if (id === virtual + "plugin-namespaces") return pluginRuntime.namespaces
      if (id === virtual + "persistent-pty-wasm") return `export default ${await sourceBytes("ghostty-web/ghostty-vt.wasm")}`
      if (id === virtual + "upstream-git") {
        const file = path.join(root, "packages/core/src/git.ts")
        return (await transformWithEsbuild(await readFile(file, "utf8"), file, { loader: "ts", tsconfigRaw: "{}" })).code
      }
      if (id === virtual + "photon-path") return 'export default "/__opencode_standalone__/photon.wasm"'
      if (id === virtual + "shell-wasm") {
        const runtime = await sourceBytes("web-tree-sitter/tree-sitter.wasm")
        const bash = await sourceBytes("tree-sitter-bash/tree-sitter-bash.wasm")
        const powershell = await sourceBytes("tree-sitter-powershell/tree-sitter-powershell.wasm")
        return `export const shellParserWasm = { runtime: ${runtime}, bash: ${bash}, powershell: ${powershell} }`
      }
      if (id === virtual + "web-assets") {
        return 'export default () => globalThis[Symbol.for("opencode.standalone.web-archive")]()'
      }
      if (/\.(?:txt|md|sql)$/.test(id)) return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
    },
    async transform(code, id) {
      const file = id.replaceAll("\\", "/")
      if (file.endsWith("/packages/core/src/persistent-pty/daemon.ts")) {
        code = replace(code, '["daemon", "--runtime-dir", root, "--name", id]', '[...process.execArgv, path.resolve(process.argv[1]), "--standalone-persistent-pty-daemon", "daemon", "--runtime-dir", root, "--name", id]', file)
      }
      if (file.endsWith("/packages/core/src/shell/parse.ts")) {
        code = replace(code, "Parser.init({ locateFile: () => resolve(shellParserWasm.runtime) })", "Parser.init({ wasmBinary: shellParserWasm.runtime })", file)
        code = replace(code, "Language.load(resolve(shellParserWasm.bash))", "Language.load(shellParserWasm.bash)", file)
        code = replace(code, "Language.load(resolve(shellParserWasm.powershell))", "Language.load(shellParserWasm.powershell)", file)
      }
      if (file.endsWith("/photon-node/photon_rs.js")) {
        code = replace(code, "imports['__wbindgen_placeholder__'] = module.exports;", "const __wbindgen_placeholder__ = {};\nimports['__wbindgen_placeholder__'] = __wbindgen_placeholder__;", file)
        code = code.replaceAll(/module\.exports\.(__(?:wbg|wbindgen)_[a-zA-Z0-9_]+) = function/g, "__wbindgen_placeholder__.$1 = function")
        code = replace(code, "const bytes = require('fs').readFileSync(path);", `const bytes = ${await sourceBytes("@silvia-odwyer/photon-node/photon_rs_bg.wasm")};`, file)
      }
      if (file.includes("/packages/cli/src/")) {
        if (/Bun\.file\(([^)]+)\)\.text\(\)/.test(code)) {
          code = code.replaceAll(/Bun\.file\(([^)]+)\)\.text\(\)/g, 'readFile($1, "utf8")')
          if (!/import \{[^}]*\breadFile\b[^}]*\} from ["'](?:node:)?fs\/promises/.test(code))
            code = 'import { readFile } from "node:fs/promises"\n' + code
        }
        if (code.includes("Bun.stdin.stream()")) {
          code = code.replaceAll("Bun.stdin.stream()", "Readable.toWeb(process.stdin)")
          code = 'import { Readable } from "node:stream"\n' + code
        }
        if (code.includes("Bun.write(target, JSON.stringify(result.profile))")) {
          code = code.replaceAll("Bun.write(target, JSON.stringify(result.profile))", "writeFile(target, JSON.stringify(result.profile))")
          code = 'import { writeFile } from "node:fs/promises"\n' + code
        }
      }
      if (file.endsWith("/turndown/lib/turndown.es.js")) {
        code = replace(code, "    var domino = require('@mixmark-io/domino');", "", file)
        code = 'import domino from "@mixmark-io/domino"\n' + code
      }
      return code
    },
    generateBundle() {
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id)
        if (info.isExternal && !isBuiltin(id) && id !== tuiModule) throw new Error(`External runtime dependency: ${id}`)
        if (info.isIncluded) modules.add(id.replace(root + path.sep, ""))
      }
    },
  }
}

const banner = `const __filename = process.getBuiltinModule("node:path").resolve(process.argv[1]);
const __dirname = process.getBuiltinModule("node:path").dirname(__filename);
const __opencodeBundleURL = process.getBuiltinModule("node:url").pathToFileURL(__filename).href;
const require = process.getBuiltinModule("node:module").createRequire(__filename);`

async function bundle(entry) {
  const result = await build({
    configFile: false,
    root,
    logLevel: "warn",
    esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { target: "ESNext", useDefineForClassFields: true } }) },
    plugins: [standalonePlugin(), standaloneTui({ externalBackend: true }), tuiRuntime(), solid({ solid: { generate: "universal", moduleName: "@opentui/solid" } })],
    resolve: {
      conditions: ["node"],
      alias: [
        { find: /^solid-js\/store$/, replacement: "solid-js/store/dist/store.js" },
        { find: /^solid-js$/, replacement: "solid-js/dist/solid.js" },
        { find: /^ws$/, replacement: path.join(path.dirname(require.resolve("ws/package.json")), "wrapper.mjs") },
      ],
    },
    define: {
      OPENCODE_VERSION: JSON.stringify(source.distributionVersion),
      OPENCODE_CHANNEL: JSON.stringify("standalone"),
      OPENCODE_ARTIFACT: JSON.stringify("standalone-js"),
      OPENCODE_LIBC: "undefined",
      FFF_LIBC: "undefined",
      "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
      "import.meta.dirname": "__dirname",
      "import.meta.filename": "__filename",
      "import.meta.url": "__opencodeBundleURL",
    },
    ssr: { noExternal: true, resolve: { conditions: ["node"] } },
    build: {
      ssr: entry,
      target: "node26",
      write: false,
      minify: false,
      commonjsOptions: { transformMixedEsModules: true },
      rollupOptions: {
        external: (id) => isBuiltin(id) || id === tuiModule,
        output: { format: "esm", inlineDynamicImports: true, banner },
        onwarn(warning, warn) {
          if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message)
          if (warning.code === "CIRCULAR_DEPENDENCY") return
          warn(warning)
        },
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output)
  if (outputs.length !== 1 || outputs[0].type !== "chunk")
    throw new Error(`Expected one embedded module, got ${outputs.map((x) => x.fileName).join(", ")}`)
  return outputs[0].code
}

const cache = path.join(directory, tuiPreview ? ".cache/tui-integration/bundle" : ".cache/bundle")
const inputCache = fromTuiPreview ? path.join(directory, ".cache/tui-integration/bundle") : cache
// The published clipboard controller belongs to the application graph, while
// the native renderer alone is rebuilt by --repack. Never label an old cached
// application as supporting new host providers.
const hostClipboardSourceSha256 = await hostClipboardFingerprint()
if (repack) {
  const saved = JSON.parse(await readFile(path.join(inputCache, "graph.json"), "utf8"))
  if (!saved.tuiPayload) throw new Error("This cache predates the full TUI payload; compile it once without --repack")
  if (saved.hostClipboardSourceSha256 !== hostClipboardSourceSha256) throw new Error("Cached application has different host clipboard sources; rebuild without --repack")
  for (const name of saved.modules) modules.add(name)
  for (const [name, value] of Object.entries(saved.assets)) assets.set(name, value)
  console.log("Repacking previously compiled modules; source compilation was explicitly skipped.")
}
const app = repack ? await readFile(path.join(inputCache, "app.mjs"), "utf8") : await bundle(path.join(directory, "src/entry.ts"))
const pty = repack ? await readFile(path.join(inputCache, "pty.mjs"), "utf8") : await bundle(path.join(directory, "src/pty-entry.ts"))
const daemon = repack ? await readFile(path.join(inputCache, "daemon.mjs"), "utf8") : await bundle(path.join(directory, "src/persistent-pty-entry.ts"))
// The native factory's JS and WASM form an independent module inside the same
// file. Repacking can rebuild this boundary without recompiling the CLI graph.
const tui = await bundle(path.join(directory, "tui/backend/index.mjs"))
if (await hostClipboardFingerprint() !== hostClipboardSourceSha256) throw new Error("Host clipboard sources changed during compilation; rebuild from stable sources")
const minify = async (code) => (await transformWithEsbuild(code, "opencode-standalone.mjs", {
  loader: "js", target: "node26", minify: true, keepNames: true, legalComments: "none", tsconfigRaw: "{}",
})).code
const appCode = await minify(app)
const ptyCode = await minify(pty)
const daemonCode = await minify(daemon)
const tuiCode = await minify(tui)
const { factoryWasmBrotliBase64 } = await import("../tui/factory-wasm.mjs")
const tuiWasmCompressed = Buffer.from(factoryWasmBrotliBase64, "base64")
const tuiWasm = brotliDecompressSync(tuiWasmCompressed)
const terminalSources = JSON.parse(await readFile(path.join(directory, "tui/terminal/sources.json"), "utf8"))
const assetReport = Object.fromEntries([...assets].map(([name, { encoded: _encoded, ...value }]) => [name, value]))
await mkdir(cache, { recursive: true })
await writeFile(path.join(cache, "app.mjs"), app)
await writeFile(path.join(cache, "pty.mjs"), pty)
await writeFile(path.join(cache, "daemon.mjs"), daemon)
await writeFile(path.join(cache, "graph.json"), JSON.stringify({ modules: [...modules], assets: assetReport, tuiPayload: true, hostClipboardSourceSha256 }))
const web = await readFile(path.join(directory, ".cache/web/app.archive")).catch((error) => {
  if (error.code !== "ENOENT") throw error
})
const webLicenses = web ? await readFile(path.join(directory, ".cache/web/licenses.txt"), "utf8") : ""
const tuiLicenses = (await Promise.all(["LICENSES.txt", "yoga-LICENSE.txt", "renderer-runtime-LICENSES.txt", "parser/LICENSES.txt", "image/LICENSES.txt", "terminal/LICENSES.txt"].map((file) => readFile(path.join(directory, "tui", file), "utf8")))).join("\n")
const licenses = await notices(root, modules, assets.keys()) + "\n" + webLicenses + "\n" + tuiLicenses
const packed = packArtifact({
  name: "opencode-standalone", upstream, experimental: true, runtime: "Node.js >=26.4",
  embeddedWasm: true, browserAssets: !!web, interactiveTui: true, miniTui: true, embeddedTerminal: true, hostClipboard: true, fullParity: false,
}, {
  // A 16 MiB window can share parser resources across this 28 MB module.
  app: { bytes: appCode, quality: tuiPreview ? 4 : 11, window: 24 }, pty: { bytes: ptyCode }, daemon: { bytes: daemonCode }, licenses: { bytes: licenses },
  tui: { bytes: tuiCode, quality: 11 },
  web: { bytes: web ?? Buffer.from([2, 0, 0, 0, 123, 125]), quality: 6 },
})
const destination = path.join(directory, tuiPreview ? ".cache/tui-integration" : "dist")
await mkdir(destination, { recursive: true })
const output = path.join(destination, "opencode-standalone.js")
await writeFile(output, packed.bytes, { mode: 0o755 })
const report = {
  upstream,
  artifact: path.basename(output),
  bytes: packed.bytes.length,
  sha256: createHash("sha256").update(packed.bytes).digest("hex"),
  modules: [...modules].sort(),
  assets: assetReport,
  payloads: packed.records,
  compiledBytes: { app: Buffer.byteLength(app), minifiedApp: Buffer.byteLength(appCode) },
  compilation: { reused: repack, cache: path.relative(directory, inputCache), tuiPayloadRebuilt: true, hostClipboardSourceSha256 },
  tui: {
    factoryWasm: { bytes: tuiWasm.length, compressedBytes: tuiWasmCompressed.length, sha256: createHash("sha256").update(tuiWasm).digest("hex") },
    embeddedTerminal: terminalSources,
    hostClipboard: { platforms: { linux: ["x11", "wayland"], darwin: ["macos"], win32: ["windows"] }, nativeWorkerEmbedded: true },
  },
  pluginModules: pluginRuntime.specifiers,
  external: "Node.js built-in modules only",
}
await writeFile(path.join(destination, "build-report.json"), JSON.stringify(report, null, 2) + "\n")
await writeFile(path.join(destination, "THIRD_PARTY_NOTICES.txt"), licenses)
console.log(`Built ${output} (${report.bytes} bytes)`)
