import assert from "node:assert/strict"
import fixtures from "../image/fixtures.json" with { type: "json" }

export function checkPublishedImages(api) {
  const owner = new api.ResourceContext({ objectCapacity: 128, renderCellsMax: 64 })
  const other = new api.ResourceContext({ objectCapacity: 128, renderCellsMax: 64 })
  const resources = []
  const keep = (value) => { resources.push(value); return value }
  let raw
  try {
    const input = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 17, 33, 65, 0])
    const image = keep(api.NativeImage.fromRgba(input, 2, 2, 8, { owner }))
    input.fill(23)
    assert.deepEqual(Array.from(image.raw().data), [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 17, 33, 65, 0])
    assert.equal(image.info().format, "raw-rgba")
    const clone = keep(image.clone())
    const retained = keep(image.retain())
    assert.deepEqual(clone.info(), image.info())
    assert.deepEqual(clone.raw().data, image.raw().data)
    image.ensureEncodedPng()
    const count = owner.renderLib.imageCopyPng(image.ptr, new Uint8Array())
    assert.equal(count.status, 0)
    const encoded = new Uint8Array(count.byteCount)
    assert.equal(owner.renderLib.imageCopyPng(image.ptr, encoded).status, 0)
    const decoded = keep(api.NativeImage.decode(encoded, { owner }))
    assert.deepEqual(decoded.raw().data, image.raw().data)
    const padding = new Uint8Array(25).fill(99)
    image.copyTo(padding, { stride: 12, format: "bgra8" })
    assert.deepEqual(Array.from(padding.subarray(0, 8)), [0, 0, 255, 255, 0, 255, 0, 128])
    assert.deepEqual(Array.from(padding.subarray(8, 12)), [99, 99, 99, 99])
    assert.deepEqual(Array.from(padding.subarray(20)), [99, 99, 99, 99, 99])
    const enlarged = keep(image.resize({ width: 4, height: 4, kernel: "nearest" }))
    assert.equal(enlarged.raw().data.length, 64)
    assert.throws(() => image.resize({ width: 5_001, height: 5_000, kernel: "nearest" }), { code: "dimension-limit", status: 5 })
    const rotated = keep(image.rotate(90))
    assert.deepEqual(Array.from(rotated.raw().data.subarray(0, 8)), [0, 0, 255, 255, 255, 0, 0, 255])
    assert.throws(() => retained.takeRaw(), /retain/)
    retained.dispose()

    const transferred = keep(api.NativeImage.fromPixels(Uint8Array.from([3, 2, 1, 0, 99, 99, 99, 99, 6, 5, 4, 128]), 1, 2, { owner, stride: 8, format: "bgra8", alpha: "opaque" }))
    raw = transferred.takeRaw()
    assert.equal(raw.data.buffer.resizable, true)
    assert.ok(raw.data.byteOffset > 0)
    assert.deepEqual(Array.from(raw.data), [1, 2, 3, 255, 4, 5, 6, 255])
    raw.data[0] = 91
    assert.equal(raw.data[0], 91)
    assert.throws(() => transferred.raw(), /disposed/)
    assert.throws(() => owner.destroy(), (error) => error instanceof api.NativeError && error.status === api.NativeStatus.ContextBusy)
    assert.deepEqual(clone.raw().data, image.raw().data)
    raw.dispose()
    raw = undefined

    let formats = 0
    for (const [name, encoded] of Object.entries(fixtures)) {
      const decoded = keep(api.NativeImage.decode(Buffer.from(encoded, "base64"), { owner }))
      const localInfo = decoded.info()
      const copied = decoded._getContextHandle(other.renderLib, other.context)
      const copiedInfo = other.renderLib.imageGetInfo(copied)
      assert.equal(copiedInfo.status, 0, name)
      assert.equal(copiedInfo.info.width, localInfo.width, name)
      const raw = new Uint8Array(localInfo.width * localInfo.height * 4)
      assert.equal(other.renderLib.imageCopyPixels(copied, raw, localInfo.width * 4, false), 0, name)
      assert.deepEqual(raw, decoded.raw().data, name)
      if (name.endsWith(".jpg")) assert.equal(copiedInfo.info.format, 3, name)
      if (name.endsWith(".webp")) assert.equal(copiedInfo.info.format, 4, name)
      if (name.endsWith(".gif")) assert.equal(copiedInfo.info.format, 5, name)
      if (name === "display-p3.png") assert.deepEqual(Array.from(raw), [220, 0, 19, 255, 0, 205, 0, 255, 95, 122, 143, 255])
      decoded.dispose()
      formats++
    }
    const pool = new api.NativeImagePool({ owner, width: 1, height: 1, capacity: 1 })
    try {
      const first = keep(pool.publishRgba(Uint8Array.from([255, 0, 0, 255])))
      assert.equal(pool.publishRgba(Uint8Array.from([0, 0, 255, 255])), null)
      first.dispose()
      const second = keep(pool.publishRgba(Uint8Array.from([0, 0, 255, 255])))
      assert.deepEqual(Array.from(second.raw().data), [0, 0, 255, 255])
    } finally {
      pool.dispose()
    }
    return { formats, zeroCopy: true, crossContextMetadata: true, pooledUpdates: true }
  } finally {
    raw?.dispose()
    for (const resource of resources.reverse()) resource?.dispose()
    other.destroy()
    owner.destroy()
  }
}

export async function checkPublishedImageScene(api) {
  const setup = await api.createTestRenderer({ width: 44, height: 8, useMouse: false, exitSignals: [], openConsoleOnError: false })
  const failures = []
  setup.renderer.on(api.CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  const image = api.NativeImage.fromRgba(Uint8Array.from([255, 0, 0, 255]), 1, 1)
  try {
    const node = new api.ImageRenderable(setup.renderer, { source: image, width: 4, height: 2, fit: "fill", protocol: "blocks" })
    setup.renderer.root.add(node)
    await node.loadPromise
    image.dispose()
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.ok(node.image)
    assert.equal(node.effectiveProtocol, "blocks")
    const expected = Array.from(api.RGBA.fromInts(255, 0, 0).buffer)
    setup.renderer.currentRenderBuffer.withBuffers((cells) => {
      const fg = Array.from(cells.fg.subarray(0, 4))
      const bg = Array.from(cells.bg.subarray(0, 4))
      assert.ok(JSON.stringify(fg) === JSON.stringify(expected) || JSON.stringify(bg) === JSON.stringify(expected), `Real image block color missing: ${JSON.stringify({ fg, bg })}`)
    })
    setup.resize(100, 8)
    await setup.renderOnce()
    if (failures.length) throw failures[0]
    assert.equal(node.width, 4)
    assert.ok(setup.getNativeStats().nativeFrameCount >= 2)
    return { nativeImageScene: true, retainedAfterSourceDisposal: true, resized: true }
  } finally {
    image.dispose()
    await setup.dispose()
  }
}
