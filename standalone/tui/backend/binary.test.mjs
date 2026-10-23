import assert from "node:assert/strict"
import { test } from "node:test"
import { WASI } from "node:wasi"
import { brotliDecompressSync } from "node:zlib"
import { factoryWasmBrotliBase64 } from "../factory-wasm.mjs"

const compiled = new WebAssembly.Module(brotliDecompressSync(Buffer.from(factoryWasmBrotliBase64, "base64")))
const encoder = new TextEncoder()
const decoder = new TextDecoder()
// Status values come from the pinned upstream include/opentui.h.
const invalid = -1
const stale = -9
const memoryLimit = -44
const outputTooSmall = -45

function createNativeFactory() {
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {}, returnOnExit: true })
  const imports = wasi.getImportObject()
  imports.opentui_standalone = { scene_measure() { throw new Error("Image transport must not invoke Yoga measurement") } }
  const instance = new WebAssembly.Instance(compiled, imports)
  wasi.initialize(instance)
  const api = instance.exports
  const buffer = api.memory.toResizableBuffer()
  return {
    api, buffer,
    request(value, expected = 0) {
      const bytes = encoder.encode(JSON.stringify(value))
      assert.ok(bytes.byteLength <= api.factoryInputCapacity())
      new Uint8Array(buffer, api.factoryInputPointer(), bytes.byteLength).set(bytes)
      const status = api.factoryCall(bytes.byteLength)
      const result = JSON.parse(decoder.decode(new Uint8Array(buffer, api.factoryOutputPointer(), api.factoryOutputLength())))
      assert.equal(status, expected, JSON.stringify(result))
      return result
    },
  }
}

test("native binary image admission rejects stale and out-of-window spans and recovers", () => {
  const native = createNativeFactory()
  const api = native.api
  native.request({ context_create: { object_capacity: 32, render_cells_max: 64 } })
  try {
    assert.equal(api.factoryBinaryReserve(4), 0)
    const generation = api.factoryBinaryGeneration() >>> 0
    const span = { offset: 0, length: 4, generation }
    new Uint8Array(native.buffer, api.factoryBinaryPointer(), 4).set([11, 22, 33, 255])
    const create = (bytes) => ({ image: { create: { bytes, width: 1, height: 1, stride: 4 } } })
    const image = native.request(create(span))
    assert.equal(native.request(create({ ...span, generation: generation + 1 }), 1).native_status, stale)
    assert.equal(native.request(create({ ...span, offset: 3 }), 1).native_status, invalid)
    assert.equal(native.request(create({ ...span, offset: 0xffffffff }), 1).native_status, invalid)
    assert.equal(api.factoryBinaryRelease(0), stale)
    assert.equal(api.factoryBinaryRelease(generation), 0)
    assert.equal(native.request(create(span), 1).native_status, stale)
    assert.equal(api.factoryBinaryRelease(generation), stale)
    assert.equal(api.factoryBinaryReserve(256 * 1024 * 1024 + 1), memoryLimit)
    assert.equal(api.factoryBinaryReserve(4), 0)
    const current = api.factoryBinaryGeneration() >>> 0
    assert.notEqual(current, generation)
    new Uint8Array(native.buffer, api.factoryBinaryPointer(), 4).fill(255)
    const next = native.request(create({ ...span, generation: current }))
    assert.equal(api.factoryBinaryRelease(current), 0)
    assert.equal(native.request({ image: { info: { image } } }).width, 1)
    native.request({ image: { destroy: { image: next } } })
    native.request({ image: { destroy: { image } } })
  } finally {
    native.request({ context_destroy: {} })
  }
})

test("binary readback owns only the required rows and expires on the next call or release", () => {
  const native = createNativeFactory()
  const api = native.api
  native.request({ context_create: { object_capacity: 32, render_cells_max: 64 } })
  try {
    assert.equal(api.factoryBinaryReserve(8), 0)
    const uploaded = api.factoryBinaryGeneration() >>> 0
    new Uint8Array(native.buffer, api.factoryBinaryPointer(), 8).set([255, 0, 0, 255, 0, 0, 255, 255])
    const image = native.request({ image: { create: { bytes: { offset: 0, length: 8, generation: uploaded }, width: 1, height: 2, stride: 4 } } })
    assert.equal(api.factoryBinaryRelease(uploaded), 0)
    assert.equal(api.factoryBinaryReserve(0), 0)
    const generation = api.factoryBinaryGeneration() >>> 0
    const result = native.request({ image: { copy_pixels: { image, capacity: 0xffffffff, stride: 12 } } })
    assert.deepEqual({ width: result.width, height: result.height, stride: result.stride, length: result.bytes.length }, { width: 1, height: 2, stride: 12, length: 16 })
    assert.equal(result.bytes.generation, api.factoryBinaryOutputGeneration() >>> 0)
    const pixels = new Uint8Array(native.buffer, result.bytes.offset, result.bytes.length)
    assert.deepEqual(Array.from(pixels.subarray(0, 4)), [255, 0, 0, 255])
    assert.deepEqual(Array.from(pixels.subarray(12)), [0, 0, 255, 255])
    native.request({ image: { info: { image } } })
    assert.notEqual(api.factoryBinaryOutputGeneration() >>> 0, result.bytes.generation)
    assert.equal(native.request({ image: { copy_png: { image, capacity: 1 } } }, 1).native_status, outputTooSmall)
    const png = native.request({ image: { copy_png: { image, capacity: 0xffffffff } } })
    assert.ok(png.length > 8)
    assert.deepEqual(Array.from(new Uint8Array(native.buffer, png.offset, 8)), [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(png.generation, api.factoryBinaryOutputGeneration() >>> 0)
    assert.equal(api.factoryBinaryRelease(generation), 0)
    assert.notEqual(api.factoryBinaryOutputGeneration() >>> 0, png.generation)
    native.request({ image: { destroy: { image } } })
  } finally {
    native.request({ context_destroy: {} })
  }
})
