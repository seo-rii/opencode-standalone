import { watch, type FSWatcher } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { Minimatch } from "minimatch"

export type Event = { path: string; type: "create" | "update" | "delete" }
export type SubscribeCallback = (error: Error | null, events: Event[]) => void
export type Options = { ignore?: readonly string[]; backend?: string }
export type Subscription = { unsubscribe: () => Promise<void> }

const subscriptions = new Set<{
  directory: string
  callback: SubscribeCallback
  subscription: Subscription
}>()

/** Reconcile directory state because fs.watch reports rename/change, not create/delete. */
export async function subscribe(directory: string, callback: SubscribeCallback, options: Options = {}) {
  const root = path.resolve(directory)
  const ignored = (options.ignore ?? []).map((value) => {
    const relative = slash(path.isAbsolute(value) ? path.relative(root, value) : value)
    return {
      path: path.resolve(root, value),
      pattern: new Minimatch(relative, { dot: true, nonegate: true, nocomment: true }),
    }
  })
  const excluded = (file: string) =>
    ignored.some(
      (ignore) =>
        file === ignore.path ||
        file.startsWith(ignore.path + path.sep) ||
        ignore.pattern.match(slash(path.relative(root, file))),
    )
  const native = new Map<string, { watcher: FSWatcher; identity: string }>()
  let closed = false
  let polling: ReturnType<typeof setInterval> | undefined
  const fallback = () => {
    if (closed) return
    for (const entry of native.values()) entry.watcher.close()
    native.clear()
    polling ??= setInterval(refresh, 1_000)
  }
  const observe = (directory: string, identity: string) => {
    if (closed || polling) return
    const previous = native.get(directory)
    if (previous?.identity === identity) return
    previous?.watcher.close()
    native.delete(directory)
    try {
      const watcher = watch(directory, refresh)
      native.set(directory, { watcher, identity })
      watcher.on("error", (error: NodeJS.ErrnoException) => {
        if (closed) return
        if (error.code === "EMFILE" || error.code === "ENOSPC") return fallback()
        callback(error, [])
      })
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      if (error.code === "EMFILE" || error.code === "ENOSPC") return fallback()
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw cause
    }
  }
  const scan = async () => {
    const files = new Map<string, string>()
    const directories = new Set<string>()
    const visit = async (directory: string, identity: string): Promise<void> => {
      if (closed) return
      directories.add(directory)
      // A non-recursive watch reports errors synchronously and watches only
      // directories. Node's recursive implementation can swallow EMFILE and
      // otherwise consumes watches for every file in the tree.
      observe(directory, identity)
      const entries = await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return []
        throw cause
      })
      for (const entry of entries) {
        if (closed) return
        const file = path.join(directory, entry.name)
        if (excluded(file)) continue
        const stat = await lstat(file, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return undefined
          throw cause
        })
        if (!stat) continue
        files.set(file, `${stat.mode}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
        // Following symlinks here could leave the watched tree or enter a loop.
        if (stat.isDirectory()) await visit(file, `${stat.dev}:${stat.ino}`)
      }
    }
    const rootStat = await lstat(root, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return undefined
      throw cause
    })
    if (rootStat?.isDirectory()) await visit(root, `${rootStat.dev}:${rootStat.ino}`)
    for (const [directory, entry] of native) {
      if (directories.has(directory)) continue
      entry.watcher.close()
      native.delete(directory)
    }
    return files
  }
  let current = new Map<string, string>()
  let ready = false
  let dirty = false
  let pending: Promise<void> | undefined
  const refresh = () => {
    dirty = true
    if (!ready || closed || pending) return
    pending = (async () => {
      while (dirty && !closed) {
        dirty = false
        const next = await scan()
        if (closed) return
        const events: Event[] = []
        for (const [file, signature] of next) {
          if (!current.has(file)) events.push({ path: file, type: "create" })
          else if (current.get(file) !== signature) events.push({ path: file, type: "update" })
        }
        for (const file of current.keys()) {
          if (!next.has(file)) events.push({ path: file, type: "delete" })
        }
        current = next
        if (events.length) callback(null, events)
      }
    })()
      .catch((cause: unknown) => {
        if (!closed) callback(cause instanceof Error ? cause : new Error(String(cause)), [])
      })
      .finally(() => {
        pending = undefined
        if (dirty && !closed) refresh()
      })
  }
  if (options.backend === "polling") fallback()
  const record = {
    directory: root,
    callback,
    subscription: {
      unsubscribe: async () => {
        closed = true
        for (const entry of native.values()) entry.watcher.close()
        native.clear()
        clearInterval(polling)
        subscriptions.delete(record)
        await pending
      },
    },
  }
  try {
    current = await scan()
    ready = true
    subscriptions.add(record)
    if (dirty) refresh()
    return record.subscription
  } catch (cause) {
    await record.subscription.unsubscribe()
    throw cause
  }
}

export async function unsubscribe(directory: string, callback: SubscribeCallback) {
  const root = path.resolve(directory)
  await Promise.all(
    [...subscriptions]
      .filter((entry) => entry.directory === root && entry.callback === callback)
      .map((entry) => entry.subscription.unsubscribe()),
  )
}

function slash(value: string) {
  return value.split(path.sep).join("/")
}

// Core uses only subscribe/unsubscribe from Parcel's wrapper. Keep its factory seam.
export function createWrapper(_binding?: unknown) {
  return { subscribe, unsubscribe }
}

export default { subscribe, unsubscribe }
