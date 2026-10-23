import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { watch } from "./config-watch.mjs"

const execute = promisify(execFile)

for (const backend of [undefined, "polling"]) {
  test(`config watch reports real creates, edits, atomic replacements and deletions with ${backend ?? "native with quota fallback"}`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-config-watch-"))
    const config = join(root, "tui.json")
    const events = []
    const watcher = watch(root, { backend, intervalMs: 10 }, (type, name) => events.push([type, name]))
    try {
      assert.equal(await changed(watcher, "tui.json", () => writeFile(config, '{"theme":"first"}')), "rename")
      assert.equal(await changed(watcher, "tui.json", () => writeFile(config, '{"theme":"한국어"}')), "change")
      const replacement = join(root, "replacement.tmp")
      await writeFile(replacement, '{"theme":"atomic"}')
      assert.equal(await changed(watcher, "tui.json", () => rename(replacement, config)), "rename")
      assert.equal(await changed(watcher, "tui.json", () => rm(config)), "rename")
      assert.equal(await changed(watcher, "tui.json", () => writeFile(config, '{"theme":"recreated"}')), "rename")
      assert.ok(events.some(([type, name]) => type === "change" && name === "tui.json"))
    } finally {
      watcher.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test(`config watch follows replaced directory inodes with ${backend ?? "native with quota fallback"}`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-config-directory-"))
    const directory = join(root, "config")
    const old = join(root, "old-config")
    await mkdir(directory)
    await writeFile(join(directory, "tui.json"), "old")
    const watcher = watch(directory, { backend, intervalMs: 10 }, () => {})
    try {
      await changed(watcher, null, () => rename(directory, old))
      await changed(watcher, "tui.json", async () => {
        await mkdir(directory)
        await writeFile(join(directory, "tui.json"), "replacement")
      })
      assert.equal(await changed(watcher, "tui.json", () => writeFile(join(directory, "tui.json"), "updated replacement")), "change")
    } finally {
      watcher.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("copied standard-library watcher closes synchronously before work and leaves no live handles", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-config-close-"))
  try {
    const copied = join(root, "watch.mjs")
    await copyFile(fileURLToPath(new URL("./config-watch.mjs", import.meta.url)), copied)
    const code = `
      import assert from 'node:assert/strict'
      import { mkdir, writeFile } from 'node:fs/promises'
      import { watch } from './watch.mjs'
      await mkdir('./config')
      let calls = 0
      let closes = 0
      const first = watch('./config', () => calls++)
      const second = watch('./config', { backend: 'polling', intervalMs: 1 }, () => calls++)
      first.on('close', () => closes++)
      second.on('close', () => closes++)
      first.close()
      second.close()
      first.close()
      second.close()
      await writeFile('./config/tui.json', 'closed')
      assert.equal(calls, 0)
      assert.equal(closes, 2)
      console.log('closed')
    `
    const env = { ...process.env, PATH: "", HOME: root }
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    const result = await execute(process.execPath, ["--no-addons", "--input-type=module", "--eval", code], { cwd: root, env, timeout: 10_000, maxBuffer: 64 * 1024 })
    assert.equal(result.stdout, "closed\n")
    assert.equal(result.stderr, "")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function changed(watcher, filename, operation) {
  const result = Promise.withResolvers()
  const change = (type, name) => { if (name === filename) result.resolve(type) }
  const error = (cause) => result.reject(cause)
  const timer = setTimeout(() => result.reject(new Error(`No filesystem change for ${filename ?? "the directory"}`)), 5_000)
  watcher.on("change", change)
  watcher.on("error", error)
  return (async () => {
    try {
      await operation()
      return await result.promise
    } finally {
      clearTimeout(timer)
      watcher.off("change", change)
      watcher.off("error", error)
    }
  })()
}
