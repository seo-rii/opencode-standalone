import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { adaptPublishedParserSource, standaloneParserPlugin } from "../parser/build.mjs"
import { bundleBackend } from "./build.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const entry = "opencode:standalone-production-test"
const artifact = await bundleBackend(join(directory, "../.cache/backend/production.mjs"), {
  entry,
  transform: adaptPublishedParserSource,
  plugins: [await standaloneParserPlugin(), {
    name: "production-test-entry",
    setup(build) {
      build.onResolve({ filter: /^opencode:standalone-production-test$/ }, () => ({ path: entry, namespace: "production-test" }))
      build.onLoad({ filter: /.*/, namespace: "production-test" }, () => ({
        resolveDir: directory,
        loader: "js",
        contents: `
          export { CodeRenderable, TreeSitterClient, SyntaxStyle, RGBA, CliRenderEvents } from '@opentui/core'
          export { createTestRenderer } from '@opentui/core/testing'
          export { render, useKeyboard } from '@opentui/solid'
          export { jsx } from '@opentui/solid/jsx-runtime'
          export { createSignal, onCleanup, Show } from 'solid-js/dist/solid.js'
        `,
      }))
    },
  }],
})
const { CodeRenderable, TreeSitterClient, SyntaxStyle, RGBA, CliRenderEvents, createTestRenderer, render, useKeyboard, jsx, createSignal, onCleanup, Show } = await import(pathToFileURL(artifact))

for (const width of [44, 100]) {
  test(`actual Solid stream, highlighted Markdown, scrolling and route editing at ${width} columns`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-production-tui-"))
    const client = new TreeSitterClient({ dataPath: join(root, "parser"), initTimeout: 15_000 })
    const worker = client.worker.worker
    const workerExit = once(worker, "exit")
    const setup = await createTestRenderer({ width, height: 16, kittyKeyboard: true, useMouse: false, exitSignals: [], openConsoleOnError: false })
    const failures = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
    const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromInts(230, 230, 230) }, keyword: { fg: RGBA.fromInts(255, 80, 90), bold: true }, number: { fg: RGBA.fromInts(50, 220, 110) }, string: { fg: RGBA.fromInts(80, 160, 255) } }, setup.renderer.nativeScene)
    const state = { scroll: undefined, input: undefined, transcriptMounts: 0, transcriptDisposals: 0, editorDisposals: 0 }
    const [route, setRoute] = createSignal("transcript")
    const [content, setContent] = createSignal("# Stream\n\nFirst fragment 한국어 👩🏽‍💻.")
    const [streaming, setStreaming] = createSignal(true)
    const Transcript = () => {
      state.transcriptMounts++
      onCleanup(() => { state.transcriptDisposals++ })
      return jsx("scrollbox", {
        id: "production-transcript", width: "100%", flexGrow: 1, scrollY: true,
        ref: (node) => { state.scroll = node },
        get children() {
          return jsx("markdown", { id: "production-message", width: "100%", syntaxStyle: style, treeSitterClient: client, get streaming() { return streaming() }, get content() { return content() } })
        },
      })
    }
    const Editor = () => {
      onCleanup(() => { state.editorDisposals++ })
      return jsx("textarea", { id: "production-editor", width: "100%", height: 3, focused: true, placeholder: "route composer", ref: (node) => { state.input = node } })
    }
    const App = () => {
      useKeyboard((event) => {
        if (event.name !== "f2") return
        event.preventDefault()
        setRoute((value) => value === "transcript" ? "editor" : "transcript")
      })
      return jsx("box", {
        width: "100%", height: "100%", flexDirection: "column",
        get children() {
          return [
            jsx("text", { height: 1, get content() { return route() === "transcript" ? "Conversation" : "Editor route" } }),
            jsx(Show, { get when() { return route() === "transcript" }, get fallback() { return jsx(Editor, {}) }, get children() { return jsx(Transcript, {}) } }),
          ]
        },
      })
    }
    try {
      await render(App, setup.renderer)
      await highlightedFrame()
      assert.match(setup.captureCharFrame(), /First fragment 한국어 👩🏽‍💻/u)
      setContent((value) => value + "\n\n```javascript\nconst answer =")
      await highlightedFrame()
      assert.match(setup.captureCharFrame(), /const answer =/)
      setContent((value) => value + " 42;\n```\n\n" + Array.from({ length: 20 }, (_, row) => `Paragraph ${row} streamed 한국어.`).join("\n\n") + "\n\nTail streamed 끝")
      setStreaming(false)
      await highlightedFrame()
      assert.match(setup.captureCharFrame(), /const answer = 42;/)
      const code = codeNodes(setup.renderer.root)
      assert.ok(code.some((node) => node.textBuffer.getHighlightCount() > 0), "actual parser highlights must reach the native text buffer")
      assert.ok(state.scroll.scrollHeight > state.scroll.viewport.height)
      state.scroll.scrollTo(state.scroll.scrollHeight)
      await highlightedFrame()
      assert.match(setup.captureCharFrame(), /Tail streamed 끝/u)
      assert.doesNotMatch(setup.captureCharFrame(), /First fragment/u)
      setup.resize(width === 44 ? 100 : 44, 12)
      await highlightedFrame()
      state.scroll.scrollTo(state.scroll.scrollHeight)
      await highlightedFrame()
      assert.match(setup.captureCharFrame(), /Tail streamed 끝/u)
      assert.equal(state.scroll.width, width === 44 ? 100 : 44)

      const previousScroll = state.scroll
      setup.mockInput.pressKey("F2")
      await highlightedFrame()
      assert.match(setup.captureCharFrame(), /Editor route/)
      assert.equal(previousScroll.isDestroyed, true)
      assert.ok(code.every((node) => node.isDestroyed))
      assert.equal(state.transcriptDisposals, 1)
      assert.equal(setup.renderer.currentFocusedRenderable, state.input)
      await setup.mockInput.typeText("draft")
      await setup.mockInput.pasteBracketedText(" 한국어")
      setup.mockInput.pressBackspace()
      await highlightedFrame()
      assert.equal(state.input.plainText, "draft 한국")
      assert.match(setup.captureCharFrame(), /draft 한국/u)
      const previousInput = state.input
      setContent("# Restored\n\nRoute remounted 한국어.\n\n```js\nlet next = 9;\n```")
      setup.mockInput.pressKey("F2")
      await highlightedFrame()
      assert.equal(previousInput.isDestroyed, true)
      assert.equal(state.editorDisposals, 1)
      assert.equal(state.transcriptMounts, 2)
      assert.match(setup.captureCharFrame(), /Route remounted 한국어/u)
      assert.match(setup.captureCharFrame(), /let next = 9;/)
      assert.ok(worker.threadId > 0)
    } finally {
      await setup.dispose()
      style.destroy()
      await client.destroy()
      await workerExit
      assert.equal(worker.threadId, -1, "the real parser worker must be joined before removing its data directory")
      await rm(root, { recursive: true, force: true })
    }

    async function highlightedFrame() {
      await setup.renderOnce()
      await Promise.all(codeNodes(setup.renderer.root).map((node) => node.highlightingDone))
      await setup.renderOnce()
      if (failures.length) throw failures[0]
    }
  })
}

function codeNodes(node) {
  return [...node instanceof CodeRenderable ? [node] : [], ...node.getChildren().flatMap(codeNodes)]
}
