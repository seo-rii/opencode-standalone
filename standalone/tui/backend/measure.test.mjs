import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bundleBackend } from "./build.mjs"

const artifact = await bundleBackend(fileURLToPath(new URL("../.cache/backend/measure.mjs", import.meta.url)), { entry: fileURLToPath(new URL("./measure-entry.mjs", import.meta.url)) })
const { createTestRenderer, TextRenderable, EditBuffer, Renderable, SpinnerRenderable, CliRenderEvents, MeasureMode, RGBA, measureEditText } = await import(pathToFileURL(artifact))

test("actual public measureEditText initializes its standalone Context and preserves Unicode/tab cursor offsets", async () => {
  assert.equal(measureEditText("", { widthMethod: "unicode" }), 0)
  assert.equal(measureEditText("한국어", { widthMethod: "unicode" }), 6)
  assert.equal(measureEditText("é 👩🏽‍💻", { widthMethod: "unicode" }), 4)
  assert.equal(measureEditText("a\tb", { widthMethod: "unicode", tabWidth: 4 }), 6)
  assert.equal(measureEditText("a\tb", { widthMethod: "unicode", tabWidth: 8 }), 10)
  const setup = await createTestRenderer({ width: 44, height: 4, useMouse: false, exitSignals: [], openConsoleOnError: false })
  try {
    for (const widthMethod of ["unicode", "wcwidth"]) {
      const editor = EditBuffer.create(widthMethod, setup.renderer.nativeScene)
      try {
        editor.setTabWidth(4)
        const text = "한국어 é 👩🏽‍💻\t\n끝"
        editor.setText(text)
        const offset = measureEditText(text, { widthMethod, tabWidth: 4 })
        assert.equal(offset, editor.measureText(text))
        assert.equal(editor.getTextRange(0, offset), text)
      } finally {
        editor.destroy()
      }
    }
  } finally {
    await setup.dispose()
  }
})

for (const width of [44, 100]) {
  test(`actual Yoga custom measurement preserves constraints and native read callbacks at ${width} columns`, async () => {
    const setup = await createTestRenderer({ width, height: 8, useMouse: false, exitSignals: [], openConsoleOnError: false })
    const failures = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
    const calls = []
    class Measured extends Renderable {
      renderSelf(buffer) { buffer.drawText("measured 한국어", this.x, this.y, RGBA.fromInts(240, 180, 60)) }
    }
    try {
      setup.renderer.root.flexDirection = "column"
      setup.renderer.root.alignItems = "flex-start"
      const text = new TextRenderable(setup.renderer, { width: 15, minWidth: 15, height: 1, content: "read 한국어" })
      setup.renderer.root.add(text)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      const measured = new Measured(setup.renderer, { maxWidth: "50%", alignSelf: "flex-start" })
      const lib = setup.renderer.nativeScene.driver.renderLib
      const context = setup.renderer.nativeScene.driver.context
      const handle = text._getSceneHandle(setup.renderer.nativeScene)
      const provider = (availableWidth, widthMode, availableHeight, heightMode) => {
        calls.push({ availableWidth, widthMode, availableHeight, heightMode })
        assert.equal(lib.sceneGetText(context, handle), "read 한국어")
        assert.equal(text.getMinWidth().value, 15)
        assert.equal(lib.sceneGetLayout(context, handle, true).width, 15)
        assert.ok(lib.sceneGetTextMetrics(context, handle).widthColsMax > 0)
        assert.throws(() => { measured.width = 4 }, /Cannot mutate Yoga during a callback/)
        return { width: widthMode === MeasureMode.Undefined ? 90 : Math.min(90, availableWidth), height: 1 }
      }
      measured.setMeasureProvider(provider)
      setup.renderer.root.add(measured)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.ok(calls.length > 0)
      assert.ok(calls.some((call) => call.widthMode === MeasureMode.AtMost && call.availableWidth === width / 2))
      assert.equal(measured.width, width / 2)
      assert.match(setup.captureCharFrame(), /measured 한국어/u)
      const resizedWidth = width === 44 ? 100 : 44
      setup.resize(resizedWidth, 8)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.equal(measured.width, resizedWidth / 2)
      assert.ok(calls.some((call) => call.widthMode === MeasureMode.AtMost && call.availableWidth === resizedWidth / 2))
      measured.setMeasureProvider(null)
      assert.equal(measured.hasMeasureFunc(), false)
      measured.destroyRecursively()
      const count = calls.length
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.equal(calls.length, count)
    } finally {
      await setup.dispose()
    }
  })
}

test("actual Yoga callback failures cancel the frame and allow a valid replacement provider", async () => {
  const setup = await createTestRenderer({ width: 44, height: 4, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const failures = []
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  try {
    const measured = new Renderable(setup.renderer, { alignSelf: "flex-start" })
    setup.renderer.root.add(measured)
    const failure = new Error("actual custom measurement failure")
    measured.setMeasureProvider(() => { throw failure })
    await setup.renderOnce()
    assert.ok(failures.includes(failure))
    failures.length = 0
    measured.setMeasureProvider(() => Promise.resolve({ width: 7, height: 1 }))
    await setup.renderOnce()
    assert.ok(failures.some((error) => error instanceof TypeError && /must be synchronous/.test(error.message)))
    failures.length = 0
    measured.setMeasureProvider(() => ({ width: 7, height: 1 }))
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.equal(measured.width, 7)
    assert.equal(measured.height, 1)
  } finally {
    await setup.dispose()
  }
})

for (const width of [44, 100]) {
  test(`actual upstream SpinnerRenderable measures and records Unicode frames at ${width} columns`, async () => {
    const setup = await createTestRenderer({ width, height: 4, useMouse: false, exitSignals: [], openConsoleOnError: false })
    const failures = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
    try {
      const spinner = new SpinnerRenderable(setup.renderer, { frames: ["한글", "👩🏽‍💻"], autoplay: false, alignSelf: "flex-start" })
      setup.renderer.root.add(spinner)
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.equal(spinner.width, 4)
      assert.equal(spinner.height, 1)
      assert.match(setup.captureCharFrame(), /한글/u)
      spinner.frames = ["👩🏽‍💻"]
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.equal(spinner.width, 2)
      assert.match(setup.captureCharFrame(), /👩🏽‍💻/u)
      spinner.destroyRecursively()
      await setup.renderOnce()
      if (failures.length) throw failures[0]
      assert.doesNotMatch(setup.captureCharFrame(), /👩🏽‍💻/u)
    } finally {
      await setup.dispose()
    }
  })
}
