import { lstat, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Git's low-priority excludes, resolved without running Git. */
export async function gitIgnoreSources(directory: string, cwd: string) {
  const marker = path.join(directory, ".git")
  const stat = await lstat(marker).catch(() => undefined)
  if (!stat) return undefined
  const pointer = stat.isDirectory() ? undefined : (await read(marker))?.match(/^gitdir:\s*(.+)\s*$/m)?.[1]
  const gitdir = stat.isDirectory() ? marker : pointer ? path.resolve(directory, pointer.trim()) : undefined
  const common = gitdir ? (await read(path.join(gitdir, "commondir")))?.trim() : undefined
  const commonDirectory = gitdir && common ? path.resolve(gitdir, common) : gitdir
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const global = process.env.GIT_CONFIG_GLOBAL
    ? [process.env.GIT_CONFIG_GLOBAL]
    : [path.join(xdg, "git/config"), path.join(os.homedir(), ".gitconfig")]
  const configs = [
    ...(/^(?:1|true|yes|on)$/i.test(process.env.GIT_CONFIG_NOSYSTEM ?? "")
      ? []
      : [process.env.GIT_CONFIG_SYSTEM || "/etc/gitconfig"]),
    ...global,
    ...(commonDirectory ? [path.join(commonDirectory, "config")] : []),
  ]
  let configured: string | undefined
  for (const config of configs) {
    const value = await excludesFile(config, new Set())
    if (value !== undefined) configured = value
  }
  const globalFile = configured === undefined ? path.join(xdg, "git/ignore") : expand(configured, cwd)
  const sources = await Promise.all(
    [globalFile, ...(commonDirectory ? [path.join(commonDirectory, "info/exclude")] : [])].map(async (file) => ({
      directory,
      content: await read(file),
    })),
  )
  return sources.filter((source): source is { directory: string; content: string } => source.content !== undefined)
}

async function excludesFile(file: string, parents: ReadonlySet<string>): Promise<string | undefined> {
  const absolute = path.resolve(file)
  if (parents.has(absolute) || parents.size >= 10) return undefined
  const content = await read(absolute)
  if (!content) return undefined
  const seen = new Set([...parents, absolute])
  let section = ""
  let result: string | undefined
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]/)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    const setting = line.match(/^\s*([\w-]+)\s*=\s*(.*)$/)
    if (!setting) continue
    const key = setting[1].toLowerCase()
    if (section === "core" && key === "excludesfile") result = value(setting[2])
    if (section === "include" && key === "path") {
      const included = await excludesFile(expand(value(setting[2]), path.dirname(absolute)), seen)
      if (included !== undefined) result = included
    }
  }
  return result
}

function expand(value: string, directory: string) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return path.resolve(directory, value)
}

function value(source: string) {
  let quoted = false
  let output = ""
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === "\\" && index + 1 < source.length) {
      const next = source[++index]
      output += next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next
      continue
    }
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && (character === "#" || character === ";")) break
    output += character
  }
  return output.trim()
}

async function read(file: string) {
  return readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"].includes(cause.code ?? "")) return undefined
    throw cause
  })
}
