import assert from "node:assert/strict"

export function checkPublishedTerminalResources(api) {
  const owner = new api.ResourceContext({ objectCapacity: 32, renderCellsMax: 4096 })
  const other = new api.ResourceContext({ objectCapacity: 16, renderCellsMax: 4096 })
  const lib = owner.renderLib
  const context = owner.context
  const target = api.OptimizedBuffer.create(32, 4, "unicode", { owner })
  const terminal = lib.createContextEmbeddedTerminal(context, { cols: 32, rows: 4, maxScrollback: 64 * 1024 })
  const foreign = lib.createContextEmbeddedTerminal(other.context, { cols: 20, rows: 4 })
  let destroyed = false
  const text = () => new TextDecoder().decode(target.getRealCharBytes(true))
  const compose = (x = 0, y = 0) => lib.contextEmbeddedTerminalCompose({ context, target: target._getSceneHandle(owner), frame: null }, terminal, x, y)
  const write = (data) => lib.contextEmbeddedTerminalWrite(context, terminal, data)
  const encode = (options) => lib.contextEmbeddedTerminalEncodeKey(context, terminal, options)
  try {
    assert.throws(() => lib.createContextEmbeddedTerminal(context, { cols: 0, rows: 4 }), RangeError)
    assert.throws(() => lib.contextEmbeddedTerminalResize(context, terminal, 65536, 4), RangeError)
    assert.throws(() => lib.contextEmbeddedTerminalWrite(context, foreign, "x"), native(api.NativeStatus.WrongContext))
    const invalid = { ...terminal, slot: 0xffffffff }
    assert.throws(() => lib.contextEmbeddedTerminalWrite(context, invalid, "x"), native(api.NativeStatus.StaleHandle))
    write("hello 한국어 é 👩🏽‍💻")
    compose()
    assert.match(text(), /hello 한국어 é 👩🏽‍💻/u)
    lib.contextEmbeddedTerminalSetSelection(context, terminal, { x: 1, y: 0 }, { x: 3, y: 0 })
    const selected = lib.contextEmbeddedTerminalGetSelectedText(context, terminal)
    assert.equal(Buffer.from(selected).toString(), "ell")
    compose()
    target.withBuffers((cells) => {
      assert.notDeepEqual(Array.from(cells.fg.subarray(0, 4)), Array.from(cells.fg.subarray(4, 8)), "native selection must change painted colors")
    })
    lib.contextEmbeddedTerminalClearSelection(context, terminal)
    assert.equal(lib.contextEmbeddedTerminalGetSelectedText(context, terminal).length, 0)

    write("\x1bc\x1b]4;1;#1256ab\x1b\\\x1b[1;31mRGB\x1b[0m")
    compose()
    target.withBuffers((cells) => {
      assert.deepEqual(Array.from(cells.fg.subarray(0, 4)), Array.from(api.RGBA.fromInts(0x12, 0x56, 0xab).buffer))
      assert.equal(cells.attributes[0] & 1, 1, "actual SGR bold must reach the OpenTUI buffer")
    })
    write("\x1b]10;rgb:12/34/56\x07\x1b[2;3H\x1b[5 q")
    compose()
    assert.deepEqual(lib.contextEmbeddedTerminalCursor(context, terminal), {
      x: 2, y: 1, hasValue: true, visible: true, blinking: true, wideTail: false, style: "bar", color: { r: 0x12, g: 0x34, b: 0x56 },
    })

    write("\x1bc\x1b]11;rgb:ff/00/00\x1b\\a\x1b[41mX")
    compose()
    const opaque = colors(target, 0)
    const explicit = colors(target, 1)
    lib.contextEmbeddedTerminalSetTransparentBackground(context, terminal, true)
    compose()
    assert.notDeepEqual(colors(target, 0).bg, opaque.bg, "default-background intent must survive the native compositor")
    assert.deepEqual(colors(target, 1).bg, explicit.bg, "an explicit SGR background must remain opaque")
    lib.contextEmbeddedTerminalSetTransparentBackground(context, terminal, false)

    write("\x1bc\x1b[?20")
    write("04h\x1b[?1004h\x1b[?1003h\x1b[?1006h")
    assert.equal(Buffer.from(lib.contextEmbeddedTerminalEncodePaste(context, terminal, Buffer.from("one\ntwo"))).toString(), "\x1b[200~one\ntwo\x1b[201~")
    assert.equal(Buffer.from(lib.contextEmbeddedTerminalEncodeFocus(context, terminal, true)).toString(), "\x1b[I")
    assert.equal(Buffer.from(lib.contextEmbeddedTerminalEncodeFocus(context, terminal, false)).toString(), "\x1b[O")
    assert.equal(Buffer.from(encode({ key: "Enter" })).toString(), "\r")
    assert.equal(Buffer.from(encode({ key: "KeyC", text: "c", mods: 2, unshiftedCodepoint: 99 })).toString(), "\x03")
    const mouse = { action: "motion", x: 2, y: 1 }
    assert.equal(Buffer.from(lib.contextEmbeddedTerminalEncodeMouse(context, terminal, mouse)).toString(), "\x1b[<35;3;2M")
    assert.equal(lib.contextEmbeddedTerminalEncodeMouse(context, terminal, mouse).length, 0)
    lib.contextEmbeddedTerminalResize(context, terminal, 20, 4)
    assert.ok(lib.contextEmbeddedTerminalEncodeMouse(context, terminal, mouse).length > 0, "resizing must reset native mouse-motion deduplication")
    assert.throws(() => lib.contextEmbeddedTerminalEncodeMouse(context, terminal, { ...mouse, x: Infinity }), RangeError)
    assert.throws(() => encode({ action: "unknown" }), TypeError)
    assert.throws(() => encode({ composing: 1 }), TypeError)
    assert.throws(() => encode({ mods: 64 }), native(api.NativeStatus.InvalidArgument))
    write("\x1b[>3u")
    assert.equal(Buffer.from(encode({ action: "release", key: "KeyA", unshiftedCodepoint: 97 })).toString(), "\x1b[97;1:3u")
    write("\x1b[<u")
    assert.equal(Buffer.from(encode({ text: "x".repeat(2048) })).toString(), "x".repeat(2048))
    assert.equal(Buffer.from(selected).toString(), "ell", "returned bytes must own their storage across later reactor calls")
    write("\x1b[5n")
    assert.equal(Buffer.from(lib.contextEmbeddedTerminalDrainResponses(context, terminal)).toString(), "\x1b[0n")
    assert.equal(lib.contextEmbeddedTerminalDrainResponses(context, terminal).length, 0)
    write("\x1b]10;#123456\x1b\\\x1b]10;?\x07")
    assert.equal(Buffer.from(lib.contextEmbeddedTerminalDrainResponses(context, terminal)).toString(), "\x1b]10;rgb:1212/3434/5656\x07")
    // The native response queue is exactly 1 MiB. Its one overflow indication
    // must preserve the accepted prefix for the original host's single retry.
    write("\x1b[5n".repeat(1024 * 1024 / 4 + 1))
    const boundedResponses = lib.contextEmbeddedTerminalDrainResponses(context, terminal)
    assert.equal(boundedResponses.byteLength, 1024 * 1024)
    assert.equal(Buffer.from(boundedResponses.subarray(0, 4)).toString(), "\x1b[0n")
    assert.equal(Buffer.from(boundedResponses.subarray(-4)).toString(), "\x1b[0n")
    assert.equal(lib.contextEmbeddedTerminalDrainResponses(context, terminal).length, 0)

    write("\x1bc" + Array.from({ length: 20 }, (_, index) => `line-${String(index).padStart(2, "0")}`).join("\r\n"))
    compose()
    assert.match(text(), /line-19/)
    lib.contextEmbeddedTerminalScroll(context, terminal, -3)
    compose()
    assert.match(text(), /line-13/)
    assert.doesNotMatch(text(), /line-19/)
    lib.contextEmbeddedTerminalScroll(context, terminal, 1000)
    compose()
    assert.match(text(), /line-19/)

    write("\x1bc")
    const boundary = new Uint8Array(1024 * 1024 + 8)
    boundary.set([27, 91], 1024 * 1024 - 2)
    boundary.set(Buffer.from("31m끝"), 1024 * 1024)
    write(boundary)
    compose()
    assert.match(text(), /끝/u, "the original 1 MiB write split must retain native parser state")
    const oversizedPaste = new Uint8Array(1024 * 1024 + 1)
    assert.throws(() => lib.contextEmbeddedTerminalEncodePaste(context, terminal, oversizedPaste), native(api.NativeStatus.InvalidArgument))
    target.clear(api.RGBA.fromInts(5, 6, 7))
    lib.contextEmbeddedTerminalInvalidate(context, terminal)
    compose(-1, 1)
    assert.doesNotMatch(text(), /끝/u, "a clipped wide grapheme must not leave half a cell")
    lib.contextEmbeddedTerminalInvalidate(context, terminal)
    compose()
    assert.match(text(), /끝/u)
    lib.destroyContextEmbeddedTerminal(context, terminal)
    destroyed = true
    assert.throws(() => write("after destroy"), native(api.NativeStatus.StaleHandle))
    const replacement = lib.createContextEmbeddedTerminal(context, { cols: 2, rows: 2, maxScrollback: 0 })
    lib.contextEmbeddedTerminalWrite(context, replacement, "ok")
    lib.destroyContextEmbeddedTerminal(context, replacement)
    return { realGhostty: true, ownedBytes: true, parserChunks: true, selection: true, palette: true, inputModes: true, scrollback: true, checkedLifetime: true }
  } finally {
    if (!destroyed) lib.destroyContextEmbeddedTerminal(context, terminal)
    lib.destroyContextEmbeddedTerminal(other.context, foreign)
    target.destroy()
    other.destroy()
    owner.destroy()
  }

  function native(status) { return (error) => error instanceof api.NativeError && error.status === status }
}

export async function checkPublishedTerminalScene(api, width) {
  const setup = await api.createTestRenderer({ width, height: 9, kittyKeyboard: true, useMouse: true, exitSignals: [], openConsoleOnError: false })
  const failures = []
  const data = []
  const sizes = []
  let changes = 0
  setup.renderer.on(api.CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  const box = new api.BoxRenderable(setup.renderer, { width: "100%", height: 8, overflow: "hidden", backgroundColor: "#203040" })
  const terminal = new api.EmbeddedTerminalRenderable(setup.renderer, {
    position: "absolute", left: 2, top: 1, width: width - 4, height: 5, maxScrollback: 64 * 1024,
    onData: (bytes, source) => data.push({ bytes, source }), onTerminalResize: (cols, rows) => sizes.push({ cols, rows }),
    onScreenChange: () => { changes++ },
  })
  try {
    setup.renderer.root.add(box)
    box.add(terminal)
    terminal.write("\x1b]4;1;#1256ab\x1b\\\x1b[1;31mRGB 한국어 é 👩🏽‍💻\x1b[0m\r\nactual embedded terminal")
    assert.equal(changes, 0, "screen-change callbacks follow actual composition")
    await frame()
    assert.match(terminal.screen().text, /RGB 한국어 é 👩🏽‍💻/u)
    assert.match(setup.captureCharFrame(), /actual embedded terminal/)
    assert.equal(terminal.screen().columns, width - 4)
    assert.equal(terminal.screen().rows, 5)
    assert.ok(changes > 0)
    setup.renderer.currentRenderBuffer.withBuffers((cells) => {
      const index = Math.trunc(terminal.y) * width + Math.trunc(terminal.x)
      assert.deepEqual(Array.from(cells.fg.subarray(index * 4, index * 4 + 4)), Array.from(api.RGBA.fromInts(0x12, 0x56, 0xab).buffer))
      assert.equal(cells.attributes[index] & 1, 1)
    })
    const selection = new api.Selection(terminal, { x: terminal.x, y: terminal.y }, { x: terminal.x + 2, y: terminal.y })
    assert.equal(terminal.onSelectionChanged(selection), true)
    assert.equal(terminal.getSelectedText(), "RGB")
    await frame()
    terminal.onSelectionChanged(null)
    assert.equal(terminal.hasSelection(), false)
    assert.equal(terminal.getSelectedText(), "")
    assert.equal(terminal.shouldStartSelection(terminal.x, terminal.y), true)
    assert.equal(terminal.shouldStartSelection(terminal.x - 1, terminal.y), false)

    terminal.write("\x1b[?1004h\x1b[?2004h")
    data.length = 0
    terminal.focus()
    assert.equal(setup.renderer.currentFocusedRenderable, terminal)
    assert.equal(input(), "\x1b[I")
    data.length = 0
    await setup.mockInput.typeText("x한글")
    setup.mockInput.pressEnter()
    await setup.mockInput.pasteBracketedText("one\ntwo")
    assert.equal(input(), "x한글\r\x1b[200~one\ntwo\x1b[201~")
    terminal.write("\x1b[5n")
    assert.equal(Buffer.concat(data.filter((event) => event.source === "response").map((event) => event.bytes)).toString(), "\x1b[0n")
    data.length = 0
    terminal.blur()
    assert.equal(input(), "\x1b[O")
    terminal.write("\x1b[?1000h\x1b[?1006h")
    await frame()
    data.length = 0
    await setup.mockMouse.click(terminal.x + 2, terminal.y + 1)
    assert.equal(setup.renderer.currentFocusedRenderable, terminal)
    assert.match(input(), /\x1b\[<0;3;2M/)
    terminal.write("\x1b[?1000l\x1b[?1006l")

    terminal.write("\x1bc" + Array.from({ length: 20 }, (_, index) => `screen-${String(index).padStart(2, "0")}`).join("\r\n"))
    await frame()
    assert.match(terminal.screen().text, /screen-19/)
    await setup.mockMouse.scroll(terminal.x + 2, terminal.y + 1, "up")
    await frame()
    assert.doesNotMatch(terminal.screen().text, /screen-19/)
    await setup.mockMouse.scroll(terminal.x + 2, terminal.y + 1, "down")
    await frame()
    assert.match(terminal.screen().text, /screen-19/)

    const nextWidth = width === 44 ? 100 : 44
    setup.resize(nextWidth, 9)
    terminal.width = nextWidth - 4
    await frame()
    assert.equal(terminal.screen().columns, nextWidth - 4)
    assert.ok(sizes.some((size) => size.cols === nextWidth - 4 && size.rows === 5))
    terminal.write("\x1bc\x1b]10;#123456\x1b\\\x1b[2;3H\x1b[5 qcursor 한국어")
    await frame()
    const first = setup.captureCharFrame()
    assert.match(first, /cursor 한국어/u)
    const localCursor = terminal.screen().cursor
    const cursor = setup.renderer.getCursorState()
    assert.equal(cursor.x, terminal.x + localCursor.x + 1)
    assert.equal(cursor.y, terminal.y + localCursor.y + 1)
    assert.equal(cursor.visible, true)
    assert.equal(cursor.style, "line")
    assert.equal(cursor.blinking, true)
    assert.deepEqual(Array.from(cursor.color.buffer), Array.from(api.RGBA.fromInts(0x12, 0x34, 0x56).buffer))
    await frame()
    assert.equal(setup.captureCharFrame(), first, "clean terminal rows must survive a later native Scene frame")
    terminal.blur()
    await frame()
    assert.equal(setup.renderer.getCursorState().visible, false)
    terminal.focus()
    await frame()
    assert.equal(setup.renderer.getCursorState().visible, true)
    terminal.renderAfter = (buffer) => buffer.drawText("!", terminal.width - 1, 4, api.RGBA.fromInts(255, 255, 255))
    await frame()
    assert.match(terminal.screen().text, /!/)
    terminal.renderAfter = undefined
    terminal.invalidate()
    await frame()
    assert.doesNotMatch(terminal.screen().text, /!/)

    // Moving an oversized retained terminal outside its parent exercises the
    // real host-paint frame ticket and the native viewport clip together.
    terminal.width = nextWidth + 8
    terminal.left = -4
    terminal.write("\x1bcHIDEVISIBLE")
    await frame()
    const clipped = setup.captureCharFrame().split("\n")[1]
    assert.match(clipped, /^VISIBLE/)
    assert.doesNotMatch(clipped, /HIDE/)
    assert.ok(setup.getNativeStats().nativeFrameCount >= 8)
    terminal.destroy()
    assert.equal(terminal.isDestroyed, true)
    assert.equal(terminal.encodePaste(Buffer.from("after destroy")).length, 0)
    assert.doesNotThrow(() => terminal.write("after destroy"))
    return { width, nativeScene: true, unicode: true, selection: true, parsedInput: true, mouse: true, scrollback: true, resized: true, clipped: true, destroyed: true }
  } finally {
    await setup.dispose()
  }

  function input() { return Buffer.concat(data.filter((event) => event.source === "input").map((event) => event.bytes)).toString() }
  async function frame() {
    await setup.renderOnce()
    if (failures.length) throw failures[0]
  }
}

function colors(buffer, index) {
  return buffer.withBuffers((cells) => ({ fg: Array.from(cells.fg.subarray(index * 4, index * 4 + 4)), bg: Array.from(cells.bg.subarray(index * 4, index * 4 + 4)) }))
}
