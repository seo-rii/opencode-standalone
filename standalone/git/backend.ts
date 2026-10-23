import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import git from "isomorphic-git"
import http from "isomorphic-git/http/node"
import { diffLines, formatPatch, structuredPatch } from "diff"
import { readIndex, writeIndex } from "./git-index.ts"
import type { Entry } from "./git-index.ts"

export type Repository = { worktree: string; gitDirectory: string; commonDirectory: string }
export type CaptureInput = {
  repository: Repository
  scopes: readonly string[]
  ignores?: Repository
  maximumUntrackedFileBytes?: number
}

const locks = new Map<string, Promise<unknown>>()

export async function discover(input: string): Promise<Repository | undefined> {
  let directory = path.resolve(input)
  if ((await fs.promises.stat(directory).catch(() => undefined))?.isFile()) directory = path.dirname(directory)
  while (true) {
    const dotgit = path.join(directory, ".git")
    const info = await fs.promises.stat(dotgit).catch(() => undefined)
    if (info) {
      const value = info.isDirectory() ? undefined : await fs.promises.readFile(dotgit, "utf8")
      const match = value?.match(/^gitdir: (.+)\s*$/)
      if (!info.isDirectory() && !match) return undefined
      const gitDirectory = match ? path.resolve(directory, match[1].trim()) : dotgit
      const common = await optionalText(path.join(gitDirectory, "commondir"))
      const commonDirectory = common ? path.resolve(gitDirectory, common.trim()) : gitDirectory
      if (!(await optionalText(path.join(gitDirectory, "HEAD")))) return undefined
      const config = await optionalText(path.join(commonDirectory, "config"))
      if (/objectformat\s*=\s*sha256/i.test(config ?? "")) throw new Error("SHA-256 repositories are not supported")
      return { worktree: directory, gitDirectory, commonDirectory }
    }
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export async function create(input: { worktree: string; gitDirectory: string; seed?: Repository }): Promise<Repository> {
  const repository = { ...input, commonDirectory: input.gitDirectory }
  return locked(repository, async () => {
    if (await optionalText(path.join(input.gitDirectory, "HEAD"))) return repository
    const temporary = `${input.gitDirectory}.init-${randomUUID()}`
    try {
      await git.init({ fs, dir: input.worktree, gitdir: temporary, defaultBranch: "main" })
      if (input.seed) {
        await fs.promises.mkdir(path.join(temporary, "objects", "info"), { recursive: true })
        await fs.promises.writeFile(
          path.join(temporary, "objects", "info", "alternates"),
          `${path.join(input.seed.commonDirectory, "objects")}\n`,
        )
        const index = await readRepositoryIndex(input.seed)
        await fs.promises.writeFile(path.join(temporary, "index"), writeIndex(index))
      }
      await fs.promises.rename(temporary, input.gitDirectory).catch(async (error) => {
        if (!(await optionalText(path.join(input.gitDirectory, "HEAD")))) throw error
      })
      return repository
    } finally {
      await fs.promises.rm(temporary, { recursive: true, force: true })
    }
  })
}

export async function remote(repository: Repository, name = "origin") {
  const value = await git.getConfig({ ...(await options(repository)), path: `remote.${name}.url` })
  return typeof value === "string" ? value : undefined
}

export async function head(repository: Repository) {
  return git.resolveRef({ ...(await options(repository)), ref: "HEAD" }).catch((error: unknown) => {
    if (isMissingRef(error)) return undefined
    throw error
  })
}

export async function branch(repository: Repository) {
  return (await git.currentBranch({ ...(await options(repository)), fullname: false })) ?? undefined
}

export async function defaultRemoteBranch(repository: Repository, name = "origin") {
  const value = await optionalText(path.join(repository.commonDirectory, "refs", "remotes", name, "HEAD"))
  const prefix = `ref: refs/remotes/${name}/`
  return value?.startsWith(prefix) ? value.slice(prefix.length).trim() : undefined
}

export async function rootCommits(repository: Repository) {
  const oid = await head(repository)
  if (!oid) return []
  const found = new Set<string>()
  const roots: string[] = []
  const pending = [oid]
  const input = await options(repository)
  while (pending.length) {
    const current = pending.pop()!
    if (found.has(current)) continue
    found.add(current)
    const commit = await git.readCommit({ ...input, oid: current })
    if (!commit.commit.parent.length) roots.push(current)
    pending.push(...commit.commit.parent)
  }
  return roots.sort()
}

export async function clone(input: { remote: string; directory: string; branch?: string; depth?: number }) {
  requireHttp(input.remote)
  await git.clone({ fs, http, dir: input.directory, url: input.remote, ref: input.branch, depth: input.depth ?? 100 })
  const repository = await discover(input.directory)
  if (!repository) throw new Error("Clone did not create a Git repository")
  return repository
}

export async function fetchRemotes(repository: Repository, input?: { prune?: boolean }) {
  const opts = await options(repository)
  for (const item of await git.listRemotes(opts)) {
    requireHttp(item.url)
    await git.fetch({ ...opts, http, remote: item.remote, prune: input?.prune !== false })
  }
}

export async function fetchBranch(repository: Repository, input: { remote?: string; branch: string; force?: boolean }) {
  if (input.force === false) throw new Error("Non-forced branch fetching is not supported by standalone Git")
  const name = input.remote ?? "origin"
  requireHttp((await remote(repository, name)) ?? "")
  await git.fetch({ ...(await options(repository)), http, remote: name, ref: input.branch, singleBranch: true })
}

export async function checkoutRemoteBranch(repository: Repository, input: { remote?: string; branch: string; reset?: boolean }) {
  const opts = await options(repository)
  if (input.reset === false) {
    await git.checkout({ ...opts, remote: input.remote ?? "origin", ref: input.branch })
    return
  }
  const value = await git.resolveRef({ ...opts, ref: `refs/remotes/${input.remote ?? "origin"}/${input.branch}` })
  // `checkout -B` resets the branch after a successful, non-forced checkout.
  await git.checkout({ ...opts, ref: value, noUpdateHead: true })
  await git.writeRef({ ...opts, ref: `refs/heads/${input.branch}`, value, force: true })
  await git.writeRef({ ...opts, ref: "HEAD", value: `refs/heads/${input.branch}`, symbolic: true, force: true })
}

export async function resetHard(repository: Repository, revision: string) {
  const opts = await options(repository)
  const oid = await git.resolveRef({ ...opts, ref: revision })
  const name = await git.currentBranch({ ...opts, fullname: true })
  // Checkout first: a failure must not move the branch to a tree that was not installed.
  await git.checkout({ ...opts, ref: oid, noUpdateHead: true, force: true })
  await git.writeRef({ ...opts, ref: name ?? "HEAD", value: oid, force: true })
}

export async function listWorktrees(repository: Repository) {
  const root = repository.commonDirectory.endsWith(`${path.sep}.git`)
    ? path.dirname(repository.commonDirectory)
    : repository.worktree
  const result: Array<{ directory: string; kind: "main" | "linked" }> = [{ directory: root, kind: "main" }]
  const directory = path.join(repository.commonDirectory, "worktrees")
  for (const name of await fs.promises.readdir(directory).catch(missingDirectory)) {
    const file = await optionalText(path.join(directory, name, "gitdir"))
    if (file) result.push({ directory: path.dirname(path.resolve(directory, name, file.trim())), kind: "linked" })
  }
  return result
}

export async function createWorktree(input: { repository: Repository; directory: string; ref?: string }): Promise<Repository> {
  const directory = path.resolve(input.directory)
  const commit = await git.readCommit({
    ...(await options(input.repository)),
    oid: await git.resolveRef({ ...(await options(input.repository)), ref: input.ref ?? "HEAD" }),
  })
  const entries = await readEntries(input.repository, commit.commit.tree)
  if ([...entries.values()].some((entry) => entry.mode === "160000"))
    throw new Error("Linked worktree creation with submodules is not supported")
  const existing = await fs.promises.lstat(directory).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (existing && (!existing.isDirectory() || (await fs.promises.readdir(directory)).length))
    throw new Error(`Worktree destination must be an empty directory: ${directory}`)
  const administrative = path.join(input.repository.commonDirectory, "worktrees")
  await fs.promises.mkdir(administrative, { recursive: true })
  const basename = path.basename(directory).replace(/[^\p{L}\p{N}._-]/gu, "-") || "worktree"
  const gitDirectory = await fs.promises.mkdtemp(path.join(administrative, `${basename}-`))
  const repository = { worktree: directory, gitDirectory, commonDirectory: input.repository.commonDirectory }
  let created = false
  let installed = false
  try {
    if (!existing) {
      await fs.promises.mkdir(directory, { recursive: true })
      created = true
    }
    await fs.promises.writeFile(path.join(gitDirectory, "locked"), "initializing standalone worktree\n", { flag: "wx" })
    await fs.promises.writeFile(path.join(gitDirectory, "commondir"), `${path.relative(gitDirectory, repository.commonDirectory)}\n`, { flag: "wx" })
    await fs.promises.writeFile(path.join(gitDirectory, "gitdir"), `${path.join(directory, ".git")}\n`, { flag: "wx" })
    await fs.promises.writeFile(path.join(gitDirectory, "HEAD"), `${commit.oid}\n`, { flag: "wx" })
    await fs.promises.writeFile(path.join(directory, ".git"), `gitdir: ${gitDirectory}\n`, { flag: "wx" })
    installed = true
    if (entries.size) await restore({ repository, files: new Map([[".", commit.commit.tree]]) })
    if (!entries.size) await saveIndex(repository, entries)
    await fs.promises.rm(path.join(gitDirectory, "locked"))
    return repository
  } catch (error) {
    if (installed) {
      // Only the initially empty destination belongs to this failed checkout.
      for (const file of await fs.promises.readdir(directory))
        await fs.promises.rm(path.join(directory, file), { recursive: true, force: true })
    }
    if (created) await fs.promises.rmdir(directory)
    await fs.promises.rm(gitDirectory, { recursive: true, force: true })
    throw error
  }
}

export async function removeWorktree(input: { repository: Repository; directory: string; force: boolean }) {
  const directory = path.resolve(input.directory)
  const repository = await discover(directory)
  if (!repository || repository.worktree !== directory || repository.commonDirectory !== input.repository.commonDirectory)
    throw new Error(`Directory is not a worktree of this repository: ${directory}`)
  const administrative = path.join(repository.commonDirectory, "worktrees")
  if (path.dirname(repository.gitDirectory) !== administrative)
    throw new Error("The main worktree cannot be removed")
  if ((await optionalText(path.join(repository.gitDirectory, "gitdir")))?.trim() !== path.join(directory, ".git"))
    throw new Error("Linked worktree registration does not match its directory")
  if (await fs.promises.lstat(path.join(repository.gitDirectory, "locked")).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })) throw new Error("The linked worktree is locked")
  if (!input.force && await worktreeChanged(repository)) {
    const error = new Error("Worktree contains modified or untracked files; force is required to remove it")
    throw Object.assign(error, { forceRequired: true })
  }
  await fs.promises.rm(directory, { recursive: true })
  await fs.promises.rm(repository.gitDirectory, { recursive: true })
}

async function worktreeChanged(repository: Repository) {
  const opts = await options(repository)
  const oid = await head(repository)
  if (!oid) throw new Error("Linked worktree has no HEAD")
  const tree = await git.readCommit({ ...opts, oid })
  const expected = await readEntries(repository, tree.commit.tree)
  const staged = await readRepositoryIndex(repository)
  if ([...expected.values(), ...staged.values()].some((entry) => entry.mode === "160000"))
    throw new Error("Removing a worktree with submodules requires explicit force")
  if (expected.size !== staged.size || [...expected].some(([file, entry]) => {
    const actual = staged.get(file)
    return entry.oid !== actual?.oid || entry.mode !== actual?.mode
  })) return true
  const filemode = await git.getConfig({ ...opts, path: "core.filemode" }) !== false
  const trackedDirectories = new Set<string>()
  for (const file of staged.keys()) {
    for (let parent = path.posix.dirname(file); parent !== "."; parent = path.posix.dirname(parent)) trackedDirectories.add(parent)
  }
  const visited = new Set<string>()
  const visit = async (file: string): Promise<boolean> => {
    if (file === ".git") return false
    const absolute = path.join(repository.worktree, file)
    const stat = await fs.promises.lstat(absolute)
    if (stat.isDirectory()) {
      if (file !== "." && !trackedDirectories.has(file) && await git.isIgnored({ ...opts, filepath: `${file}/` })) return false
      for (const child of await fs.promises.readdir(absolute))
        if (await visit(file === "." ? child : `${file}/${child}`)) return true
      return false
    }
    const expected = staged.get(file)
    if (!expected) return !await git.isIgnored({ ...opts, filepath: file })
    visited.add(file)
    if (!stat.isFile() && !stat.isSymbolicLink()) return true
    const mode = stat.isSymbolicLink() ? "120000" : filemode && stat.mode & 0o111 ? "100755" : "100644"
    if (stat.isSymbolicLink() !== (expected.mode === "120000") || filemode && expected.mode !== mode) return true
    const object = stat.isSymbolicLink() ? Buffer.from(await fs.promises.readlink(absolute)) : await fs.promises.readFile(absolute)
    return (await git.hashBlob({ object })).oid !== expected.oid
  }
  return await visit(".") || visited.size !== staged.size
}

export async function pack(repository: Repository, limits: { looseObjectLimit?: number; packCountLimit?: number } = {}) {
  return locked(repository, async () => {
    const objects = path.join(repository.commonDirectory, "objects")
    const directory = path.join(objects, "pack")
    const collect = async () => {
      const loose: Array<{ oid: string; file: string }> = []
      for (const prefix of await fs.promises.readdir(objects)) {
        if (!/^[0-9a-f]{2}$/.test(prefix)) continue
        for (const suffix of await fs.promises.readdir(path.join(objects, prefix))) {
          if (/^[0-9a-f]{38}$/.test(suffix)) loose.push({ oid: prefix + suffix, file: path.join(objects, prefix, suffix) })
        }
      }
      const names = new Set(await fs.promises.readdir(directory).catch(missingDirectory))
      const packs = [...names].filter((name) => /^pack-[0-9a-f]{40}\.pack$/.test(name)).map((name) => name.slice(0, -5))
        .filter((name) => names.has(`${name}.idx`) && !names.has(`${name}.keep`) && !names.has(`${name}.promisor`))
      return { loose, packs }
    }
    const needed = (value: Awaited<ReturnType<typeof collect>>) =>
      value.loose.length >= (limits.looseObjectLimit ?? 2048) || value.packs.length >= (limits.packCountLimit ?? 16)
    if (!needed(await collect())) return
    const lockfile = path.join(repository.commonDirectory, "opencode-pack.lock")
    const lock = await fs.promises.open(lockfile, "wx", 0o600).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined
      throw error
    })
    if (!lock) return
    const temporary = path.join(directory, `tmp-standalone-${randomUUID()}.pack`)
    try {
      const current = await collect()
      if (!needed(current)) return
      const combined = current.packs.length >= (limits.packCountLimit ?? 16) ? current.packs : []
      const oids = new Set(current.loose.map((item) => item.oid))
      for (const name of combined) {
        for (const oid of packIndexObjects(await fs.promises.readFile(path.join(directory, `${name}.idx`)))) oids.add(oid)
      }
      if (!oids.size) return
      const opts = await options(repository)
      // Snapshot trees have no refs. Include every local object, including unreachable objects.
      const result = await git.packObjects({ ...opts, oids: [...oids].sort() })
      if (!result.packfile) throw new Error("Git did not return the packed objects")
      await fs.promises.mkdir(directory, { recursive: true })
      await fs.promises.writeFile(temporary, result.packfile, { flag: "wx", mode: 0o600 })
      const indexed = await git.indexPack({ ...opts, dir: directory, filepath: path.basename(temporary) })
      const packed = new Set(indexed.oids)
      if (packed.size !== oids.size || [...oids].some((oid) => !packed.has(oid)))
        throw new Error("New pack does not contain every requested object; nothing was removed")
      const destination = path.join(directory, result.filename)
      await fs.promises.rename(temporary, destination)
      await fs.promises.rename(temporary.replace(/\.pack$/, ".idx"), destination.replace(/\.pack$/, ".idx"))
      // Removing the optional aggregate index leaves ordinary pack indexes authoritative.
      if (combined.length) {
        await fs.promises.rm(path.join(directory, "multi-pack-index"), { force: true })
        await fs.promises.rm(path.join(directory, "multi-pack-index.d"), { recursive: true, force: true })
      }
      for (const item of current.loose) await fs.promises.rm(item.file, { force: true })
      for (const name of combined) {
        if (`${name}.pack` === result.filename) continue
        // An index is removed first so new readers cannot select a missing pack.
        for (const extension of [".idx", ".pack", ".rev", ".bitmap", ".mtimes"])
          await fs.promises.rm(path.join(directory, name + extension), { force: true })
      }
    } finally {
      await fs.promises.rm(temporary, { force: true })
      await fs.promises.rm(temporary.replace(/\.pack$/, ".idx"), { force: true })
      await lock.close()
      await fs.promises.rm(lockfile, { force: true })
    }
  })
}

function packIndexObjects(bytes: Buffer) {
  if (bytes.length < 1072 || bytes.readUInt32BE(0) !== 0xff744f63 || bytes.readUInt32BE(4) !== 2)
    throw new Error("Object compaction requires version 2 pack indexes")
  if (!createHash("sha1").update(bytes.subarray(0, -20)).digest().equals(bytes.subarray(-20)))
    throw new Error("Git pack index checksum mismatch")
  const count = bytes.readUInt32BE(1028)
  if (1032 + count * 28 + 40 > bytes.length) throw new Error("Truncated Git pack index")
  return Array.from({ length: count }, (_, index) => bytes.toString("hex", 1032 + index * 20, 1052 + index * 20))
}

export async function ignored(input: { repository: Repository; paths: readonly string[] }) {
  const opts = await options(input.repository)
  const result = new Set<string>()
  for (const file of input.paths) if (await git.isIgnored({ ...opts, filepath: relative(file) })) result.add(file)
  return result
}

export async function capture(input: CaptureInput) {
  return locked(input.repository, async () => {
    const entries = await readRepositoryIndex(input.repository)
    await refreshEntries(input, entries)
    const tree = await writeEntries(input.repository, entries)
    await saveIndex(input.repository, entries)
    return tree
  })
}

export async function refresh(input: Omit<CaptureInput, "scopes"> & { scope: string }) {
  return locked(input.repository, async () => {
    const entries = await readRepositoryIndex(input.repository)
    const skipped = await refreshEntries({ ...input, scopes: [input.scope] }, entries)
    await saveIndex(input.repository, entries)
    return { skipped }
  })
}

export async function write(repository: Repository) {
  return writeEntries(repository, await readRepositoryIndex(repository))
}

export async function files(input: { repository: Repository; from: string; to: string }) {
  const [before, after] = await Promise.all([readEntries(input.repository, input.from), readEntries(input.repository, input.to)])
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file)?.oid !== after.get(file)?.oid || before.get(file)?.mode !== after.get(file)?.mode)
    .sort()
}

export async function diff(input: { repository: Repository; from: string; to: string; context?: number; paths?: readonly string[] }) {
  const [before, after] = await Promise.all([readEntries(input.repository, input.from), readEntries(input.repository, input.to)])
  const opts = await options(input.repository)
  const result: Array<{ file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }> = []
  let remaining = 10_000_000
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(file)
    const next = after.get(file)
    if (old?.oid === next?.oid && old?.mode === next?.mode) continue
    if (input.paths && !input.paths.some((scope) => within(file, relative(scope)))) continue
    const content = async (entry: Entry | undefined) => {
      if (!entry) return Buffer.alloc(0)
      if (entry.mode === "160000") return Buffer.from(`Subproject commit ${entry.oid}\n`)
      return Buffer.from((await git.readBlob({ ...opts, oid: entry.oid })).blob)
    }
    const [oldBytes, newBytes] = await Promise.all([content(old), content(next)])
    const binary = oldBytes.subarray(0, 8000).includes(0) || newBytes.subarray(0, 8000).includes(0)
    const status = old ? (next ? "modified" : "deleted") : "added"
    const changes = binary ? [] : diffLines(oldBytes.toString("utf8"), newBytes.toString("utf8"))
    const additions = changes.reduce((sum, change) => sum + (change.added ? change.count ?? 0 : 0), 0)
    const deletions = changes.reduce((sum, change) => sum + (change.removed ? change.count ?? 0 : 0), 0)
    const patch = binary ? "" : unifiedPatch(file, old, next, oldBytes.toString("utf8"), newBytes.toString("utf8"), input.context ?? 3)
    const bytes = Buffer.byteLength(patch)
    result.push({
      file, status, additions, deletions,
      patch: bytes <= remaining ? patch : formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 })),
    })
    remaining = Math.max(0, remaining - bytes)
  }
  return result
}

export async function restore(input: { repository: Repository; files: ReadonlyMap<string, string> }) {
  return locked(input.repository, async () => {
    const index = await readRepositoryIndex(input.repository)
    const trees = new Map<string, Map<string, Entry>>()
    const opts = await options(input.repository)
    for (const [file, tree] of input.files) {
      const scope = relative(file)
      const entries = trees.get(tree) ?? await readEntries(input.repository, tree)
      trees.set(tree, entries)
      const selected = [...entries.values()].filter((entry) => within(entry.path, scope))
      if (!selected.length) {
        if (scope === ".") throw new Error("Refusing to recursively remove the entire worktree")
        await ensureParents(input.repository.worktree, scope)
        await fs.promises.rm(path.join(input.repository.worktree, scope), { recursive: true, force: true })
        for (const key of index.keys()) if (within(key, scope)) index.delete(key)
        continue
      }
      for (const entry of selected) {
        if (entry.mode === "160000") throw new Error("Gitlink restore requires submodule support")
        await ensureParents(input.repository.worktree, entry.path)
        const destination = path.join(input.repository.worktree, entry.path)
        const data = (await git.readBlob({ ...opts, oid: entry.oid })).blob
        await fs.promises.rm(destination, { force: true, recursive: true })
        if (entry.mode === "120000") await fs.promises.symlink(Buffer.from(data).toString("utf8"), destination)
        if (entry.mode !== "120000") {
          await fs.promises.writeFile(destination, data)
          await fs.promises.chmod(destination, entry.mode === "100755" ? 0o755 : 0o644)
        }
        for (const key of index.keys()) if (key.startsWith(`${entry.path}/`)) index.delete(key)
        index.set(entry.path, entry)
      }
    }
    await saveIndex(input.repository, index)
  })
}

async function refreshEntries(input: CaptureInput, entries: Map<string, Entry>) {
  const scopes = input.scopes.map(relative)
  const initial = new Map(entries)
  const seen = new Set<string>()
  const skipped: string[] = []
  const opts = await options(input.repository)
  const ignoreOptions = await options(input.ignores ?? input.repository)
  const trackedDirectories = new Set<string>()
  for (const file of initial.keys()) {
    for (let parent = path.posix.dirname(file); parent !== "."; parent = path.posix.dirname(parent)) trackedDirectories.add(parent)
  }
  const visit = async (file: string): Promise<void> => {
    if (file.split("/").includes(".git")) return
    const absolute = path.join(input.repository.worktree, file)
    if (absolute === input.repository.gitDirectory) return
    const stat = await fs.promises.lstat(absolute).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (!stat) return
    if (stat.isDirectory()) {
      if (file !== "." && !trackedDirectories.has(file) && !initial.has(file) && await git.isIgnored({ ...ignoreOptions, filepath: `${file}/` })) return
      if (file !== "." && await fs.promises.lstat(path.join(absolute, ".git")).catch(() => undefined)) {
        const nested = await discover(absolute)
        const oid = nested ? await head(nested) : undefined
        if (!oid) throw new Error(`Embedded repository has no HEAD: ${file}`)
        seen.add(file)
        entries.set(file, { path: file, oid, mode: "160000" })
        return
      }
      for (const child of await fs.promises.readdir(absolute)) await visit(file === "." ? child : `${file}/${child}`)
      return
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported snapshot file type: ${file}`)
    seen.add(file)
    if (!initial.has(file) && await git.isIgnored({ ...ignoreOptions, filepath: file })) return
    if (!initial.has(file) && input.maximumUntrackedFileBytes && stat.isFile() && stat.size > input.maximumUntrackedFileBytes) {
      skipped.push(file)
      return
    }
    const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644"
    const blob = stat.isSymbolicLink() ? Buffer.from(await fs.promises.readlink(absolute)) : await fs.promises.readFile(absolute)
    const oid = await git.hashBlob({ object: blob }).then((value) => value.oid)
    const old = initial.get(file)
    if (old?.oid === oid && old.mode === mode) return
    if (await git.isIgnored({ ...ignoreOptions, filepath: file })) {
      entries.delete(file)
      return
    }
    await git.writeBlob({ ...opts, blob })
    entries.set(file, { path: file, oid, mode })
  }
  for (const scope of scopes) await visit(scope)
  for (const file of initial.keys()) if (scopes.some((scope) => within(file, scope)) && !seen.has(file)) entries.delete(file)
  return skipped
}

async function readRepositoryIndex(repository: Repository) {
  const bytes = await fs.promises.readFile(path.join(repository.gitDirectory, "index")).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  return bytes ? readIndex(bytes) : new Map<string, Entry>()
}

async function saveIndex(repository: Repository, entries: Map<string, Entry>) {
  const destination = path.join(repository.gitDirectory, "index")
  const temporary = `${destination}.standalone-${randomUUID()}`
  try {
    await fs.promises.writeFile(temporary, writeIndex(entries), { flag: "wx", mode: 0o600 })
    await fs.promises.rename(temporary, destination)
  } finally {
    await fs.promises.rm(temporary, { force: true })
  }
}

async function writeEntries(repository: Repository, entries: Map<string, Entry>) {
  const opts = await options(repository)
  const directories = new Map<string, Map<string, Entry>>([[".", new Map()]])
  for (const entry of entries.values()) {
    relative(entry.path)
    const parent = path.posix.dirname(entry.path)
    if (!directories.has(parent)) directories.set(parent, new Map())
    directories.get(parent)!.set(path.posix.basename(entry.path), entry)
    for (let current = parent; current !== "."; current = path.posix.dirname(current)) {
      const ancestor = path.posix.dirname(current)
      if (!directories.has(ancestor)) directories.set(ancestor, new Map())
    }
  }
  const depth = (file: string) => file === "." ? 0 : file.split("/").length
  const ordered = [...directories.keys()].sort((a, b) => depth(b) - depth(a))
  let root = ""
  for (const directory of ordered) {
    const tree = [...directories.get(directory)!.entries()].map(([name, entry]) => ({
      path: name, mode: entry.mode, oid: entry.oid,
      type: entry.mode === "040000" ? "tree" as const : entry.mode === "160000" ? "commit" as const : "blob" as const,
    }))
    const oid = await git.writeTree({ ...opts, tree })
    if (directory === ".") root = oid
    if (directory !== ".") directories.get(path.posix.dirname(directory))!.set(path.posix.basename(directory), { path: directory, oid, mode: "040000" })
  }
  return root
}

async function readEntries(repository: Repository, oid: string): Promise<Map<string, Entry>> {
  const opts = await options(repository)
  const result = new Map<string, Entry>()
  const visit = async (tree: string, directory: string): Promise<void> => {
    for (const entry of (await git.readTree({ ...opts, oid: tree })).tree) {
      const file = directory ? `${directory}/${entry.path}` : entry.path
      relative(file)
      if (entry.type === "tree") await visit(entry.oid, file)
      if (entry.type !== "tree") result.set(file, { path: file, mode: entry.mode, oid: entry.oid })
    }
  }
  await visit(oid, "")
  return result
}

async function options(repository: Repository) {
  const objectDirectory = path.join(repository.commonDirectory, "objects")
  const alternateFile = await optionalText(path.join(objectDirectory, "info", "alternates"))
  const alternates = (alternateFile ?? "").split(/\r?\n/).filter(Boolean).map((value) => path.resolve(objectDirectory, value))
  const shared = new Set(["objects", "refs", "config", "packed-refs", "shallow"])
  const promises = new Proxy(fs.promises, {
    get(target, property, receiver) {
      // oxlint-disable-next-line no-restricted-globals -- Forward the filesystem Proxy receiver and symbol keys unchanged.
      const method: unknown = Reflect.get(target, property, receiver)
      if (typeof method !== "function") return method
      return async (...args: unknown[]) => {
        const file = typeof args[0] === "string" ? args[0] : undefined
        const local = file ? path.relative(repository.gitDirectory, file) : undefined
        const translated = local && shared.has(local.split(path.sep)[0]) ? path.join(repository.commonDirectory, local) : file
        const actual = [...args]
        if (translated) actual[0] = translated
        const objectPath = translated ? path.relative(objectDirectory, translated) : undefined
        const inObjects = objectPath !== undefined && !objectPath.startsWith("..") && !path.isAbsolute(objectPath)
        if (inObjects && property === "readdir") {
          const lists = await Promise.all([objectDirectory, ...alternates].map((root) => fs.promises.readdir(path.join(root, objectPath)).catch(missingDirectory)))
          return [...new Set(lists.flat())]
        }
        try {
          return await method.apply(target, actual)
        } catch (error) {
          if (!inObjects || !["readFile", "stat", "lstat"].includes(String(property)) || !isMissing(error)) throw error
          for (const alternate of alternates) {
            try {
              return await method.apply(target, [path.join(alternate, objectPath), ...args.slice(1)])
            } catch (cause) {
              if (!isMissing(cause)) throw cause
            }
          }
          throw error
        }
      }
    },
  })
  return { fs: { promises }, dir: repository.worktree, gitdir: repository.gitDirectory }
}

function unifiedPatch(file: string, old: Entry | undefined, next: Entry | undefined, before: string, after: string, context: number) {
  const quote = (value: string) => /[\x00-\x1f"\\]/.test(value) ? JSON.stringify(value) : value
  const a = quote(`a/${file}`)
  const b = quote(`b/${file}`)
  let patch = `diff --git ${a} ${b}\n`
  if (!old) patch += `new file mode ${next!.mode}\n`
  if (!next) patch += `deleted file mode ${old!.mode}\n`
  if (old && next && old.mode !== next.mode) patch += `old mode ${old.mode}\nnew mode ${next.mode}\n`
  if (old?.oid === next?.oid) return patch
  patch += `index ${old?.oid.slice(0, 7) ?? "0000000"}..${next?.oid.slice(0, 7) ?? "0000000"}${old && next && old.mode === next.mode ? ` ${old.mode}` : ""}\n`
  if (before === after) return patch
  patch += `--- ${old ? a : "/dev/null"}\n+++ ${next ? b : "/dev/null"}\n`
  const formatted = formatPatch(structuredPatch(a, b, before, after, "", "", { context }))
  return patch + formatted.slice(formatted.indexOf("@@"))
}

async function ensureParents(root: string, file: string) {
  const parts = relative(file).split("/").slice(0, -1)
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.promises.lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (stat && !stat.isDirectory()) await fs.promises.rm(current, { force: true })
    await fs.promises.mkdir(current, { recursive: true })
  }
}

function relative(file: string) {
  const normalized = process.platform === "win32" ? file.replaceAll("\\", "/") : file
  if (path.isAbsolute(file) || file.includes("\0") || normalized.split("/").some((part) => part === ".." || part === ".git"))
    throw new Error(`Invalid repository-relative path: ${file}`)
  return normalized.replace(/^\.\//, "").replace(/\/$/, "") || "."
}

function within(file: string, scope: string) {
  return scope === "." || file === scope || file.startsWith(`${scope}/`)
}

async function locked<T>(repository: Repository, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(repository.gitDirectory) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(run)
  locks.set(repository.gitDirectory, pending)
  try {
    return await pending
  } finally {
    if (locks.get(repository.gitDirectory) === pending) locks.delete(repository.gitDirectory)
  }
}

async function optionalText(file: string) {
  return fs.promises.readFile(file, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
}

function missingDirectory(error: unknown): string[] {
  if (isMissing(error)) return []
  throw error
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

function isMissingRef(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "NotFoundError"
}

function requireHttp(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Standalone Git currently supports HTTP(S) remotes only")
}
