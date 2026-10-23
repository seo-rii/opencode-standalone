import { build } from "esbuild"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { standalonePackagePlugin } from "../backend/package.mjs"
import { adaptPublishedParserSource, standaloneParserPlugin } from "./build.mjs"

const directory = dirname(fileURLToPath(import.meta.url))

/** Bundle the unchanged published client together with both checked host adapters. */
export async function bundleParserClientProof(destination) {
  await mkdir(dirname(destination), { recursive: true })
  const result = await build({
    entryPoints: [join(directory, "client-proof.mjs")],
    outfile: destination,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    minify: true,
    keepNames: true,
    legalComments: "inline",
    banner: { js: `/*\n${await readFile(join(directory, "LICENSES.txt"), "utf8")}\n*/` },
    metafile: true,
    plugins: [
      {
        name: "opentui-parser-proof-factory",
        setup(bundle) {
          bundle.onResolve({ filter: /^virtual:standalone-tui-factory-wasm$/ }, () => ({ path: join(directory, "../factory-wasm.mjs") }))
        },
      },
      await standalonePackagePlugin({ transform: adaptPublishedParserSource }),
      await standaloneParserPlugin(),
    ],
  })
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (!isBuiltin(dependency.path)) throw new Error(`External published parser client dependency: ${dependency.path}`)
    }
  }
  const bytes = await readFile(destination)
  await writeFile(destination + ".json", JSON.stringify({
    package: "@opentui/core",
    version: "0.6.6",
    actualClient: true,
    outputBytes: bytes.length,
    outputSha256: createHash("sha256").update(bytes).digest("hex"),
  }, null, 2) + "\n")
  return destination
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(await bundleParserClientProof(resolve(process.argv[2] ?? join(directory, ".cache/parser-client-proof.mjs"))))
}
