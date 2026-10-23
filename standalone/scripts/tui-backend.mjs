import path from "node:path"
import { fileURLToPath } from "node:url"
import { adaptPublishedBackendSource, standaloneBackendPath } from "../tui/backend/package.mjs"
import { adaptPublishedParserSource, getParserRuntimeModules } from "../tui/parser/build.mjs"
import { adaptPublishedClipboardSource } from "../tui/clipboard.mjs"

const directory = fileURLToPath(new URL("../", import.meta.url))
const prefix = "\0opencode-standalone-tui:"

/** Share the checked published-source adapters with the full CLI's Vite build. */
export function standaloneTui({ externalBackend = false } = {}) {
  let parserModules
  return {
    name: "opencode-standalone-tui",
    enforce: "pre",
    resolveId(id) {
      if (id === "opencode:tui-backend") return externalBackend ? { id: "opencode-standalone:tui", external: true } : standaloneBackendPath
      if (id === "virtual:standalone-tui-factory-wasm") return path.join(directory, "tui/factory-wasm.mjs")
      if (id === "opencode:tui-clipboard") return path.join(directory, "tui/clipboard.mjs")
      if (id === "opencode:tui-parser" || id === "opencode:tui-parser-data") return prefix + id
    },
    async load(id) {
      if (!id.startsWith(prefix)) return
      parserModules ??= getParserRuntimeModules()
      const source = (await parserModules).get(id.slice(prefix.length))
      if (source === undefined) throw new Error(`Missing embedded TUI module: ${id}`)
      return source
    },
    transform(source, id) {
      if (!/\/chunk-node-(?:p43t2gam|2rg7pskw)\.js$/.test(id.replaceAll("\\", "/"))) return
      const backend = adaptPublishedBackendSource(id, source)
      if (backend === undefined) throw new Error(`Unexpected published TUI chunk: ${id}`)
      return adaptPublishedClipboardSource(id, adaptPublishedParserSource(id, backend))
    },
  }
}
