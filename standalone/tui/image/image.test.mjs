import assert from "node:assert/strict"
import { test } from "node:test"
import fixtures from "./fixtures.json" with { type: "json" }
import { createImageTransport } from "./runtime.mjs"
import { runImageScenarios } from "./scenarios.mjs"

test("embedded real image codecs preserve golden ICC pixels and checked resource invariants", () => {
  const result = runImageScenarios(createImageTransport(), fixtures)
  assert.equal(result.trace.length, 294)
  assert.equal(result.captures.length, 25)
  assert.deepEqual(result.stats, { hits: 28, misses: 3, entries: 3 })
})

test("independent embedded image reactors cannot share resource storage", () => {
  const first = createImageTransport()
  const second = createImageTransport()
  const firstContext = first.call({ context_create: {} })
  const secondContext = second.call({ context_create: {} })
  const create = (transport, context, pixel) => transport.call({ image: { context, operation: { create: { bytes: Buffer.from(pixel).toString("base64"), width: 1, height: 1, stride: 4 } } } })
  const red = create(first, firstContext, [255, 0, 0, 255])
  const blue = create(second, secondContext, [0, 0, 255, 255])
  // Numeric IDs may repeat in isolated reactors. Public Context ownership is
  // additionally checked by the JS factory; the underlying storage stays local.
  assert.deepEqual(red, blue)
  assert.notEqual(first.buffer, second.buffer)
  const pixels = (transport, context, image) => Buffer.from(transport.call({ image: { context, operation: { copy_pixels: { image, capacity: 4, stride: 4 } } } }), "base64")
  assert.deepEqual(pixels(first, firstContext, red), Buffer.from([255, 0, 0, 255]))
  assert.deepEqual(pixels(second, secondContext, blue), Buffer.from([0, 0, 255, 255]))
  first.call({ context_destroy: { context: firstContext } })
  assert.deepEqual(pixels(second, secondContext, blue), Buffer.from([0, 0, 255, 255]))
  second.call({ context_destroy: { context: secondContext } })
})

test("image requests and decoded allocations enforce bounds without corrupting the Context", () => {
  const transport = createImageTransport()
  const context = transport.call({ context_create: {} })
  const image = transport.call({ image: { context, operation: { create: { bytes: "/wAA/w==", width: 1, height: 1, stride: 4 } } } })
  assert.throws(() => transport.call({ image: { context, operation: { decode: { bytes: "A".repeat(1024 * 1024) } } } }), /bounded 1 MiB input/)
  // 80 MiB is within the upstream decoded-image limit, but beyond this proof's
  // explicit 64 MiB WASM ceiling. Allocation failure must stay a checked error.
  assert.throws(() => transport.call({ image: { context, operation: { resize: { image, width: 10_000, height: 2_000, filter: 6 } } } }), { nativeStatus: -3 })
  assert.equal(transport.call({ image: { context, operation: { info: { image } } } }).width, 1)
  transport.call({ context_destroy: { context } })
})
