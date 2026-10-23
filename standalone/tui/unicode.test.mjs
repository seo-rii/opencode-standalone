import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createUnicode } from "./unicode.mjs"
import { wasmBase64 } from "./unicode-wasm.mjs"
import { bundleDemo } from "./bundle-demo.mjs"

test("embedded upstream computation has no imported runtime dependencies", () => {
  const module = new WebAssembly.Module(Buffer.from(wasmBase64, "base64"))
  assert.deepEqual(WebAssembly.Module.imports(module), [])
})

test("OpenTUI measures Hangul, combining marks, flags, and joined emoji", () => {
  const unicode = createUnicode()
  for (const [text, columns] of [["", 0], ["OpenCode", 8], ["한국어", 6], ["e\u0301", 1], ["🇰🇷", 2], ["👩🏽‍💻", 2], ["👨‍👩‍👧‍👦", 2]]) {
    assert.equal(unicode.width(text), columns, text)
  }
  assert.equal(unicode.width("\x00A"), 1)
  assert.equal(unicode.width("\x00A", { controlDisplay: "notation" }), 3)
  assert.equal(unicode.width("a\tb", { tabWidth: 8 }), 10)
})

test("wrap boundaries preserve complete UTF-8 graphemes", () => {
  const unicode = createUnicode()
  assert.deepEqual(unicode.wrap("a👩🏽‍💻b", 2), {
    byteOffset: 1, graphemeCount: 1, columnsUsed: 1, text: "a", remainder: "👩🏽‍💻b",
  })
  assert.deepEqual(unicode.wrap("한국어", 3), {
    byteOffset: 3, graphemeCount: 1, columnsUsed: 2, text: "한", remainder: "국어",
  })
  assert.equal(unicode.wrap("e\u0301x", 1).text, "e\u0301")
  assert.equal(unicode.wrap("👨‍👩‍👧‍👦x", 2).text, "👨‍👩‍👧‍👦")
  assert.equal(unicode.wrap("한국어", 0).byteOffset, 0)
})

test("the JS boundary rejects values that cannot cross the WASM ABI", () => {
  const unicode = createUnicode()
  assert.throws(() => unicode.width(null), TypeError)
  assert.throws(() => unicode.width("text", { method: "unknown" }), RangeError)
  assert.throws(() => unicode.width("text", { tabWidth: 256 }), RangeError)
  assert.throws(() => unicode.width("text", { controlDisplay: "unknown" }), RangeError)
  assert.throws(() => unicode.wrap("text", -1), RangeError)
  assert.throws(() => unicode.width("a".repeat(1024 * 1024 + 1)), RangeError)
  assert.equal(unicode.width("after rejection"), 15)
})

test("the generated single-file proof runs with no packages or command PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opentui-wasm-"))
  try {
    const destination = join(directory, "proof.mjs")
    await bundleDemo(destination)
    const result = spawnSync(process.execPath, [destination], {
      cwd: directory,
      env: { PATH: join(directory, "missing"), HOME: directory, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 10_000,
    })
    assert.equal(result.stderr, "")
    assert.equal(result.status, 0)
    assert.match(result.stdout, /OpenTUI Unicode WASM proof/)
    assert.match(result.stdout, /한국어와 English/)
    assert.match(result.stdout, /👩🏽‍💻 개발자/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

