import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

/** Keep the original TUI logic while replacing its remaining Bun-only APIs. */
export function tuiRuntime() {
  const sounds = "\0opencode-standalone-tui-sounds"
  const watcher = fileURLToPath(new URL("../tui/config-watch.mjs", import.meta.url))
  return {
    name: "opencode-standalone-tui-runtime",
    enforce: "pre",
    resolveId(id) {
      if (id === "#attention-sounds" || id === "virtual:standalone-tui-sounds") return sounds
      if (id === "opencode:tui-config-watch") return watcher
    },
    async load(id) {
      if (id !== sounds) return
      const files = {
        defaultSoundPath: "bip-bop-01.mp3", questionSoundPath: "bip-bop-03.mp3",
        permissionSoundPath: "staplebops-06.mp3", errorSoundPath: "nope-03.mp3", subagentDoneSoundPath: "yup-01.mp3",
      }
      const entries = await Promise.all(Object.entries(files).map(async ([name, file]) => {
        const key = `opencode:audio/${file}`
        const data = await readFile(fileURLToPath(new URL(`../../packages/ui/src/assets/audio/${file}`, import.meta.url)))
        return { name, key, encoded: data.toString("base64") }
      }))
      return `import { readFile } from "node:fs/promises";\n` +
        entries.map(({ name, key }) => `export const ${name} = ${JSON.stringify(key)};`).join("\n") +
        `\nconst sounds = new Map(${JSON.stringify(entries.map(({ key, encoded }) => [key, encoded]))});\n` +
        `export function readBuiltinSound(file) {\n  const encoded = sounds.get(file);\n  return encoded === undefined ? readFile(file) : Promise.resolve(Buffer.from(encoded, "base64"));\n}\n`
    },
    transform(code, id) {
      const file = id.replaceAll("\\", "/")
      const watcherImports = [
        ["/packages/tui/src/config/index.tsx", 'import { watch } from "fs"', 'import { watch } from "opencode:tui-config-watch"'],
        ["/packages/tui/src/model-preference.ts", 'import { watch } from "node:fs"', 'import { watch } from "opencode:tui-config-watch"'],
        ["/packages/tui/src/context/storage.tsx", 'import { mkdirSync, readFileSync, watch } from "fs"', 'import { mkdirSync, readFileSync } from "fs"\nimport { watch } from "opencode:tui-config-watch"'],
        ["/packages/tui/src/plugin/watch.ts", 'import { existsSync, watch } from "fs"', 'import { existsSync } from "fs"\nimport { watch } from "opencode:tui-config-watch"'],
      ]
      const watchImport = watcherImports.find(([suffix]) => file.endsWith(suffix))
      if (watchImport) {
        const [, before, after] = watchImport
        if (code.split(before).length !== 2) throw new Error(`Upstream TUI config watcher no longer matches: ${file}`)
        return code.replace(before, after)
      }
      if (file.endsWith("/packages/tui/src/component/prompt/local-attachment.ts")) {
        const before = '  const source = Bun.file(file)\n  if (!(await source.exists())) throw new Error("Attachment does not exist")'
        if (!code.includes(before)) throw new Error(`Upstream attachment adapter no longer matches: ${file}`)
        return 'import { openAsBlob } from "node:fs"\n' + code.replace(before, "  const source = await openAsBlob(file)")
      }
      if (file.endsWith("/packages/tui/src/component/migration-overlay.tsx")) {
        if (code.split("Bun.sleep(").length !== 3) throw new Error(`Upstream migration delays no longer match: ${file}`)
        return 'import { setTimeout } from "node:timers/promises"\n' + code.replaceAll("Bun.sleep(", "setTimeout(")
      }
      if (file.endsWith("/packages/tui/src/audio.ts")) {
        const before = "  const task = readFile(file)"
        if (code.split(before).length !== 2) throw new Error(`Upstream TUI sound loader no longer matches: ${file}`)
        return 'import { readBuiltinSound } from "virtual:standalone-tui-sounds"\n' + code.replace(before, "  const task = readBuiltinSound(file)")
      }
      if (file.endsWith("/packages/tui/src/mini/footer.ts")) {
        const before = "    ).catch(() => {\n      if (!this.isGone) {"
        if (code.split(before).length !== 2) throw new Error(`Upstream mini renderer failure handler no longer matches: ${file}`)
        return code.replace(before, '    ).catch((error) => {\n      process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error) + "\\n")\n      process.exitCode = 1\n      if (!this.isGone) {')
      }
    },
  }
}
