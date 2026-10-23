import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { minifyApplication } from "../scripts/minify.mjs"

test("application minification preserves names, argument counts, eval scope and worker serialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone-minify-"))
  try {
    const source = `
      export function Adapter(first, second, unused) { return [Adapter.name, Adapter.length, first + second] }
      export class Provider { read(first, second, unused) { return [Provider.name, this.read.length, first + second] } }
      export const inferred = (first, unused) => first
      export function directEval(value) { const local = value + 1; return eval("local") }
      export function worker(first, second, unused) { return first + second }
      export const serialized = worker.toString()
    `
    const result = await minifyApplication(source, directory)
    const original = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))
    const packed = await import("data:text/javascript;base64," + Buffer.from(result.code).toString("base64"))
    assert.ok(result.code.length < source.length)
    assert.equal(result.reused, false)
    for (const module of [original, packed]) {
      assert.deepEqual(module.Adapter(2, 3), ["Adapter", 3, 5])
      assert.deepEqual(new module.Provider().read(2, 3), ["Provider", 3, 5])
      assert.equal(module.inferred.name, "inferred")
      assert.equal(module.inferred.length, 2)
      assert.equal(module.directEval(5), 6)
      const worker = Function("return (" + module.serialized + ")")()
      assert.equal(worker.name, "worker")
      assert.equal(worker.length, 3)
      assert.equal(worker(2, 3), 5)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("application minification caches exact inputs and replaces incomplete output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone-minify-cache-"))
  try {
    const first = await minifyApplication("export const answer = 40 + 2", directory)
    const saved = await readFile(join(directory, "application.json"), "utf8")
    const second = await minifyApplication("export const answer = 40 + 2", directory)
    assert.equal(second.reused, true)
    assert.equal(second.code, first.code)
    assert.equal(await readFile(join(directory, "application.json"), "utf8"), saved)
    await writeFile(join(directory, "application.mjs"), "incomplete")
    const restored = await minifyApplication("export const answer = 40 + 2", directory)
    assert.equal(restored.reused, false)
    assert.equal(restored.code, first.code)
    const changed = await minifyApplication("export const answer = 40 + 3", directory)
    assert.equal(changed.reused, false)
    assert.notEqual(changed.key, first.key)
    assert.match(changed.code, /43/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
