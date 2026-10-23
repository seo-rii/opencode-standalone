import path from "node:path"
import { fileURLToPath } from "node:url"
import { adaptPublishedBackendSource, standaloneBackendPath } from "../tui/backend/package.mjs"
import { adaptPublishedParserSource, getParserRuntimeModules } from "../tui/parser/build.mjs"
import { adaptPublishedClipboardSource } from "../tui/clipboard.mjs"
import { getClipboardWorkerSource } from "./clipboard-workers.mjs"

const directory = fileURLToPath(new URL("../", import.meta.url))
const prefix = "\0opencode-standalone-tui:"

/** Share the checked published-source adapters with the full CLI's Vite build. */
export function standaloneTui({ externalBackend = false } = {}) {
  let parserModules
  const clipboardWorkers = new Map()
  return {
    name: "opencode-standalone-tui",
    enforce: "pre",
    resolveId(id) {
      if (id === "opencode:tui-backend") return externalBackend ? { id: "opencode-standalone:tui", external: true } : standaloneBackendPath
      if (id === "virtual:standalone-tui-factory-wasm") return path.join(directory, "tui/factory-wasm.mjs")
      if (id === "opencode:tui-clipboard") return path.join(directory, "tui/clipboard.mjs")
      if (/^opencode:clipboard-(macos|windows)-worker$/.test(id)) return prefix + id
      if (id === "opencode:tui-parser" || id === "opencode:tui-parser-data") return prefix + id
    },
    async load(id) {
      if (!id.startsWith(prefix)) return
      const clipboard = /^opencode:clipboard-(macos|windows)-worker$/.exec(id.slice(prefix.length))
      if (clipboard) {
        if (!clipboardWorkers.has(clipboard[1])) clipboardWorkers.set(clipboard[1], getClipboardWorkerSource(clipboard[1]))
        return `export default ${JSON.stringify(await clipboardWorkers.get(clipboard[1]))}`
      }
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
