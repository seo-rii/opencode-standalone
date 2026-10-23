import { readFile, readdir } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)

// Public barrels expose their children without eagerly importing opt-in modules
// such as effect/schema/SchemaJITCompiler/enable.
export async function pluginModules(root) {
  const effect = path.dirname(require.resolve("effect/package.json"))
  const manifest = JSON.parse(await readFile(path.join(effect, "package.json"), "utf8"))
  const specifiers = new Set()
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (typeof target !== "string" || !target.endsWith("/index.js")) continue
    const specifier = key === "." ? "effect" : "effect/" + key.slice(2)
    specifiers.add(specifier)
    const source = await readFile(path.join(effect, target), "utf8")
    for (const match of source.matchAll(/export \* as (\w+) from ["']([^"']+)["']/g)) {
      const child = `${specifier}/${match[1]}`
      try {
        require.resolve(child)
        specifiers.add(child)
      } catch (cause) {
        if (cause.code !== "MODULE_NOT_FOUND" && cause.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw cause
      }
    }
  }
  specifiers.add("@opencode/plugin")
  specifiers.add("@opencode/plugin/effect")
  const plugin = path.join(root, "packages/plugin/src")
  for (const file of await readdir(plugin, { recursive: true })) {
    const relative = file.replaceAll(path.sep, "/")
    if (!relative.endsWith(".ts") || relative.endsWith(".d.ts")) continue
    if (relative.startsWith("runtime") || relative.startsWith("source.") || relative.startsWith("tui/")) continue
    if (relative.includes("/internal/") || relative.startsWith("internal/")) continue
    specifiers.add("@opencode/plugin/" + relative.slice(0, -3))
  }
  const values = [...specifiers].sort()
  return {
    specifiers: values,
    namespaces: values.map((specifier, index) => `export * as module${index} from ${JSON.stringify(specifier)}`).join("\n"),
    registry: `import { ${values.map((_, index) => `module${index}`).join(", ")} } from "virtual:standalone-plugin-namespaces";
export const modules = new Map([${values.map((specifier, index) => `[${JSON.stringify(specifier)}, module${index}]`).join(",\n")}]);`,
  }
}
