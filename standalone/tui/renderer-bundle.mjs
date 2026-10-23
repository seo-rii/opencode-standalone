import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))

/** Bundle the real computational renderer; the result needs only Node. */
export async function bundleRenderer(destination) {
  const embedded = await readFile(join(directory, "renderer-wasm.mjs"), "utf8")
  const runtime = (await readFile(join(directory, "renderer.mjs"), "utf8")).replace('import { rendererWasmBase64 } from "./renderer-wasm.mjs"\n', "")
  const demo = (await readFile(join(directory, "renderer-demo.mjs"), "utf8")).replace('import { createComputationalRenderer } from "./renderer.mjs"\n', "")
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${embedded}\n${runtime}\n${demo}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const destination = resolve(process.argv[2] ?? join(directory, ".cache/opentui-renderer-demo.mjs"))
  await bundleRenderer(destination)
  console.log(destination)
}
