import assert from "node:assert/strict"
import { crc32, deflateSync, inflateSync } from "node:zlib"

/** Run real ABI and codec calls, retaining an exact replay for the native oracle. */
export function runImageScenarios(transport, fixtures) {
  const trace = []
  const captures = []
  const call = (request) => {
    try {
      const response = transport.call(request)
      trace.push({ request, status: 0, response })
      return response
    } catch (error) {
      trace.push({ request, status: 1, response: { err: error.code, native_status: error.nativeStatus } })
      throw error
    }
  }
  const context = call({ context_create: {} })
  const other = call({ context_create: {} })
  const image = (operation, owner = context) => call({ image: { context: owner, operation } })
  const pixels = (handle, owner = context) => {
    const info = image({ info: { image: handle } }, owner)
    return Buffer.from(image({ copy_pixels: { image: handle, capacity: info.width * info.height * 4, stride: info.width * 4 } }, owner), "base64")
  }
  const expectStatus = (operation, nativeStatus, owner = context) => assert.throws(() => image(operation, owner), { nativeStatus })
  const input = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 17, 33, 65, 0])
  const source = image({ create: { bytes: input.toString("base64"), width: 2, height: 2, stride: 8 } })
  assert.deepEqual(pixels(source), input)
  const sourceInfo = image({ info: { image: source } })
  assert.deepEqual(sourceInfo, { width: 2, height: 2, source_width: 2, source_height: 2, format: 2, color_status: 1, orientation: 1, has_alpha: 1 })
  const pngSize = image({ png_size: { image: source } })
  expectStatus({ copy_png: { image: source, capacity: pngSize - 1 } }, -45)
  const png = image({ copy_png: { image: source, capacity: pngSize } })
  const decoded = image({ decode: { bytes: png } })
  assert.deepEqual(pixels(decoded), input)
  captures.push({ operation: "raw-png-roundtrip", info: sourceInfo, png, pixels: pixels(decoded).toString("base64") })

  // The input view is strided BGRA and deliberately omits final row padding.
  const padded = Buffer.from([3, 2, 1, 0, 99, 99, 99, 99, 6, 5, 4, 128])
  const opaque = image({ create: { bytes: padded.toString("base64"), width: 1, height: 2, stride: 8, format: 1, alpha: 1 } })
  assert.deepEqual(pixels(opaque), Buffer.from([1, 2, 3, 255, 4, 5, 6, 255]))
  const retained = image({ retain: { image: source } })
  expectStatus({ update: { image: source, bytes: input.toString("base64"), stride: 8 } }, -47)
  expectStatus({ take_pixels: { image: source } }, -47)
  const cloned = image({ clone: { image: source } })
  image({ destroy: { image: retained } })
  const replacement = Buffer.from([0, 1, 2, 255, 3, 4, 5, 255, 6, 7, 8, 255, 9, 10, 11, 255])
  image({ update: { image: source, bytes: replacement.toString("base64"), stride: 8 } })
  assert.deepEqual(pixels(cloned), input)
  assert.deepEqual(pixels(source), replacement)
  expectStatus({ info: { image: source } }, -7, other)
  const foreign = call({ clone: { context: other, source: context, image: cloned } })
  assert.deepEqual(pixels(foreign, other), input)
  image({ destroy: { image: cloned } })
  expectStatus({ info: { image: cloned } }, -9)
  assert.deepEqual(pixels(foreign, other), input)

  const rotated = image({ transform: { image: source, operation: 0 } })
  assert.deepEqual(pixels(rotated), Buffer.from([6, 7, 8, 255, 0, 1, 2, 255, 9, 10, 11, 255, 3, 4, 5, 255]))
  const extracted = image({ extract: { image: source, left: 1, top: 0, width: 1, height: 2 } })
  assert.deepEqual(pixels(extracted), Buffer.from([3, 4, 5, 255, 9, 10, 11, 255]))
  const extended = image({ extend: { image: extracted, top: 1, right: 1, bottom: 0, left: 0, background: [255, 255, 255, 255] } })
  assert.deepEqual(pixels(extended).subarray(0, 8), Buffer.from([255, 255, 255, 255, 255, 255, 255, 255]))
  const composite = image({ composite: { base: source, overlay: opaque, left: 1, top: 0, blend: 1, opacity: 255 } })
  assert.deepEqual(pixels(composite), Buffer.from([0, 1, 2, 255, 1, 2, 3, 255, 6, 7, 8, 255, 4, 5, 6, 255]))
  for (let filter = 0; filter <= 6; filter++) {
    const resized = image({ resize: { image: source, width: 3, height: 3, filter } })
    const output = pixels(resized)
    assert.equal(output.length, 36)
    assert.equal(output[3], 255)
    captures.push({ operation: "resize", filter, pixels: output.toString("base64") })
    image({ destroy: { image: resized } })
  }

  image({ icc_retain: {} })
  for (const [name, bytes] of Object.entries(fixtures)) {
    const inspected = image({ inspect: { bytes } })
    const resource = image({ decode: { bytes } })
    const info = image({ info: { image: resource } })
    assert.deepEqual(info, inspected, name)
    const snapshot = image({ snapshot: { image: resource } })
    const restored = image({ restore: snapshot }, other)
    assert.deepEqual(image({ info: { image: restored } }, other), info, name)
    const output = pixels(resource)
    assert.deepEqual(pixels(restored, other), output, name)
    assert.equal(output.length, info.width * info.height * 4, name)
    if (name.startsWith("display-p3") || name.includes("profile")) assert.equal(info.color_status, 1, name)
    if (name.endsWith(".jpg")) assert.equal(info.format, 3, name)
    if (name.endsWith(".webp")) assert.equal(info.format, 4, name)
    if (name.endsWith(".gif")) assert.equal(info.format, 5, name)
    if (name === "orientation.jpg") assert.equal(info.orientation, 1)
    if (name === "display-p3.png" || name === "display-p3-palette.png") assert.deepEqual(output, Buffer.from([220, 0, 19, 255, 0, 205, 0, 255, 95, 122, 143, 255]), name)
    if (name === "display-p3-rgba.png" || name === "display-p3-palette-alpha.png") assert.deepEqual(output, Buffer.from([220, 0, 19, 1, 0, 205, 0, 127, 95, 122, 143, 255]), name)
    if (name === "srgb-profile.png") assert.deepEqual(output, Buffer.from([10, 20, 30, 255]), name)
    captures.push({ operation: "decode", name, info, pixels: output.toString("base64") })
    image({ destroy: { image: restored } }, other)
    image({ destroy: { image: resource } })
  }
  const stats = image({ icc_stats: {} })
  assert.ok(stats.hits > 0)
  assert.ok(stats.misses > 0)
  assert.ok(stats.entries > 0)
  const malformed = alterProfile(fixtures["display-p3.png"], (profile) => profile.write("CMYK", 16, "ascii"))
  expectStatus({ decode: { bytes: malformed } }, -41)
  image({ icc_release: {} })
  expectStatus({ decode: { bytes: Buffer.from("not an image").toString("base64") } }, -40)
  expectStatus({ create: { bytes: Buffer.alloc(65540).toString("base64"), width: 16385, height: 1, stride: 65540 } }, -43)
  expectStatus({ resize: { image: source, width: 1, height: 1, filter: 99 } }, -1)
  expectStatus({ extract: { image: source, left: 2, top: 0, width: 1, height: 1 } }, -1)
  const lease = image({ take_pixels: { image: source } })
  expectStatus({ info: { image: source } }, -9)
  assert.deepEqual(Buffer.from(transport.buffer, lease.pixels, lease.byte_count), replacement)
  assert.throws(() => call({ context_destroy: { context } }), { code: "ContextBusy" })
  image({ release_pixels: { lease: lease.lease } })
  expectStatus({ release_pixels: { lease: lease.lease } }, -9)
  call({ context_destroy: { context } })
  call({ context_destroy: { context: other } })
  return { trace, captures, stats }
}

function alterProfile(encoded, mutate) {
  const png = Buffer.from(encoded, "base64")
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString("ascii", offset + 4, offset + 8) !== "iCCP") { offset += 12 + length; continue }
    const payload = png.subarray(offset + 8, offset + 8 + length)
    const header = payload.indexOf(0) + 2
    const profile = inflateSync(payload.subarray(header))
    mutate(profile)
    const updated = Buffer.concat([payload.subarray(0, header), deflateSync(profile)])
    const chunk = Buffer.alloc(updated.length + 12)
    chunk.writeUInt32BE(updated.length)
    chunk.write("iCCP", 4, "ascii")
    updated.copy(chunk, 8)
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
    return Buffer.concat([png.subarray(0, offset), chunk, png.subarray(offset + 12 + length)]).toString("base64")
  }
  throw new Error("The pinned ICC fixture is missing its profile chunk")
}
