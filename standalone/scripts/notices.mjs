import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

export async function notices(root, modules, assets) {
  const directories = new Set([root])
  for (const id of modules) {
    const normalized = id.replaceAll("\0", "").replaceAll("\\", "/")
    const end = normalized.lastIndexOf("node_modules/")
    if (end < 0) continue
    const parts = normalized.slice(end + "node_modules/".length).split("/")
    const name = parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/")
    directories.add(path.resolve(root, normalized.slice(0, end), "node_modules", name))
  }
  for (const specifier of assets) {
    const parts = specifier.split("/")
    directories.add(path.join(root, "standalone/node_modules", ...parts.slice(0, parts[0].startsWith("@") ? 2 : 1)))
  }
  const entries = await Promise.all([...directories].sort().map(async (directory) => {
    const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
    const filenames = (await readdir(directory)).filter((name) => /^(?:licen[sc]e|copying|copyright|notice)(?:[.-]|$)/i.test(name))
    const text = await Promise.all(filenames.sort().map(async (name) => {
      const content = await readFile(path.join(directory, name), "utf8").catch((error) => {
        if (error.code === "EISDIR") return ""
        throw error
      })
      return content ? `${name}\n${content}` : ""
    }))
    return `${pkg.name ?? "OpenCode"}@${pkg.version}\nLicense: ${JSON.stringify(pkg.license ?? pkg.licenses ?? "See upstream distribution")}\n${text.join("\n")}`
  }))
  return "Third-party notices for embedded OpenCode standalone code and WASM.\n\n" + entries.join("\n\n----------------------------------------\n\n")
}
