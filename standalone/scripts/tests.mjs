import { readdir } from "node:fs/promises"
import path from "node:path"

/** Include nested integration suites without traversing downloaded build caches. */
export async function testFiles(directory) {
  async function visit(folder) {
    const entries = await readdir(path.join(directory, folder), { withFileTypes: true })
    return (await Promise.all(entries.map(async (entry) => {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") return []
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) return visit(file)
      return /\.test\.(?:mjs|ts)$/.test(entry.name) ? [file] : []
    }))).flat()
  }
  return (await Promise.all(["test", "filesystem", "git", "pty", "persistent-pty", "tui", "web"].map(visit))).flat().sort()
}
