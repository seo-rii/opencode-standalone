import { EventEmitter } from "node:events"
import fs from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

/** ConfigProvider needs a synchronous close handle even when native watch quotas are exhausted. */
export function watch(directory, options, listener) {
  if (typeof options === "function") {
    listener = options
    options = {}
  }
  options ??= {}
  if (typeof listener !== "function") throw new TypeError("watch requires a listener")
  if (options.backend !== undefined && options.backend !== "native" && options.backend !== "polling") throw new TypeError("watch backend must be native or polling")
  const interval = options.intervalMs ?? 1_000
  if (!Number.isInteger(interval) || interval < 1 || interval > 2_147_483_647) throw new RangeError("watch intervalMs must be a positive timer interval")
  const root = resolve(directory)
  const watcher = new EventEmitter()
  watcher.on("change", listener)
  let closed = false
  let native
  let polling
  let pending
  let dirty = false
  // Establish the baseline before returning so a subsequent config write cannot be swallowed by setup.
  let current = snapshot(root)
  const fallback = () => {
    if (closed) return
    native?.close()
    native = undefined
    polling ??= setInterval(refresh, interval)
  }
  const observe = () => {
    if (closed || polling) return
    native?.close()
    native = undefined
    try {
      native = fs.watch(root, refresh)
      native.on("error", (error) => {
        if (closed) return
        if (error.code === "EMFILE" || error.code === "ENOSPC") return fallback()
        watcher.emit("error", error)
      })
    } catch (error) {
      if (error.code === "EMFILE" || error.code === "ENOSPC" || error.code === "ENOENT" || error.code === "ENOTDIR") return fallback()
      throw error
    }
  }
  function refresh() {
    if (closed) return
    dirty = true
    if (pending) return
    pending = (async () => {
      while (dirty && !closed) {
        dirty = false
        const next = await scan(root)
        if (closed) return
        const events = []
        if (current.identity !== next.identity) {
          if (next.identity) observe()
          else fallback()
          events.push(["rename", null])
        }
        for (const [name, signature] of next.files) {
          const previous = current.files.get(name)
          if (previous === undefined || previous.identity !== signature.identity) events.push(["rename", name])
          else if (previous.value !== signature.value) events.push(["change", name])
        }
        for (const name of current.files.keys()) if (!next.files.has(name)) events.push(["rename", name])
        current = next
        for (const event of events) {
          if (closed) return
          watcher.emit("change", ...event)
        }
      }
    })().catch((error) => {
      if (!closed) watcher.emit("error", error)
    }).finally(() => {
      pending = undefined
      if (dirty && !closed) refresh()
    })
  }
  watcher.close = () => {
    if (closed) return
    closed = true
    native?.close()
    native = undefined
    clearInterval(polling)
    watcher.emit("close")
  }
  if (options.backend === "polling" || !current.identity) fallback()
  else observe()
  return watcher
}

function fingerprint(stat) {
  return { identity: `${stat.dev}:${stat.ino}`, value: `${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` }
}

function snapshot(root) {
  try {
    const stat = fs.lstatSync(root, { bigint: true })
    const files = new Map()
    for (const name of fs.readdirSync(root)) {
      try { files.set(name, fingerprint(fs.lstatSync(join(root, name), { bigint: true }))) }
      catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error }
    }
    return { identity: fingerprint(stat).identity, files }
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { identity: undefined, files: new Map() }
    throw error
  }
}

async function scan(root) {
  try {
    const stat = await lstat(root, { bigint: true })
    const files = new Map()
    for (const name of await readdir(root)) {
      try { files.set(name, fingerprint(await lstat(join(root, name), { bigint: true }))) }
      catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error }
    }
    return { identity: fingerprint(stat).identity, files }
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { identity: undefined, files: new Map() }
    throw error
  }
}
