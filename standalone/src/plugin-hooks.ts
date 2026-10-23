import { registerHooks } from "node:module"
import { modules } from "virtual:standalone-plugin-modules"

// User plugins share the host's bundled functions, schemas and service tags.
const prefix = "opencode-standalone:plugin/"
const sources = new Map<string, string>()
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (modules.has(specifier)) return { url: prefix + specifier, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (!url.startsWith(prefix)) return nextLoad(url, context)
    const specifier = url.slice(prefix.length)
    const namespace = modules.get(specifier)
    if (!namespace) return nextLoad(url, context)
    if (!sources.has(specifier)) {
      Object.assign(globalThis, { [Symbol.for("opencode.standalone.plugin-modules")]: modules })
      const source = `const namespace = globalThis[Symbol.for("opencode.standalone.plugin-modules")].get(${JSON.stringify(specifier)});\n`
      const exports = Object.keys(namespace).map((name, index) => {
        const child = [...modules].find(([target, value]) => target !== specifier && value === namespace[name])
        if (child) return `export * as ${JSON.stringify(name)} from ${JSON.stringify(prefix + child[0])};`
        return `const value${index} = namespace[${JSON.stringify(name)}]; export { value${index} as ${JSON.stringify(name)} };`
      }).join("\n")
      sources.set(specifier, source + exports)
    }
    return { format: "module", source: sources.get(specifier), shortCircuit: true }
  },
})
