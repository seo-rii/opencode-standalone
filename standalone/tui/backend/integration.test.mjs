import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Writable } from "node:stream"
import { test } from "node:test"
import { bundleBackend } from "./build.mjs"

const artifact = await bundleBackend(fileURLToPath(new URL("../.cache/backend/integration.mjs", import.meta.url)))
const { BoxRenderable, TextRenderable, TextareaRenderable, InputRenderable, ScrollBoxRenderable, OptimizedBuffer, Renderable, SyntaxStyle, StyledText, RGBA, NativeSession, CliRenderEvents, NativeError, NativeStatus, createTestRenderer } = await import(pathToFileURL(artifact))

for (const width of [44, 100]) {
  test(`actual published createTestRenderer with Box/Text at ${width} columns`, { timeout: 30_000 }, async () => {
    const setup = await createTestRenderer({ width, height: 8, useMouse: false, exitSignals: [], openConsoleOnError: false })
    const failures = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
    try {
      const box = new BoxRenderable(setup.renderer, { id: "actual-box", width: "50%", height: 6, border: true, borderColor: "#00aaff", title: " Yoga " })
      const peer = new BoxRenderable(setup.renderer, { id: "actual-peer", flexGrow: 1, backgroundColor: "#182030" })
      const text = new TextRenderable(setup.renderer, { id: "actual-text", content: "한국어 é 👩🏽‍💻\nOpenTUI actual classes", fg: "#f0e6dc", attributes: 1 })
      setup.renderer.root.add(box)
      setup.renderer.root.add(peer)
      box.add(text)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      const frame = setup.captureCharFrame()
      assert.match(frame, /^┌/)
      assert.match(frame, /Yoga/)
      assert.match(frame, /한국어 é 👩🏽‍💻/u)
      assert.equal(box.width, width / 2)
      assert.ok(setup.getNativeStats().nativeFrameCount >= 1)
      let borrowed
      setup.renderer.currentRenderBuffer.withBuffers((cells) => {
        borrowed = cells
        assert.equal(cells.char.length, width * 8)
        assert.equal(cells.fg.length, width * 8 * 4)
        assert.equal(cells.attributes.length, width * 8)
        cells.char[0] = "X".codePointAt(0)
      })
      assert.throws(() => borrowed.char, /scope has ended/)
      assert.match(setup.captureCharFrame(), /^X/, "typed views must alias actual WASM cell storage")
      text.content = "after update 日本語"
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.match(setup.captureCharFrame(), /after update 日本語/u)
      assert.doesNotMatch(setup.captureCharFrame(), /한국어/u)
      setup.resize(width === 44 ? 100 : 44, 8)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.equal(box.width, (width === 44 ? 100 : 44) / 2)
      assert.match(setup.captureCharFrame(), /after update 日本語/u)
      assert.ok(setup.captureSpans().lines.some((line) => line.spans.some((span) => span.text.includes("Yoga"))))
    } finally {
      await setup.dispose()
    }
  })
}

test("actual StyledText preserves native color lanes, attributes, Unicode and hyperlink ranges", async () => {
  const setup = await createTestRenderer({ width: 44, height: 4, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const failures = []
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  try {
    const content = new StyledText([
      { __isChunk: true, text: "한글 ", fg: RGBA.fromInts(250, 60, 90), attributes: 1 },
      { __isChunk: true, text: "link 👩🏽‍💻", fg: RGBA.fromInts(30, 180, 240), attributes: 4, link: { url: "https://example.com/한국어" } },
    ])
    const text = new TextRenderable(setup.renderer, { content })
    setup.renderer.root.add(text)
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.match(setup.captureCharFrame(), /한글 link 👩🏽‍💻/u)
    assert.equal(text.plainText, "한글 link 👩🏽‍💻")
    setup.renderer.currentRenderBuffer.withBuffers((cells) => {
      assert.equal(cells.attributes[0] & 0xff, 1)
      assert.equal(cells.attributes[5] & 0xff, 4)
      assert.notEqual(cells.attributes[5] >>> 8, 0, "native hyperlink IDs must reach real cell attributes")
      assert.deepEqual(Array.from(cells.fg.slice(0, 4)), Array.from(content.chunks[0].fg.buffer))
      assert.deepEqual(Array.from(cells.fg.slice(5 * 4, 6 * 4)), Array.from(content.chunks[1].fg.buffer))
    })
    const driver = setup.renderer.nativeScene.driver
    const link = driver.renderLib.sessionGetLinkId(driver.context, driver.session, 5, 0)
    assert.ok(link > 0)
    assert.equal(driver.renderLib.contextGetLinkUrl(driver.context, link), "https://example.com/한국어")
  } finally {
    await setup.dispose()
  }
})

for (const width of [44, 100]) {
  test(`actual Textarea edits, selections, history and native callbacks at ${width} columns`, { timeout: 30_000 }, async () => {
    const setup = await createTestRenderer({ width, height: 8, useMouse: false, exitSignals: [], openConsoleOnError: false })
    const failures = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
    try {
      const textarea = new TextareaRenderable(setup.renderer, { width: "100%", height: 5, initialValue: "한국어 é 👩🏽‍💻\nactual editor", placeholder: "placeholder" })
      setup.renderer.root.add(textarea)
      textarea.focus()
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.match(setup.captureCharFrame(), /한국어 é 👩🏽‍💻/u)
      assert.equal(textarea.plainText, "한국어 é 👩🏽‍💻\nactual editor")
      const events = []
      textarea.editBuffer.on("content-changed", () => events.push("content"))
      textarea.editBuffer.on("cursor-changed", () => events.push("cursor"))
      textarea.editBuffer.setText("abc")
      textarea.editBuffer.setCursor(0, 3)
      textarea.editBuffer.insertText("DEF")
      await Promise.resolve()
      assert.equal(textarea.plainText, "abcDEF")
      assert.ok(events.includes("content"), "actual native content callback must reach the published EditBuffer")
      assert.ok(events.includes("cursor"), "actual native cursor callback must reach the published EditBuffer")
      assert.equal(textarea.editBuffer.canUndo(), true)
      textarea.editBuffer.undo()
      assert.equal(textarea.plainText, "abc")
      textarea.editBuffer.redo()
      assert.equal(textarea.plainText, "abcDEF")
      textarea.editorView.setSelection(3, 6)
      assert.equal(textarea.editorView.getSelectedText(), "DEF")
      assert.deepEqual(textarea.editorView._replaceSelectedText("한글"), { deleted: true, inserted: true })
      assert.equal(textarea.plainText, "abc한글")
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.match(setup.captureCharFrame(), /abc한글/u)
      setup.resize(width === 44 ? 100 : 44, 8)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.equal(textarea.width, width === 44 ? 100 : 44)
      assert.match(setup.captureCharFrame(), /abc한글/u)
    } finally {
      await setup.dispose()
    }
  })
}

test("actual native SyntaxStyle registers and resolves Unicode style names", async () => {
  const setup = await createTestRenderer({ width: 44, height: 4, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const style = SyntaxStyle.create(setup.renderer.nativeScene)
  try {
    const id = style.registerStyle("keyword.한국어", { fg: RGBA.fromInts(240, 100, 20), bold: true })
    assert.ok(id > 0)
    style.clearNameCache()
    assert.equal(style.getStyleId("keyword.한국어"), id)
    assert.equal(style.getStyleCount(), 1)
  } finally {
    style.destroy()
    await setup.dispose()
  }
})

test("actual Input receives parsed keyboard bytes and bracketed paste", async () => {
  const setup = await createTestRenderer({ width: 44, height: 4, kittyKeyboard: true, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const failures = []
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  try {
    const input = new InputRenderable(setup.renderer, { width: "100%", value: "", placeholder: "type here" })
    setup.renderer.root.add(input)
    input.focus()
    await setup.mockInput.typeText("abc")
    await setup.mockInput.pasteBracketedText("한\n글")
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.equal(input.value, "abc한글")
    assert.match(setup.captureCharFrame(), /abc한글/u)
    setup.mockInput.pressBackspace()
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.equal(input.value, "abc한")
    const submitted = []
    input.on("enter", (value) => submitted.push(value))
    setup.mockInput.pressEnter()
    await Promise.resolve()
    assert.deepEqual(submitted, ["abc한"])
  } finally {
    await setup.dispose()
  }
})

test("actual NativeSession writes and acknowledges terminal setup, title, suspend, resume and restoration", { timeout: 30_000 }, async () => {
  const chunks = []
  const sink = new Writable({ write(bytes, _encoding, complete) { chunks.push(Buffer.from(bytes)); complete() } })
  const session = new NativeSession(sink)
  try {
    session.attachRenderer({ width: 44, height: 8, environment: { TERM: "xterm-256color" } })
    await session.setupTerminal({ useAlternateScreen: true, mouse: false, mouseMovement: false, kittyKeyboardFlags: 5 })
    session.control({ kind: "title", title: "standalone 한국어" })
    assert.equal(session.write(new TextEncoder().encode("actual native feed")), true)
    await session.idle()
    assert.match(Buffer.concat(chunks).toString("utf8"), /standalone 한국어/u)
    assert.match(Buffer.concat(chunks).toString("utf8"), /actual native feed/)
    await session.suspend()
    await session.resume()
    await session.close()
    assert.equal(session.disposed, true)
    assert.equal(session.contextDisposed, true)
    const output = Buffer.concat(chunks).toString("utf8")
    assert.match(output, /\x1b\[\?1049h/)
    assert.match(output, /\x1b\[\?1049l/)
  } finally {
    if (!session.disposed) session.dispose()
    sink.destroy()
  }
})

test("actual owned OptimizedBuffers draw and compose native Unicode cells with scoped leases", async () => {
  const setup = await createTestRenderer({ width: 44, height: 4, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const source = OptimizedBuffer.create(24, 4, "unicode", { owner: setup.renderer.nativeScene })
  const destination = OptimizedBuffer.create(24, 4, "unicode", { owner: setup.renderer.nativeScene })
  try {
    source.clear(RGBA.fromInts(10, 20, 30))
    source.drawText("한국어 é 👩🏽‍💻", 0, 0, RGBA.fromInts(200, 220, 240))
    destination.drawFrameBuffer(0, 0, source)
    assert.match(new TextDecoder().decode(destination.getRealCharBytes(true)), /한국어 é 👩🏽‍💻/u)
    destination.pushOpacity(0.5)
    assert.equal(destination.getCurrentOpacity(), 0.5)
    destination.popOpacity()
    assert.equal(destination.getCurrentOpacity(), 1)
    let scope
    destination.withBuffers((cells) => { scope = cells; cells.char[0] = "X".codePointAt(0) })
    assert.throws(() => scope.char, /scope has ended/)
    assert.match(new TextDecoder().decode(destination.getRealCharBytes(true)), /^X/)
    destination.resize(32, 5)
    destination.withBuffers((cells) => assert.equal(cells.char.length, 160))
    const encoded = destination.encodeUnicode("é 👩🏽‍💻")
    try {
      let x = 0
      for (const glyph of encoded.data) {
        destination.drawChar(glyph.char, x, 1, RGBA.fromInts(230, 240, 250), RGBA.fromInts(0, 0, 0))
        x += glyph.width
      }
      assert.match(new TextDecoder().decode(destination.getRealCharBytes(true)), /é 👩🏽‍💻/u)
    } finally {
      destination.freeUnicode(encoded)
    }
  } finally {
    destination.destroy()
    source.destroy()
    await setup.dispose()
  }
})

test("actual custom Renderable records host painting and replays it through the native frame", async () => {
  const setup = await createTestRenderer({ width: 44, height: 4, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const failures = []
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  class Painter extends Renderable {
    text = "custom 한국어 é 👩🏽‍💻"
    renderSelf(buffer) { buffer.drawText(this.text, this.x, this.y, RGBA.fromInts(240, 180, 60)) }
  }
  try {
    const painter = new Painter(setup.renderer, { width: "100%", height: 2 })
    setup.renderer.root.add(painter)
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.match(setup.captureCharFrame(), /custom 한국어 é 👩🏽‍💻/u)
    painter.text = "native recording updated"
    painter.requestRender()
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.match(setup.captureCharFrame(), /native recording updated/)
    assert.doesNotMatch(setup.captureCharFrame(), /한국어/u)
  } finally {
    await setup.dispose()
  }
})

for (const width of [44, 100]) {
  test(`actual ScrollBox clips, scrolls and updates native slider/arrow nodes at ${width} columns`, async () => {
    const setup = await createTestRenderer({ width, height: 8, useMouse: true, exitSignals: [], openConsoleOnError: false })
    const failures = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
    try {
      const scroll = new ScrollBoxRenderable(setup.renderer, { width: "100%", height: 6, scrollY: true })
      setup.renderer.root.add(scroll)
      for (let row = 0; row < 12; row++) scroll.add(new TextRenderable(setup.renderer, { id: `row-${row}`, height: 1, content: `row ${String(row).padStart(2, "0")} 한국어` }))
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.match(setup.captureCharFrame(), /row 00 한국어/u)
      assert.doesNotMatch(setup.captureCharFrame(), /row 11/u)
      assert.ok(scroll.scrollHeight > scroll.viewport.height)
      scroll.scrollTo(6)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.equal(scroll.scrollTop, 6)
      assert.match(setup.captureCharFrame(), /row 06 한국어/u)
      assert.match(setup.captureCharFrame(), /row 11 한국어/u)
      assert.doesNotMatch(setup.captureCharFrame(), /row 00/u)
      scroll.scrollTo(0)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.match(setup.captureCharFrame(), /row 00 한국어/u)
    } finally {
      await setup.dispose()
    }
  })
}

test("actual split renderer copies detached snapshots and commits Unicode scrollback", async () => {
  const setup = await createTestRenderer({ width: 44, height: 10, footerHeight: 4, screenMode: "split-footer", externalOutputMode: "capture-stdout", useMouse: false, exitSignals: [], openConsoleOnError: false })
  const failures = []
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  try {
    setup.renderer.root.add(new TextRenderable(setup.renderer, { content: "footer 한국어", height: 1 }))
    setup.renderer.writeToScrollback(({ renderContext, width }) => ({ root: new TextRenderable(renderContext, { content: "committed é 👩🏽‍💻", height: 1 }), width, height: 1, trailingNewline: true }))
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.match(setup.captureCharFrame(), /footer 한국어/u)
    assert.match(setup.externalOutput.takeText(), /committed é 👩🏽‍💻/u)
  } finally {
    await setup.dispose()
  }
})

test("separate real renderer Contexts reject cross-owner handles even when WASM IDs repeat", { timeout: 30_000 }, async () => {
  const first = await createTestRenderer({ width: 44, height: 8, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const second = await createTestRenderer({ width: 44, height: 8, useMouse: false, exitSignals: [], openConsoleOnError: false })
  try {
    const left = first.renderer.root._getSceneHandle(first.renderer.nativeScene)
    const right = second.renderer.root._getSceneHandle(second.renderer.nativeScene)
    assert.equal(left.contextId, right.contextId)
    assert.notEqual(left.context, right.context)
    const lib = first.renderer.nativeScene.driver.renderLib
    assert.throws(() => lib.sceneMoveNode(right.context, left, right, 0), (error) => error instanceof NativeError && error.status === NativeStatus.WrongContext)
  } finally {
    await Promise.all([first.dispose(), second.dispose()])
  }
})

test("copied one-file package renders actual classes with PATH empty and native addons disabled", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "opentui-real-factory-"))
  try {
    await copyFile(artifact, join(directory, "core.mjs"))
    const result = spawnSync(process.execPath, ["--no-addons", "--input-type=module", "--eval", `
      import { createTestRenderer, BoxRenderable, TextRenderable } from './core.mjs'
      const setup = await createTestRenderer({ width: 44, height: 8, useMouse: false, exitSignals: [], openConsoleOnError: false })
      try {
        const box = new BoxRenderable(setup.renderer, { width: '100%', height: 6, border: true, title: ' Actual JS classes ' })
        const text = new TextRenderable(setup.renderer, { content: '한국어 é 👩🏽‍💻' })
        setup.renderer.root.add(box)
        box.add(text)
        await setup.renderOnce()
        process.stdout.write(setup.captureCharFrame())
      } finally {
        await setup.dispose()
      }
    `], { cwd: directory, encoding: "utf8", env: { PATH: "", HOME: directory, NODE_OPTIONS: "" }, timeout: 20_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Actual JS classes/)
    assert.match(result.stdout, /한국어 é 👩🏽‍💻/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
