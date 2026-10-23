import { build } from "esbuild"
import { isBuiltin } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("../tui/clipboard/", import.meta.url))
const names = new Map([["macos", "createMacOSNativeClipboard"], ["windows", "createWindowsNativeClipboard"]])
const prefix = "opencode:clipboard-"

/** Embed the complete native-worker program, never a neighbouring worker file. */
export async function getClipboardWorkerSource(platform) {
  if (!names.has(platform)) throw new Error(`Unknown clipboard worker: ${platform}`)
  const engine = join(directory, `${platform}-worker.mjs`)
  const result = await build({
    stdin: { contents: `import { serveNativeClipboardWorker } from ${JSON.stringify(join(directory, "worker-entry.mjs"))}; import { ${names.get(platform)} } from ${JSON.stringify(engine)}; serveNativeClipboardWorker(${names.get(platform)});`, resolveDir: directory, sourcefile: `${platform}-clipboard-entry.mjs` },
    bundle: true, platform: "node", target: "node26", format: "cjs", write: false,
    minify: true, keepNames: true, legalComments: "none", metafile: true, logLevel: "silent",
    // FFI engines use createRequire only for Node's builtin FFI module. Their
    // import.meta.url has no disk identity inside the embedded eval worker.
    define: { "import.meta.url": JSON.stringify("file:///opencode-standalone-clipboard-worker.cjs") },
  })
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) if (imported.path !== "node:ffi" && !isBuiltin(imported.path)) throw new Error(`External clipboard worker dependency: ${imported.path}`)
  }
  return result.outputFiles[0].text
}

/** Shared by actual CLI builds and isolated copied-single-file proofs. */
export function clipboardWorkers() {
  const cache = new Map()
  return {
    name: "standalone-clipboard-workers",
    setup(bundle) {
      bundle.onResolve({ filter: /^opencode:clipboard-(macos|windows)-worker$/ }, (args) => ({ path: args.path, namespace: "standalone-clipboard-worker" }))
      bundle.onLoad({ filter: /.*/, namespace: "standalone-clipboard-worker" }, async (args) => {
        const platform = args.path.slice(prefix.length, -"-worker".length)
        if (!cache.has(platform)) cache.set(platform, getClipboardWorkerSource(platform))
        return { contents: `export default ${JSON.stringify(await cache.get(platform))}`, loader: "js", resolveDir: directory }
      })
    },
  }
}
