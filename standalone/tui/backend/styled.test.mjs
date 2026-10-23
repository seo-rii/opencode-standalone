import assert from "node:assert/strict"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { bundleBackend } from "./build.mjs"

const artifact = await bundleBackend(fileURLToPath(new URL("../.cache/backend/styled-core.mjs", import.meta.url)))
const { TextRenderable, TextareaRenderable, StyledText, RGBA, CliRenderEvents, createTestRenderer } = await import(pathToFileURL(artifact))

for (const width of [44, 100]) {
  test(`actual styled scene text drops empty chunks while streaming at ${width} columns`, async () => {
    const setup = await createTestRenderer({ width, height: 5, useMouse: false, exitSignals: [], openConsoleOnError: false })
    const failures = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
    try {
      const text = new TextRenderable(setup.renderer, { content: "seed" })
      setup.renderer.root.add(text)
      for (const value of ["", "한", "한국어 reply 👩🏽‍💻", ""]) {
        text.content = new StyledText([
          { __isChunk: true, text: "", fg: RGBA.fromInts(250, 60, 90) },
          { __isChunk: true, text: value, fg: RGBA.fromInts(30, 180, 240), attributes: 1, link: { url: "https://example.com/stream" } },
          { __isChunk: true, text: "", attributes: 4 },
        ])
        await setup.renderOnce()
        if (failures.length) throw failures[0]
        assert.equal(text.plainText, value)
        assert.equal(setup.captureCharFrame().trim(), value)
      }
      text.content = new StyledText([
        { __isChunk: true, text: "before", attributes: 1 },
        { __isChunk: true, text: "", attributes: 4 },
        { __isChunk: true, text: " after", attributes: 4 },
      ])
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.equal(setup.captureCharFrame().trim(), "before after")
      setup.renderer.currentRenderBuffer.withBuffers((cells) => {
        assert.equal(cells.attributes[0] & 0xff, 1)
        assert.equal(cells.attributes[7] & 0xff, 4)
      })
    } finally {
      await setup.dispose()
    }
  })
}

test("actual editor placeholder accepts omitted empty styled chunks and clears", async () => {
  const setup = await createTestRenderer({ width: 44, height: 4, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const failures = []
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  try {
    const textarea = new TextareaRenderable(setup.renderer, { width: "100%", height: 3 })
    setup.renderer.root.add(textarea)
    textarea.placeholder = new StyledText([
      { __isChunk: true, text: "", attributes: 1 },
      { __isChunk: true, text: "placeholder 한국어", fg: RGBA.fromInts(120, 140, 160) },
      { __isChunk: true, text: "", attributes: 4 },
    ])
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.match(setup.captureCharFrame(), /placeholder 한국어/u)
    textarea.placeholder = new StyledText([{ __isChunk: true, text: "" }])
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.equal(setup.captureCharFrame().trim(), "")
  } finally {
    await setup.dispose()
  }
})
