import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))

/** Assemble the proof from checked-in sources; no compiler or packages needed. */
export async function bundleDemo(destination) {
  const embedded = await readFile(join(directory, "unicode-wasm.mjs"), "utf8")
  const runtime = (await readFile(join(directory, "unicode.mjs"), "utf8")).replace('import { wasmBase64 } from "./unicode-wasm.mjs"\n', "")
  const demo = (await readFile(join(directory, "demo.mjs"), "utf8")).replace('import { createUnicode } from "./unicode.mjs"\n', "")
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${embedded}\n${runtime}\n${demo}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const destination = resolve(process.argv[2] ?? join(directory, ".cache", "opentui-unicode-demo.mjs"))
  await bundleDemo(destination)
  console.log(destination)
}

