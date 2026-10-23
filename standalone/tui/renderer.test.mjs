import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { createComputationalRenderer } from "./renderer.mjs"
import { rendererWasmBase64 } from "./renderer-wasm.mjs"
import { sceneFixture, rendererTrace } from "./renderer-fixtures.mjs"
import { bundleRenderer } from "./renderer-bundle.mjs"

for (const width of [44, 100]) {
  test(`real Yoga layout, Box/Text painting and Unicode cell storage at ${width} columns`, () => {
    const trace = rendererTrace(createComputationalRenderer, width)
    assert.deepEqual(trace.exceptions, [0, 1, 2, 1, 4], "real C++ bad_alloc and logic_error throw/catch")
    assert.equal(trace.measured[0].width, width)
    assert.equal(trace.measured[1].width, width / 2)
    assert.equal(trace.measured[1].height, 6)
    assert.equal(trace.measured[2].width, width / 2)
    assert.equal(trace.measured[3].width, width / 2 - 2)
    assert.equal(trace.measured[3].height, width === 44 ? 2 : 1)
    assert.equal(trace.first.width, width)
    assert.equal(trace.first.chars.length, width * 8)
    assert.equal(trace.first.chars[0], 0x250c)
    assert.deepEqual(trace.first.foreground[0], [0, 170, 255, 255])
    assert.match(trace.first.text, /Yoga/)
    assert.match(trace.first.text, /한국어 é 👩🏽‍💻/u)
    assert.ok(trace.first.chars.some((cell) => (cell >>> 30) === 2), "upstream grapheme pool encoding")
    assert.ok(trace.first.chars.some((cell) => (cell >>> 30) === 3), "upstream wide-cell continuation encoding")
    assert.ok(trace.first.attributes.some((attributes) => (attributes & 1) === 1))
    assert.match(trace.changed.text, /replaced/)
    assert.doesNotMatch(trace.changed.text, /OpenTUI renderer/)
    assert.equal(trace.resized.width, width === 44 ? 100 : 44)
    assert.match(trace.recreated.text, /new generation/)
    assert.doesNotMatch(trace.recreated.text, /replaced/)
  })
}

test("upstream errors preserve checked handles, session identity and failed-mutation state", () => {
  const renderer = createComputationalRenderer()
  try {
    const nodes = sceneFixture(renderer, 44)
    assert.throws(() => renderer.setText(nodes.box, "wrong kind"), { code: "WrongKind" })
    assert.throws(() => renderer.setText({ ...nodes.text, context: "18446744073709551615" }, "foreign"), { code: "WrongContext" })
    assert.throws(() => renderer.setStyle(nodes.box, { group: 0, kind: 9, value: 99 }), { code: "InvalidOptions" })
    const other = renderer.createSession(12, 4)
    const root = renderer.createNode(other, "root", 10)
    assert.throws(() => renderer.move(nodes.text, root), { code: "WrongSession" })
    assert.throws(() => renderer.request({ create_node: { session: nodes.session, kind: 8, num: 20 } }), { code: "UnsupportedResource" })
    assert.throws(() => renderer.request({ setup_terminal: {} }))
    renderer.destroyNode(nodes.text)
    const replacement = renderer.createNode(nodes.session, "text", 11)
    assert.equal(replacement.slot, nodes.text.slot)
    assert.ok(replacement.generation > nodes.text.generation)
    assert.throws(() => renderer.setText(nodes.text, "stale"), { code: "StaleHandle" })
    assert.match(renderer.capture(nodes.session).text, /Yoga/)
  } finally {
    renderer.close()
  }
  assert.throws(() => renderer.capture({}), /closed/)
})

test("invalid allocation bounds and dimensions fail instead of reporting supported output", () => {
  assert.throws(() => createComputationalRenderer({ render_cells_max: 16385 }), { code: "ProofLimit" })
  const renderer = createComputationalRenderer()
  try {
    assert.throws(() => renderer.createSession(0, 8), { code: "InvalidDimensions" })
    assert.throws(() => renderer.createSession(200, 200), { code: "InvalidDimensions" })
    const session = renderer.createSession(12, 4)
    const root = renderer.createNode(session, "root", 1)
    assert.throws(() => renderer.setText(root, "a".repeat(70_000)), /64 KiB/)
  } finally {
    renderer.close()
  }
})

test("context object budget uses upstream checked ObjectLimit errors", () => {
  const renderer = createComputationalRenderer({ object_capacity: 3 })
  try {
    const session = renderer.createSession(12, 4)
    const root = renderer.createNode(session, "root", 1)
    const box = renderer.createNode(session, "box", 2)
    assert.throws(() => renderer.createNode(session, "text", 3), { code: "ObjectLimit" })
    renderer.move(box, root)
    assert.throws(() => renderer.capture(session), { code: "ObjectLimit" })
    renderer.destroyNode(box)
    assert.equal(renderer.capture(session).chars.length, 48)
  } finally {
    renderer.close()
  }
})

test("embedded reactor has only explicit WASI imports", () => {
  const module = new WebAssembly.Module(Buffer.from(rendererWasmBase64, "base64"))
  const imports = WebAssembly.Module.imports(module)
  assert.ok(imports.every((entry) => entry.module === "wasi_snapshot_preview1"), JSON.stringify(imports))
  assert.ok(WebAssembly.Module.exports(module).some((entry) => entry.name === "rendererCall"))
})

test("one-file real renderer executes in an empty directory with native addons disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opentui-renderer-"))
  try {
    await bundleRenderer(join(directory, "demo.mjs"))
    const result = spawnSync(process.execPath, ["--no-addons", "demo.mjs"], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: "", HOME: directory, NODE_OPTIONS: "" },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /OpenTUI WASM \/ Yoga/)
    assert.match(result.stdout, /한국어, é, 👩🏽‍💻/u)
    assert.match(result.stdout, /Context → Scene → Box\/Text → cell buffer/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
