import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { build } from "vite"
import { tuiRuntime } from "../scripts/tui-runtime.mjs"

const execute = promisify(execFile)
const artifactDirectory = await mkdtemp(join(tmpdir(), "opencode-tui-watch-runtime-"))
after(() => rm(artifactDirectory, { recursive: true, force: true }))
let artifact

// Genuine fallback polling and the original caller's 50 ms reload debounce drive these children.
test("actual model preference repository persists and observes atomic updates, then unsubscribes without live watchers", { timeout: 30_000 }, async () => {
  await run(`
    import assert from 'node:assert/strict'
    import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
    import { createModelPreferenceRepository } from './runtime.mjs'
    await mkdir('./state')
    const file = './state/model.json'
    await writeFile(file, JSON.stringify({ custom: { retained: true } }))
    const first = createModelPreferenceRepository(file)
    const second = createModelPreferenceRepository(file)
    const left = observe(first)
    const right = observe(second)
    try {
      assert.deepEqual(await first.load(), { recent: [], favorite: [], variant: {} })
      await Promise.all([left.until(value => value.recent.length === 0), right.until(value => value.recent.length === 0)])
      const model = { providerID: 'standalone', modelID: '한국어' }
      await Promise.all([first.addRecent(model), first.setFavorite(model, true), first.saveVariant(model, 'high')])
      const updated = await right.until(value => value.recent[0]?.modelID === model.modelID && value.favorite[0]?.modelID === model.modelID && value.variant['standalone/한국어'] === 'high')
      assert.deepEqual(await first.load(), updated)
      assert.equal(await second.resolveVariant(model), 'high')
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).custom, { retained: true })
      const replacement = { recent: [{ providerID: 'external', modelID: 'atomic' }], favorite: [], variant: { 'external/atomic': 'low' }, custom: { retained: 'atomic' } }
      await writeFile(file + '.external.tmp', JSON.stringify(replacement))
      await rename(file + '.external.tmp', file)
      await Promise.all([left.until(value => value.recent[0]?.modelID === 'atomic'), right.until(value => value.recent[0]?.modelID === 'atomic')])
      left.close()
      const count = left.values.length
      await second.setFavorite(model, true)
      await right.until(value => value.favorite[0]?.modelID === model.modelID)
      assert.equal(left.values.length, count, 'unsubscribed repository must stop receiving file events')
      right.close()
      await first.saveVariant(model, 'default')
      assert.equal(await first.resolveVariant(model), undefined)
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).custom, { retained: 'atomic' })
      assert.equal(left.values.length, count)
      console.log('model preference watches closed')
    } finally {
      left.close()
      right.close()
    }
    function observe(repository) {
      const values = []
      const waiting = new Set()
      const close = repository.subscribe(value => {
        values.push(value)
        for (const request of waiting) if (request.predicate(value)) request.resolve(value)
      })
      return {
        values, close,
        until(predicate) {
          const current = values.at(-1)
          if (current && predicate(current)) return Promise.resolve(current)
          const result = Promise.withResolvers()
          const request = { predicate, resolve: result.resolve }
          waiting.add(request)
          const timer = setTimeout(() => result.reject(new Error('Model preference subscription did not propagate')), 5_000)
          return result.promise.finally(() => { clearTimeout(timer); waiting.delete(request) })
        },
      }
    }
  `, "model preference watches closed\n")
})

test("actual plugin source watcher observes atomic saves and disposes its real filesystem watchers", { timeout: 20_000 }, async () => {
  await run(`
    import assert from 'node:assert/strict'
    import { mkdir, rename, writeFile } from 'node:fs/promises'
    import { createSourceWatcher } from './runtime.mjs'
    await mkdir('./plugin')
    const file = './plugin/index.mjs'
    await writeFile(file, 'export const value = 1')
    const changed = Promise.withResolvers()
    let notifications = 0
    const watcher = createSourceWatcher(() => { notifications++; changed.resolve() })
    try {
      await watcher.add(file)
      await writeFile(file + '.tmp', 'export const value = 2')
      await rename(file + '.tmp', file)
      const timer = setTimeout(() => changed.reject(new Error('Plugin source change did not propagate')), 5_000)
      try { await changed.promise } finally { clearTimeout(timer) }
      assert.ok(notifications > 0)
      watcher.dispose()
      const before = notifications
      await writeFile(file, 'export const value = 3')
      assert.equal(notifications, before)
      console.log('plugin source watches closed')
    } finally {
      watcher.dispose()
    }
  `, "plugin source watches closed\n")
})

async function run(code, expected) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-tui-watch-caller-"))
  try {
    artifact ??= bundleRuntime()
    await writeFile(join(directory, "runtime.mjs"), await artifact)
    const env = { ...process.env, PATH: "", HOME: directory }
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    const result = await execute(process.execPath, ["--no-addons", "--input-type=module", "--eval", code], { cwd: directory, env, timeout: 20_000, maxBuffer: 128 * 1024 })
    assert.equal(result.stderr, "")
    assert.equal(result.stdout, expected)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function bundleRuntime() {
  const entry = join(artifactDirectory, "entry.mjs")
  const preference = fileURLToPath(new URL("../../packages/tui/src/model-preference.ts", import.meta.url))
  const source = fileURLToPath(new URL("../../packages/tui/src/plugin/watch.ts", import.meta.url))
  await writeFile(entry, `export { createModelPreferenceRepository } from ${JSON.stringify(preference)}\nexport { createSourceWatcher } from ${JSON.stringify(source)}\n`)
  const result = await build({
    configFile: false, root: artifactDirectory, logLevel: "silent",
    esbuild: { tsconfigRaw: "{}" }, plugins: [tuiRuntime()], ssr: { noExternal: true },
    build: {
      ssr: entry, write: false, minify: false, target: "esnext",
      rollupOptions: { external: isBuiltin, output: { format: "esm", inlineDynamicImports: true } },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((value) => value.output)
  assert.equal(outputs.length, 1)
  for (const dependency of outputs[0].imports) assert.ok(isBuiltin(dependency), `Unexpected runtime dependency: ${dependency}`)
  return outputs[0].code
}
