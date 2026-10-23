import { build } from "esbuild"
import { mkdir, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { standalonePackagePlugin } from "./package.mjs"

const directory = dirname(fileURLToPath(import.meta.url))

/** Bundle the actual published classes and the embedded reactor into one Node module. */
export async function bundleBackend(destination = join(directory, "../.cache/backend/core.mjs"), options = {}) {
  await mkdir(dirname(destination), { recursive: true })
  const wasm = join(directory, "../factory-wasm.mjs")
  await stat(wasm)
  await build({
    entryPoints: [options.entry ?? join(directory, "entry.mjs")], outfile: destination, bundle: true, platform: "node", format: "esm", target: "node26",
    legalComments: "inline", keepNames: true, logLevel: "warning", external: ["bun:*"],
    plugins: [{ name: "opentui-factory-wasm", setup(build) { build.onResolve({ filter: /^virtual:standalone-tui-factory-wasm$/ }, () => ({ path: wasm })) } }, await standalonePackagePlugin(options), ...(options.plugins ?? [])],
  })
  return destination
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await bundleBackend())
