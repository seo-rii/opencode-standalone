import assert from "node:assert/strict"
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { subscribe, type Event } from "./watcher.ts"

test("recursive watcher classifies create, update, rename and delete and ignores excluded subtrees", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-standalone-watch-"))
  await mkdir(path.join(directory, "src/nested"), { recursive: true })
  await mkdir(path.join(directory, "ignored"))
  const observed: Event[] = []
  const pending = new Set<{ predicate: (event: Event) => boolean; resolve: () => void; reject: (cause: Error) => void }>()
  const subscription = await subscribe(
    directory,
    (error, events) => {
      if (error) {
        for (const item of pending) item.reject(error)
        return
      }
      observed.push(...events)
      for (const item of pending) {
        if (!events.some(item.predicate)) continue
        pending.delete(item)
        item.resolve()
      }
    },
    { ignore: ["ignored", "**/*.tmp"] },
  )
  context.after(async () => {
    await subscription.unsubscribe()
    await rm(directory, { recursive: true, force: true })
  })
  const event = (file: string, type: Event["type"]) =>
    new Promise<void>((resolve, reject) => {
      const item = { predicate: (event: Event) => event.path === path.join(directory, file) && event.type === type, resolve, reject }
      pending.add(item)
      // A deadline bounds missing real filesystem events; it never drives production behavior.
      const timer = setTimeout(() => reject(new Error(`Missing ${type}: ${file}`)), 5_000)
      timer.unref()
      item.resolve = () => {
        clearTimeout(timer)
        resolve()
      }
      item.reject = (cause) => {
        clearTimeout(timer)
        reject(cause)
      }
    })

  const created = event("src/nested/file.ts", "create")
  await writeFile(path.join(directory, "ignored/private.txt"), "ignored")
  await writeFile(path.join(directory, "src/scratch.tmp"), "ignored")
  await writeFile(path.join(directory, "src/nested/file.ts"), "first")
  await created

  const updated = event("src/nested/file.ts", "update")
  await writeFile(path.join(directory, "src/nested/file.ts"), "second version")
  await updated

  const removed = event("src/nested/file.ts", "delete")
  const renamed = event("src/nested/renamed.ts", "create")
  await rename(path.join(directory, "src/nested/file.ts"), path.join(directory, "src/nested/renamed.ts"))
  await Promise.all([removed, renamed])

  const deleted = event("src/nested/renamed.ts", "delete")
  await rm(path.join(directory, "src/nested/renamed.ts"))
  await deleted
  assert.equal(observed.some((event) => event.path.includes(`${path.sep}ignored${path.sep}`)), false)
  assert.equal(observed.some((event) => event.path.endsWith("scratch.tmp")), false)
  assert.equal(pending.size, 0)
})

test("watcher handles newly created nested directories and idempotent teardown", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-standalone-watch-"))
  const ready = Promise.withResolvers<void>()
  const timer = setTimeout(() => ready.reject(new Error("Missing file in new nested directory")), 5_000)
  timer.unref()
  const subscription = await subscribe(directory, (error, events) => {
    if (error) ready.reject(error)
    if (events.some((event) => event.path === path.join(directory, "new/nested/file.txt") && event.type === "create"))
      ready.resolve()
  })
  context.after(async () => {
    clearTimeout(timer)
    await subscription.unsubscribe()
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(path.join(directory, "new/nested"), { recursive: true })
  await writeFile(path.join(directory, "new/nested/file.txt"), "visible")
  await ready.promise
  await subscription.unsubscribe()
  await subscription.unsubscribe()
  // Removing the directory after teardown also exercises handle cleanup on Windows.
  await rm(directory, { recursive: true, force: true })
})

test("polling backend detects changes without native watch handles", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-standalone-poll-"))
  const ready = Promise.withResolvers<void>()
  const subscription = await subscribe(directory, (error, events) => {
    if (error) return ready.reject(error)
    if (events.some((event) => event.path === path.join(directory, "nested/file.txt") && event.type === "create")) ready.resolve()
  }, { backend: "polling" })
  const timer = setTimeout(() => ready.reject(new Error("Polling did not reconcile the filesystem")), 5_000)
  context.after(async () => {
    clearTimeout(timer)
    await subscription.unsubscribe()
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(path.join(directory, "nested"))
  await writeFile(path.join(directory, "nested/file.txt"), "created without a native watcher")
  await ready.promise
})

test("replacing a watched directory continues observing its new children", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-standalone-watch-replace-"))
  await mkdir(path.join(directory, "nested"))
  await writeFile(path.join(directory, "nested/file.txt"), "old inode")
  const replaced = Promise.withResolvers<void>()
  const edited = Promise.withResolvers<void>()
  let phase = "replace"
  const subscription = await subscribe(directory, (error, events) => {
    if (error) {
      replaced.reject(error)
      edited.reject(error)
      return
    }
    if (!events.some((event) => event.path === path.join(directory, "nested/file.txt") && event.type !== "delete")) return
    if (phase === "replace") replaced.resolve()
    else edited.resolve()
  }, { ignore: ["old"] })
  const timer = setTimeout(() => {
    replaced.reject(new Error("Replacement directory was not reconciled"))
    edited.reject(new Error("Edit in replacement directory was not observed"))
  }, 8_000)
  // Attach both rejection handlers before either deadline can expire.
  const completed = Promise.all([replaced.promise, edited.promise])
  void completed.catch(() => {})
  context.after(async () => {
    clearTimeout(timer)
    await subscription.unsubscribe()
    await rm(directory, { recursive: true, force: true })
  })
  await rename(path.join(directory, "nested"), path.join(directory, "old"))
  await mkdir(path.join(directory, "nested"))
  await writeFile(path.join(directory, "nested/file.txt"), "replacement inode")
  await replaced.promise
  phase = "edit"
  await writeFile(path.join(directory, "nested/file.txt"), "edited existing child without touching its parent directory")
  await completed
})
