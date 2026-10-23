import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { crc32, inflateSync } from "node:zlib"
import { convertBmpToPng, convertDibToPng } from "./image.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const defaults = { maxBytes: 1024 * 1024, maxImagePixels: 64 * 1024 * 1024, maxConversionBytes: 512 * 1024 * 1024 }
const nativeCodes = [null, "InvalidData", "Unsupported", "LimitExceeded", "OutOfMemory", "Cancelled", "TimedOut"]

function dib(options = {}) {
  const width = options.width ?? 2
  const height = options.height ?? 2
  const depth = options.depth ?? 24
  const header = options.header ?? 40
  const compression = options.compression ?? 0
  const masks = options.masks ?? (depth === 16 ? [0xf800, 0x7e0, 0x1f, 0] : [0xff0000, 0xff00, 0xff, 0xff000000])
  const externalMasks = header === 40 && compression !== 0 ? (compression === 6 ? 16 : 12) : 0
  const colors = options.colors ?? 0
  const offset = header + externalMasks + colors * 4
  const stride = Math.ceil(width * depth / 32) * 4
  const bytes = Buffer.alloc(offset + stride * Math.abs(height))
  bytes.writeUInt32LE(header)
  bytes.writeInt32LE(width, 4)
  bytes.writeInt32LE(height, 8)
  bytes.writeUInt16LE(1, 12)
  bytes.writeUInt16LE(depth, 14)
  bytes.writeUInt32LE(compression, 16)
  bytes.writeUInt32LE(stride * Math.abs(height), 20)
  bytes.writeUInt32LE(colors, 32)
  if (header >= 108) bytes.writeUInt32LE(0x73524742, 56)
  if (compression !== 0) {
    masks.slice(0, header >= 56 || externalMasks === 16 ? 4 : 3).forEach((mask, index) => bytes.writeUInt32LE(mask, 40 + index * 4))
  }
  if (compression === 0 && depth === 32 && header >= 108) bytes.writeUInt32LE(options.alphaMask ?? 0, 52)
  for (let index = offset; index < bytes.length; index++) bytes[index] = options.zero ? 0 : ((index * 67 + (index >>> 5) * 11) & 255)
  return bytes
}

function bmp(bytes, gap = 0) {
  const header = bytes.readUInt32LE(0)
  const compression = bytes.readUInt32LE(16)
  const offset = header + (header === 40 && compression !== 0 ? compression === 6 ? 16 : 12 : 0) + bytes.readUInt32LE(32) * 4
  const file = Buffer.alloc(14 + bytes.length + gap)
  file.write("BM")
  file.writeUInt32LE(file.length, 2)
  file.writeUInt32LE(14 + offset + gap, 10)
  bytes.copy(file, 14, 0, offset)
  bytes.copy(file, 14 + offset + gap, offset)
  return file
}

function mutate(bytes, offset, value, kind = "u32") {
  const changed = Buffer.from(bytes)
  if (kind === "i32") changed.writeInt32LE(value, offset)
  if (kind === "u32") changed.writeUInt32LE(value, offset)
  if (kind === "u16") changed.writeUInt16LE(value, offset)
  return changed
}

async function nativeConversions(cases) {
  const executable = join(directory, "../.cache/clipboard-image/native")
  await access(executable).catch(() => { throw new Error("Prepare the original Zig DIB reference: node tui/clipboard/image-native-prepare.mjs") })
  const receipt = JSON.parse(await readFile(join(directory, "../.cache/clipboard-image/receipt.json"), "utf8"))
  assert.equal(receipt.sourceSha256, "f35cb199bcc26e07018feff5d2e6873978d4c09062111d5f3a1c2a0b0a85a082")
  assert.equal(createHash("sha256").update(await readFile(join(directory, "../.cache/factory-source/src/clipboard/windows-dib.zig"))).digest("hex"), receipt.sourceSha256)
  assert.equal(createHash("sha256").update(await readFile(executable)).digest("hex"), receipt.nativeSha256)
  const input = Buffer.concat(cases.flatMap((entry) => {
    const header = Buffer.alloc(20)
    const options = { ...defaults, ...entry.options }
    ;[entry.bytes.length, entry.bmp ? 1 : 0, options.maxBytes, options.maxImagePixels, options.maxConversionBytes].forEach((value, index) => header.writeUInt32LE(value, index * 4))
    return [header, entry.bytes]
  }))
  const process = spawnSync(executable, [], { input, maxBuffer: 32 * 1024 * 1024 })
  assert.equal(process.error, undefined)
  assert.equal(process.status, 0, process.stderr.toString())
  let offset = 0
  return cases.map(() => {
    assert.ok(offset + 8 <= process.stdout.length)
    const code = process.stdout.readUInt32LE(offset)
    const length = process.stdout.readUInt32LE(offset + 4)
    offset += 8
    assert.ok(offset + length <= process.stdout.length)
    const bytes = process.stdout.subarray(offset, offset + length)
    offset += length
    return { code: nativeCodes[code], bytes }
  })
}

async function compareNative(cases) {
  const references = await nativeConversions(cases)
  for (let index = 0; index < cases.length; index++) {
    const entry = cases[index]
    const convert = entry.bmp ? convertBmpToPng : convertDibToPng
    const options = { ...defaults, ...entry.options }
    if (references[index].code) {
      await assert.rejects(convert(entry.bytes, options), { code: references[index].code }, `case ${index}: ${entry.name}`)
      continue
    }
    const actual = await convert(entry.bytes, options)
    assert.deepEqual(actual, references[index].bytes, `case ${index}: ${entry.name}`)
  }
  return references
}

function pixels(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"))
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const channels = png[25] === 2 ? 3 : 4
  const chunks = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.toString("ascii", offset + 4, offset + 8)
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)))
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const rows = inflateSync(Buffer.concat(chunks))
  const output = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * channels + 1)
    assert.equal(rows[rowOffset], 1)
    for (let index = 0; index < width * channels; index++) {
      const left = index < channels ? 0 : output[y * width * channels + index - channels]
      output[y * width * channels + index] = (rows[rowOffset + 1 + index] + left) & 255
    }
  }
  return { width, height, channels, bytes: output }
}

test("DIB/BMP PNG output matches the original Zig converter byte for byte across headers, masks, orientation and long runs", async () => {
  const cases = []
  for (const header of [40, 52, 56, 108, 124]) {
    for (const depth of [16, 24, 32]) {
      for (const height of [3, -3]) {
        const bytes = dib({ width: 7, height, depth, header, colors: 2 })
        cases.push({ name: `${header}/${depth}/${height} RGB DIB`, bytes })
        cases.push({ name: `${header}/${depth}/${height} RGB BMP pixel gap`, bytes: bmp(bytes, 9), bmp: true })
      }
    }
    for (const depth of [16, 32]) {
      for (const compression of [3, 6]) {
        for (const height of [2, -2]) {
          cases.push({ name: `${header}/${depth}/${compression}/${height} bitfields`, bytes: dib({ width: 5, height, depth, header, compression }) })
        }
      }
    }
  }
  for (const header of [108, 124]) {
    for (const alphaMask of [0, 0xff000000]) cases.push({ name: `${header} RGB alpha ${alphaMask}`, bytes: dib({ header, depth: 32, alphaMask }) })
  }
  cases.push({ name: "long zero runs across rows", bytes: dib({ width: 2048, height: 3, depth: 32, zero: true }) })
  cases.push({ name: "wide images retain clipboard limits", bytes: dib({ width: 20001, height: 1 }) })
  cases.push({ name: "10-bit channels and 2-bit alpha", bytes: dib({ header: 124, depth: 32, compression: 3, masks: [0x3ff00000, 0xffc00, 0x3ff, 0xc0000000] }) })
  await compareNative(cases)
})

test("DIB conversion preserves bottom-up padded pixels, 555/565 scaling and explicit alpha without treating padding as alpha", async () => {
  const bgr = dib({ width: 2, height: 2 })
  bgr.set([255, 0, 0, 255, 255, 255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0], 40)
  assert.deepEqual(pixels(await convertDibToPng(bgr)).bytes, Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]))
  const topDown = dib({ width: 2, height: -1, header: 124, depth: 32, compression: 3 })
  topDown.set([10, 20, 30, 40, 50, 60, 70, 255], 124)
  assert.deepEqual(pixels(await convertDibToPng(topDown)).bytes, Buffer.from([30, 20, 10, 40, 70, 60, 50, 255]))
  const opaque = mutate(topDown, 16, 0)
  opaque.writeUInt32LE(0, 52)
  assert.deepEqual(pixels(await convertDibToPng(opaque)).bytes, Buffer.from([30, 20, 10, 70, 60, 50]))
  for (const compression of [0, 3]) {
    const rgb16 = dib({ width: 3, height: 1, depth: 16, compression })
    const offset = compression === 0 ? 40 : 52
    rgb16.writeUInt16LE(compression === 0 ? 0x7c00 : 0xf800, offset)
    rgb16.writeUInt16LE(compression === 0 ? 0x03e0 : 0x07e0, offset + 2)
    rgb16.writeUInt16LE(0x001f, offset + 4)
    assert.deepEqual(pixels(await convertDibToPng(rgb16)).bytes, Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]))
  }
})

test("malformed DIB/BMP data and unsupported palette, compression, color space and masks match the original rejection semantics", async () => {
  const rgb = dib()
  const v5 = dib({ header: 124, depth: 32, compression: 3 })
  const file = bmp(rgb, 7)
  const cases = [
    { name: "empty DIB", bytes: Buffer.alloc(0) },
    { name: "truncated header", bytes: rgb.subarray(0, 39) },
    { name: "truncated pixels", bytes: rgb.subarray(0, rgb.length - 1) },
    { name: "old header", bytes: mutate(rgb, 0, 12) },
    { name: "unknown header", bytes: mutate(rgb, 0, 41) },
    { name: "huge header", bytes: mutate(rgb, 0, 0xffffffff) },
    { name: "negative width", bytes: mutate(rgb, 4, -1, "i32") },
    { name: "zero width", bytes: mutate(rgb, 4, 0) },
    { name: "zero height", bytes: mutate(rgb, 8, 0) },
    { name: "minimum height", bytes: mutate(rgb, 8, -2147483648, "i32") },
    { name: "invalid planes", bytes: mutate(rgb, 12, 2, "u16") },
    ...[1, 4, 8, 48].map((depth) => ({ name: `unsupported depth ${depth}`, bytes: mutate(rgb, 14, depth, "u16") })),
    ...[1, 2, 4, 5, 7].map((compression) => ({ name: `unsupported compression ${compression}`, bytes: mutate(rgb, 16, compression) })),
    { name: "24-bit fields", bytes: mutate(rgb, 16, 3) },
    { name: "noncontiguous mask", bytes: mutate(v5, 40, 0x00ff00ff) },
    { name: "missing RGB mask", bytes: mutate(v5, 40, 0) },
    { name: "overlapping RGB masks", bytes: mutate(v5, 44, 0xff0000) },
    { name: "alpha overlaps RGB", bytes: mutate(v5, 52, 0xffff0000) },
    { name: "unsupported profile", bytes: mutate(v5, 56, 0) },
    { name: "color count overflows input", bytes: mutate(rgb, 32, 0xffffffff) },
    { name: "mask outside pixel", bytes: dib({ depth: 16, compression: 3, masks: [0x10000, 0x3e0, 0x1f, 0] }) },
    { name: "truncated external masks", bytes: dib({ depth: 32, compression: 6 }).subarray(0, 53) },
    { name: "truncated BMP header", bytes: file.subarray(0, 13), bmp: true },
    { name: "BMP file size", bytes: mutate(file, 2, file.length - 1), bmp: true },
    { name: "BMP reserved 1", bytes: mutate(file, 6, 1, "u16"), bmp: true },
    { name: "BMP reserved 2", bytes: mutate(file, 8, 1, "u16"), bmp: true },
    ...[13, 53, file.length + 1].map((offset) => ({ name: `BMP offset ${offset}`, bytes: mutate(file, 10, offset), bmp: true })),
  ]
  const badMagic = Buffer.from(file)
  badMagic[0] = 0x5a
  cases.push({ name: "BMP signature", bytes: badMagic, bmp: true })
  await compareNative(cases)
})

test("DIB conversion respects exact native output, pixel and conversion boundaries with clipboard defaults", async () => {
  const bytes = dib()
  const png = await convertDibToPng(bytes)
  const cases = [
    ...[0, 7, 32, 40, 41, 64, png.length - 1, png.length, png.length + 1].map((maxBytes) => ({ name: `output ${maxBytes}`, bytes, options: { maxBytes } })),
    ...[0, 3, 4].map((maxImagePixels) => ({ name: `pixels ${maxImagePixels}`, bytes, options: { maxImagePixels } })),
    ...[0, 15, 16].map((maxConversionBytes) => ({ name: `conversion ${maxConversionBytes}`, bytes, options: { maxConversionBytes } })),
  ]
  const largeHeader = mutate(mutate(bytes.subarray(0, 40), 4, 30000), 8, 1000)
  cases.push({ name: "default clipboard limits permit 30MP/120MB before validating missing pixels", bytes: largeHeader })
  cases.push({ name: "explicit narrower limit rejects 30MP first", bytes: largeHeader, options: { maxImagePixels: 25_000_000 } })
  const results = await compareNative(cases)
  assert.equal(results.at(-2).code, "InvalidData")
  assert.equal(results.at(-1).code, "LimitExceeded")
})

test("DIB conversion observes preabort, deadlines and live cancellation while processing actual image pixels", async () => {
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(convertDibToPng(Buffer.alloc(0), { signal: aborted.signal }), { code: "Cancelled", status: "cancelled" })
  await assert.rejects(convertBmpToPng(Buffer.alloc(0), { deadline: performance.now() - 1 }), { code: "TimedOut", status: "timed-out" })
  const image = dib({ width: 4096, height: 256, zero: true })
  const live = new AbortController()
  const timer = setImmediate(() => live.abort())
  try {
    await assert.rejects(convertDibToPng(image, { signal: live.signal }), { code: "Cancelled" })
  } finally { clearImmediate(timer) }
  await assert.rejects(convertDibToPng(image, { deadline: performance.now() + 1 }), { code: "TimedOut" })
  assert.equal(pixels(await convertDibToPng(dib({ width: 1, height: 1 }))).width, 1)
})

