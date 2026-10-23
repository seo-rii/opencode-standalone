import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { minify } from "terser"

export const applicationMinifier = {
  name: "terser",
  version: createRequire(import.meta.url)("terser/package.json").version,
  options: {
    module: true,
    ecma: 2024,
    keep_fnames: true,
    keep_classnames: true,
    compress: { passes: 2, keep_fargs: true },
    mangle: true,
    format: { comments: false },
  },
}

// This pass costs several minutes on the complete application. Reuse only an
// exact source/options/tool match, and check the output hash after interruptions.
export async function minifyApplication(source, cache) {
  const key = hash(JSON.stringify(applicationMinifier) + "\0" + source)
  const receipt = await readFile(join(cache, "application.json"), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error
  })
  if (receipt) {
    const saved = JSON.parse(receipt)
    if (saved.key === key) {
      const code = await readFile(join(cache, "application.mjs"), "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error
      })
      if (code !== undefined && hash(code) === saved.sha256) return { code, reused: true, key, ...applicationMinifier }
    }
  }
  const result = await minify(source, applicationMinifier.options)
  if (typeof result.code !== "string") throw new Error("Application minifier did not return JavaScript")
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, "application.mjs"), result.code)
  await writeFile(join(cache, "application.json"), JSON.stringify({ key, sha256: hash(result.code) }) + "\n")
  return { code: result.code, reused: false, key, ...applicationMinifier }
}

function hash(value) { return createHash("sha256").update(value).digest("hex") }
