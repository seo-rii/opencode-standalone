import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))

/** Build-time esbuild is absent from the generated, builtins-only image proof. */
export async function bundleImageProof(destination) {
  await build({ entryPoints: [join(directory, "proof.mjs")], outfile: destination, bundle: true, platform: "node", format: "esm", target: "node26", legalComments: "inline", logLevel: "warning" })
  return destination
}
