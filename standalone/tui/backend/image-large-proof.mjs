import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { crc32 } from "node:zlib"

/** Exercise large transfers through the published image classes and checked ABI. */
export function checkPublishedLargeImages(api) {
  const encodedBytes = checkLargePng(api)
  const rawBytes = checkLargePixels(api)
  return { encodedBytes, rawBytes, originalPng: true, crossContextPixels: true, grewWithLease: true, paddedCopy: true, pooledUpdate: true, recovered: true }
}

function checkLargePng(api) {
  const owner = new api.ResourceContext({ objectCapacity: 32, renderCellsMax: 1 })
  const other = new api.ResourceContext({ objectCapacity: 32, renderCellsMax: 1 })
  const resources = []
  const keep = (image) => { resources.push(image); return image }
  try {
    const width = 1536
    const height = 1024
    const pixels = new Uint8Array(width * height * 4)
    fillNoise(pixels, true)
    const expected = digest(pixels)
    const source = keep(api.NativeImage.fromRgba(pixels, width, height, width * 4, { owner }))
    source.ensureEncodedPng()
    const size = owner.renderLib.imageCopyPng(source.ptr, new Uint8Array())
    assert.equal(size.status, 0)
    const encoded = new Uint8Array(size.byteCount)
    assert.equal(owner.renderLib.imageCopyPng(source.ptr, encoded).byteCount, encoded.length)
    source.dispose()

    // An ancillary chunk makes re-encoding distinguishable from exact copying.
    const text = Buffer.from("Comment\0standalone large transfer preserves the original PNG")
    const chunk = Buffer.alloc(text.length + 12)
    chunk.writeUInt32BE(text.length)
    chunk.write("tEXt", 4)
    chunk.set(text, 8)
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
    assert.equal(Buffer.from(encoded.subarray(-8, -4)).toString(), "IEND")
    const png = Buffer.concat([encoded.subarray(0, -12), chunk, encoded.subarray(-12)])
    assert.ok(png.length > 4 * 1024 * 1024, `PNG must cross the old 4MiB copy limit: ${png.length}`)
    assert.equal(api.imageInfo(png, { owner }).width, width)

    const signature = png[0]
    png[0] = 0
    try {
      assert.throws(() => api.NativeImage.decode(png, { owner }), { code: "unsupported-format", status: 2 })
    } finally {
      png[0] = signature
    }
    const image = keep(api.NativeImage.decode(png, { owner }))
    assert.deepEqual(api.imageInfo(png, { owner }), image.info())
    assert.equal(image.info().format, "png")
    assert.equal(image.info().hasAlpha, false)
    const localInfo = owner.renderLib.imageGetInfo(image.ptr)
    const copied = image._getContextHandle(other.renderLib, other.context)
    assert.deepEqual(other.renderLib.imageGetInfo(copied), localInfo)

    // Clone before any pixel read, while the native PNG still has its lazy data.
    const output = new Uint8Array(png.length + 19).fill(0xa7)
    for (const [lib, handle] of [[owner.renderLib, image.ptr], [other.renderLib, copied]]) {
      const count = lib.imageCopyPng(handle, new Uint8Array())
      assert.deepEqual(count, { status: 0, byteCount: png.length })
      assert.deepEqual(lib.imageCopyPng(handle, output), count)
      assert.equal(digest(output.subarray(0, png.length)), digest(png))
      assert.ok(output.subarray(png.length).every((byte) => byte === 0xa7))
    }
    assert.equal(digest(image.raw().data), expected)
    assert.equal(other.renderLib.imageCopyPixels(copied, pixels, width * 4, false), 0)
    assert.equal(digest(pixels), expected)
    return png.length
  } finally {
    for (const resource of resources.reverse()) resource.dispose()
    other.destroy()
    owner.destroy()
  }
}

function checkLargePixels(api) {
  const owner = new api.ResourceContext({ objectCapacity: 32, renderCellsMax: 1 })
  const other = new api.ResourceContext({ objectCapacity: 32, renderCellsMax: 1 })
  const width = 4096
  const height = 4097
  const rowBytes = width * 4
  const pixels = new Uint8Array(rowBytes * height)
  const pool = new api.NativeImagePool({ owner, width, height, capacity: 1 })
  const resources = []
  const keep = (image) => { resources.push(image); return image }
  let lease
  try {
    assert.ok(pixels.byteLength > 64 * 1024 * 1024)
    fillNoise(pixels, true)
    const expected = digest(pixels)
    const tiny = keep(api.NativeImage.fromRgba(Uint8Array.from([12, 34, 56, 255]), 1, 1, 4, { owner }))
    lease = tiny.takeRaw()
    const memory = lease.data.buffer
    const previousLength = memory.byteLength
    assert.equal(memory.resizable, true)

    const first = keep(pool.publishRgba(pixels))
    assert.ok(first)
    assert.equal(lease.data.buffer, memory)
    assert.ok(memory.byteLength > previousLength, "Uploading >64MiB must grow the same native memory while a pixel lease is live")
    assert.deepEqual(Array.from(lease.data), [12, 34, 56, 255])
    new Uint8Array(memory, lease.data.byteOffset, 4)[1] = 77
    assert.equal(lease.data[1], 77)
    assert.equal(digest(first.raw().data), expected)

    const stride = rowBytes + 4
    const capacity = stride * (height - 1) + rowBytes + 7
    const storage = new Uint8Array(11 + capacity + 13).fill(0xa7)
    const destination = storage.subarray(11, -13)
    assert.throws(() => first.copyTo(destination.subarray(0, 8), { stride }), { code: "output-too-small", status: 9 })
    first.copyTo(destination, { stride })
    checkPaddedCopy(destination, rowBytes, height, stride, expected)
    assert.ok(storage.subarray(0, 11).every((byte) => byte === 0xa7))
    assert.ok(storage.subarray(-13).every((byte) => byte === 0xa7))

    const info = owner.renderLib.imageGetInfo(first.ptr)
    const copied = first._getContextHandle(other.renderLib, other.context)
    assert.deepEqual(other.renderLib.imageGetInfo(copied), info)
    assert.equal(other.renderLib.imageCopyPixels(copied, destination, stride, false), 0)
    checkPaddedCopy(destination, rowBytes, height, stride, expected)
    first.dispose()

    // The failed update has already sent a full binary input. The next publish
    // must release that input and update the pool's existing native image.
    assert.throws(() => pool.publishRgba(pixels, rowBytes - 1), { code: "invalid-argument", status: 7 })
    pixels[0] ^= 0x55
    pixels[pixels.length - 2] ^= 0x39
    const updated = keep(pool.publishRgba(pixels))
    assert.ok(updated)
    updated.copyTo(destination, { stride })
    checkPaddedCopy(destination, rowBytes, height, stride, digest(pixels))
    assert.ok(storage.subarray(0, 11).every((byte) => byte === 0xa7))
    assert.ok(storage.subarray(-13).every((byte) => byte === 0xa7))
    assert.deepEqual(Array.from(lease.data), [12, 77, 56, 255])
    // Reuse the >64MiB raw input to check the original encoded-byte limit,
    // without allocating another boundary-sized buffer.
    assert.throws(() => api.imageInfo(pixels, { owner }), { code: "memory-limit", status: 6 })
    assert.equal(updated.info().format, "raw-rgba")

    const resized = keep(updated.resize({ width: 2, height: 2, kernel: "nearest" }))
    assert.equal(resized.width, 2)
    assert.equal(resized.height, 2)
    const small = resized.raw().data
    assert.equal(small.length, 16)
    assert.deepEqual(Array.from(small.filter((_, index) => index % 4 === 3)), [255, 255, 255, 255])
    assert.ok(small.some((byte) => byte > 0 && byte < 255))
    return pixels.byteLength
  } finally {
    lease?.dispose()
    for (const resource of resources.reverse()) resource?.dispose()
    pool.dispose()
    other.destroy()
    owner.destroy()
  }
}

function fillNoise(bytes, opaque = false) {
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  let state = 0x12345678
  for (let index = 0; index < words.length; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    words[index] = opaque ? (state & 0xffffff) | 0xff000000 : state
  }
}

function checkPaddedCopy(bytes, rowBytes, height, stride, expected) {
  const hash = createHash("sha256")
  for (let row = 0; row < height; row++) {
    const end = row * stride + rowBytes
    hash.update(bytes.subarray(row * stride, end))
    if (row < height - 1) assert.ok(bytes.subarray(end, (row + 1) * stride).every((byte) => byte === 0xa7), `Row ${row} padding changed`)
  }
  assert.equal(hash.digest("hex"), expected)
  assert.ok(bytes.subarray((height - 1) * stride + rowBytes).every((byte) => byte === 0xa7))
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
