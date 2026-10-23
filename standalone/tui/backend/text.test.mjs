import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { adaptPublishedParserSource, standaloneParserPlugin } from "../parser/build.mjs"
import { bundleBackend } from "./build.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const artifact = await bundleBackend(join(directory, "../.cache/backend/text-core.mjs"), { transform: adaptPublishedParserSource, plugins: [await standaloneParserPlugin()] })
const { ResourceContext, TextBuffer, TextBufferView, SyntaxStyle, StyledText, RGBA, NativeError, NativeStatus, CodeRenderable, MarkdownRenderable, TreeSitterClient, CliRenderEvents, createTestRenderer } = await import(pathToFileURL(artifact))

test("actual shared TextBuffer copies Unicode, snaps grapheme ranges and destroys dependent views", () => {
  const owner = new ResourceContext({ objectCapacity: 256, renderCellsMax: 4096 })
  const peer = new ResourceContext({ objectCapacity: 256, renderCellsMax: 4096 })
  try {
    const buffer = TextBuffer.create("unicode", owner)
    const view = TextBufferView.create(buffer)
    const handle = buffer._getSceneHandle(owner)
    const viewHandle = view._getSceneHandle(owner)
    const content = "a한👩🏽‍💻b\nxyz"
    buffer.setText(content)
    assert.equal(buffer.getPlainText(), content)
    assert.equal(buffer.byteSize, Buffer.byteLength(content))
    assert.equal(buffer.length, 9)
    assert.equal(buffer.getLineCount(), 2)
    assert.equal(buffer.getTextRange(2, 3), "한")
    assert.equal(buffer.getTextRange(4, 5), "👩🏽‍💻")
    assert.equal(buffer.getTextRange(0, 0), "")
    buffer.append("\nnext")
    assert.equal(buffer.getPlainText(), content + "\nnext")
    assert.equal(buffer.getLineCount(), 3)
    buffer.setText("\tx")
    buffer.setTabWidth(8)
    assert.equal(buffer.getTabWidth(), 8)
    assert.equal(buffer.length, 9)
    assert.throws(() => buffer.setTabWidth(256), (error) => error instanceof NativeError && error.status === NativeStatus.InvalidArgument)
    assert.throws(() => owner.renderLib.contextTextBufferSetText(owner.context, handle, new Uint8Array([255])), (error) => error instanceof NativeError)
    assert.equal(buffer.getPlainText(), "\tx", "rejected text must leave the real resource unchanged")
    assert.throws(() => owner.renderLib.contextTextBufferGetInfo(peer.context, handle), (error) => error instanceof NativeError && error.status === NativeStatus.WrongContext)
    buffer.destroy()
    assert.throws(() => owner.renderLib.contextTextBufferViewGetInfo(owner.context, viewHandle), (error) => error instanceof NativeError && error.status === NativeStatus.StaleHandle)
    assert.throws(() => view.getPlainText(), /destroyed/)
    view.destroy()
  } finally {
    peer.destroy()
    owner.destroy()
  }
})

test("actual shared views wrap, select, highlight and atomically replace copied styled text", () => {
  const owner = new ResourceContext({ objectCapacity: 256, renderCellsMax: 4096 })
  try {
    const first = TextBuffer.create("unicode", owner)
    const second = TextBuffer.create("unicode", owner)
    const firstView = TextBufferView.create(first)
    const secondView = TextBufferView.create(second)
    first.setText("one two three\nsecond")
    second.setText("unchanged")
    firstView.setWrapMode("word")
    firstView.setViewportSize(8, 4)
    assert.ok(firstView.getVirtualLineCount() > first.getLineCount())
    assert.ok(firstView.lineInfo.lineWidthCols.every((width) => width <= 8))
    assert.equal(firstView.logicalLineInfo.lineSources.length, firstView.getVirtualLineCount())
    assert.equal(firstView.getLineSources(1, 1).length, 1)
    assert.equal(firstView.measureForDimensions(8, 4).lineCount, firstView.getVirtualLineCount())
    firstView.setSelection(0, 3)
    assert.equal(firstView.getSelectedText(), "one")
    firstView.setSelectionOccupancy("boundary")
    assert.equal(firstView.getSelectionOccupancy(), "boundary")
    firstView.resetSelection()
    assert.equal(firstView.hasSelection(), false)

    const style = SyntaxStyle.fromStyles({ number: { fg: RGBA.fromInts(10, 180, 90), bold: true } }, owner)
    first.setSyntaxStyle(style)
    const styleId = style.getStyleId("number")
    first.addHighlight(0, { start: 0, end: 3, styleId, priority: 2, hlRef: 19 })
    assert.deepEqual(first.getLineHighlights(0), [{ start: 0, end: 3, styleId, priority: 2, hlRef: 19 }])
    first.removeHighlightsByRef(19)
    assert.equal(first.getHighlightCount(), 0)
    first.setSyntaxStyle(null)
    style.destroy()

    const firstText = new StyledText([
      { __isChunk: true, text: "", fg: RGBA.fromInts(255, 0, 0) },
      { __isChunk: true, text: "첫째 👩🏽‍💻", fg: RGBA.fromInts(50, 190, 240), attributes: 1, link: { url: "https://example.com/first" } },
    ])
    const secondText = new StyledText([{ __isChunk: true, text: "둘째", fg: RGBA.fromInts(240, 160, 50), attributes: 4, link: { url: "https://example.com/second" } }])
    let beforeCalls = 0
    assert.equal(TextBuffer._replaceStyledTextBatch([
      { textBuffer: first, textBufferView: firstView, text: owner.renderLib.encodeTextBufferStyledText(firstText) },
      { textBuffer: second, textBufferView: secondView, text: owner.renderLib.encodeTextBufferStyledText(secondText) },
    ], () => { beforeCalls++ }), true)
    assert.equal(beforeCalls, 1)
    assert.equal(first.getPlainText(), "첫째 👩🏽‍💻")
    assert.equal(second.getPlainText(), "둘째")
    assert.equal(first.byteSize, Buffer.byteLength("첫째 👩🏽‍💻"))
    assert.equal(firstView.getSelection(), null)
    assert.ok(first.getLineHighlights(0).length > 0)

    const snapshot = [first.getPlainText(), second.getPlainText()]
    const replacement = { buffer: first._getSceneHandle(owner), view: firstView._getSceneHandle(owner), text: owner.renderLib.encodeTextBufferStyledText(secondText) }
    assert.throws(() => owner.renderLib.contextTextBufferReplaceStyledBatch(owner.context, [replacement, replacement], () => {}), (error) => error instanceof NativeError)
    assert.deepEqual([first.getPlainText(), second.getPlainText()], snapshot, "a rejected duplicate batch must preserve every real text resource")
    firstView.destroy()
    secondView.destroy()
    first.destroy()
    second.destroy()
  } finally {
    owner.destroy()
  }
})

for (const width of [44, 100]) {
  test(`actual Code and Markdown share checked text views and embedded parser at ${width} columns`, { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-text-parser-"))
    const client = new TreeSitterClient({ dataPath: join(root, "parser"), initTimeout: 15000 })
    const setup = await createTestRenderer({ width, height: 10, useMouse: false, exitSignals: [], openConsoleOnError: false })
    const failures = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
    try {
      const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromInts(230, 230, 230) }, keyword: { fg: RGBA.fromInts(255, 80, 90), bold: true }, number: { fg: RGBA.fromInts(50, 220, 110) }, string: { fg: RGBA.fromInts(80, 160, 255) } }, setup.renderer.nativeScene)
      const code = new CodeRenderable(setup.renderer, { content: 'const answer = 42; // 한국어', filetype: "javascript", syntaxStyle: style, treeSitterClient: client, width: "100%", height: 2 })
      setup.renderer.root.add(code)
      await renderHighlighted(setup, failures)
      assert.match(setup.captureCharFrame(), /const answer = 42; \/\/ 한국어/u)
      assert.ok(code.textBuffer.getHighlightCount() > 0)
      code.content = 'const answer = "forty two";'
      await renderHighlighted(setup, failures)
      assert.match(setup.captureCharFrame(), /forty two/)
      assert.doesNotMatch(setup.captureCharFrame(), /42/)

      const markdown = new MarkdownRenderable(setup.renderer, { content: "# Heading\n\nSome **bold** text.\n\n```js\nconst item = 7;\n```", syntaxStyle: style, treeSitterClient: client, width: "100%" })
      setup.renderer.root.add(markdown)
      await renderHighlighted(setup, failures)
      assert.match(setup.captureCharFrame(), /Heading/)
      assert.match(setup.captureCharFrame(), /bold/)
      assert.match(setup.captureCharFrame(), /const item = 7/)
      markdown.destroy()
      code.destroy()
      style.destroy()
    } finally {
      await setup.dispose()
      await client.destroy()
      await rm(root, { recursive: true, force: true })
    }
  })
}

async function renderHighlighted(setup, failures) {
  await setup.renderOnce()
  await Promise.all(codeNodes(setup.renderer.root).map((node) => node.highlightingDone))
  await setup.renderOnce()
  if (failures.length) throw failures[0]
}

function codeNodes(node) {
  return [...node instanceof CodeRenderable ? [node] : [], ...node.getChildren().flatMap(codeNodes)]
}
