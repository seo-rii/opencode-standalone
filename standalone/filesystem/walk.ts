import { readFile, readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import ignore, { type Ignore } from "ignore"
import { Minimatch } from "minimatch"
import { gitIgnoreSources } from "./git-ignore.ts"

export type WalkInput = {
  cwd: string
  pattern?: string
  exclude?: readonly string[]
  hidden?: boolean
  follow?: boolean
  signal?: AbortSignal
}

type Rule = { directory: string; matcher: Ignore }
type Rules = { git: boolean; groups: readonly (readonly Rule[])[] }

/** Enumerate regular files using the subset of ripgrep's traversal contract used by core. */
export async function* walk(input: WalkInput): AsyncGenerator<string> {
  const root = path.resolve(input.cwd)
  const positive = input.pattern && !input.pattern.startsWith("!") ? glob(input.pattern) : undefined
  const negative = [
    ...(input.exclude ?? []),
    ...(input.pattern?.startsWith("!") ? [input.pattern.slice(1)] : []),
  ].map(glob)
  const excluded = (relative: string, directory: boolean) =>
    negative.some((pattern) => pattern.match(relative) || (directory && pattern.match(`${relative}/`)))
  const parents: string[] = []
  for (let directory = root; ; directory = path.dirname(directory)) {
    parents.unshift(directory)
    if (path.dirname(directory) === directory) break
  }
  let inherited: Rules = { git: false, groups: [[], [], []] }
  for (const directory of parents.slice(0, -1)) {
    input.signal?.throwIfAborted()
    inherited = await rules(directory, inherited, root)
  }

  const visit = async function* (
    directory: string,
    inherited: Rules,
    ancestors: ReadonlySet<string>,
  ): AsyncGenerator<string> {
    input.signal?.throwIfAborted()
    const resolved = await realpath(directory).catch(() => undefined)
    if (!resolved || ancestors.has(resolved)) return
    const visited = new Set([...ancestors, resolved])
    const current = await rules(directory, inherited, root)
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
      if (inaccessible(cause)) return []
      throw cause
    })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      input.signal?.throwIfAborted()
      if (entry.name === ".git") continue
      if (!input.hidden && entry.name.startsWith(".")) continue
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      if (entry.isSymbolicLink() && !input.follow) continue
      const info = entry.isSymbolicLink() ? await stat(absolute).catch(() => undefined) : entry
      if (!info || (!info.isDirectory() && !info.isFile())) continue
      if (excluded(relative, info.isDirectory())) continue
      // A positive --glob overrides ignore files, including ignored parent directories.
      if (!positive && ignored(absolute, info.isDirectory(), current)) continue
      if (info.isDirectory()) {
        yield* visit(absolute, current, visited)
        continue
      }
      if (!positive || positive.match(relative)) yield relative
    }
  }
  yield* visit(root, inherited, new Set())
}

function glob(value: string) {
  const pattern = value.replace(/^\.\//, "").replace(/^\//, "")
  return new Minimatch(pattern, {
    dot: true,
    matchBase: !pattern.includes("/"),
    nonegate: true,
    nocomment: true,
    noext: true,
  })
}

async function rules(directory: string, inherited: Rules, cwd: string): Promise<Rules> {
  const repository = await gitIgnoreSources(directory, cwd)
  const git = inherited.git || repository !== undefined
  const files = [git ? ".gitignore" : undefined, ".ignore", ".rgignore"]
  const groups = await Promise.all(
    files.map(async (file, index) => {
      const previous =
        index === 0 && repository !== undefined
          ? repository.map((source) => ({
              directory: source.directory,
              matcher: ignore({ ignorecase: false }).add(source.content),
            }))
          : (inherited.groups[index] ?? [])
      if (!file) return previous
      const content = await readFile(path.join(directory, file), "utf8").catch((cause: NodeJS.ErrnoException) => {
        if (inaccessible(cause)) return undefined
        throw cause
      })
      if (!content) return previous
      return [...previous, { directory, matcher: ignore({ ignorecase: false }).add(content) }]
    }),
  )
  return { git, groups }
}

function ignored(file: string, directory: boolean, rules: Rules) {
  let result = false
  // .rgignore overrides .ignore, which overrides Git ignore rules.
  for (const group of rules.groups) {
    for (const rule of group) {
      const relative = path.relative(rule.directory, file).split(path.sep).join("/")
      const match = rule.matcher.test(relative + (directory ? "/" : ""))
      if (match.ignored) result = true
      if (match.unignored) result = false
    }
  }
  return result
}

export function inaccessible(cause: unknown) {
  return (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(cause.code)
  )
}
