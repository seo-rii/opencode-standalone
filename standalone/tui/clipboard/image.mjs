import { setImmediate } from "node:timers/promises"
import { crc32 } from "node:zlib"

// Port of the pinned OpenTUI clipboard/windows-dib.zig. Keep this separate from
// renderer image decoding: clipboard conversion has its own, larger limits.
const signature = Buffer.from("89504e470d0a1a0a", "hex")
const lengthBases = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const lengthBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const fixedCodes = new Uint16Array(288)
const fixedBits = new Uint8Array(288)
for (let symbol = 0; symbol < fixedCodes.length; symbol++) {
  const count = symbol <= 143 ? 8 : symbol <= 255 ? 9 : symbol <= 279 ? 7 : 8
  const code = symbol <= 143 ? 0x30 + symbol : symbol <= 255 ? 0x190 + symbol - 144 : symbol <= 279 ? symbol - 256 : 0xc0 + symbol - 280
  let reversed = 0
  for (let bit = 0; bit < count; bit++) reversed = (reversed << 1) | ((code >>> bit) & 1)
  fixedCodes[symbol] = reversed
  fixedBits[symbol] = count
}

export async function convertDibToPng(bytes, options = {}) {
  const context = conversionContext(options)
  context.check()
  const dib = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return encodePng(dib, parseDib(dib, null, context), context)
}

export async function convertBmpToPng(bytes, options = {}) {
  const context = conversionContext(options)
  context.check()
  const bmp = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bmp.length < 14 || bmp.toString("ascii", 0, 2) !== "BM" || bmp.readUInt16LE(6) !== 0 || bmp.readUInt16LE(8) !== 0) fail("InvalidData")
  if (bmp.readUInt32LE(2) !== bmp.length) fail("InvalidData")
  const pixelOffset = bmp.readUInt32LE(10)
  if (pixelOffset < 14 || pixelOffset > bmp.length) fail("InvalidData")
  const dib = bmp.subarray(14)
  return encodePng(dib, parseDib(dib, pixelOffset - 14, context), context)
}

function conversionContext(options) {
  let nextYield = performance.now() + 4
  return {
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    maxImagePixels: options.maxImagePixels ?? 64 * 1024 * 1024,
    maxConversionBytes: options.maxConversionBytes ?? 512 * 1024 * 1024,
    check() {
      if (options.signal?.aborted) fail("Cancelled")
      if (performance.now() >= (options.deadline ?? Infinity)) fail("TimedOut")
    },
    async checkpoint() {
      this.check()
      if (performance.now() < nextYield) return
      await setImmediate()
      nextYield = performance.now() + 4
      this.check()
    },
  }
}

function fail(code) {
  const error = new Error(`Clipboard image conversion: ${code}`)
  error.code = code
  error.status = code === "Unsupported" ? "unsupported" : code === "LimitExceeded" ? "limit-exceeded" : code === "Cancelled" ? "cancelled" : code === "TimedOut" ? "timed-out" : "failed"
  throw error
}

function allocate(length) {
  try {
    return Buffer.allocUnsafe(length)
  } catch {
    fail("OutOfMemory")
  }
}

function parseDib(dib, explicitPixelOffset, context) {
  if (dib.length < 4) fail("InvalidData")
  const headerSize = dib.readUInt32LE(0)
  if (headerSize < 40) fail("Unsupported")
  if (headerSize > dib.length) fail("InvalidData")
  if (![40, 52, 56, 108, 124].includes(headerSize)) fail("Unsupported")
  if (headerSize >= 108 && ![0x73524742, 0x57696e20].includes(dib.readUInt32LE(56))) fail("Unsupported")
  const width = dib.readInt32LE(4)
  const signedHeight = dib.readInt32LE(8)
  if (width <= 0 || signedHeight === 0 || signedHeight === -2147483648 || dib.readUInt16LE(12) !== 1) fail("InvalidData")
  const depth = dib.readUInt16LE(14)
  if (![16, 24, 32].includes(depth)) fail("Unsupported")
  const compression = dib.readUInt32LE(16)
  if (![0, 3, 6].includes(compression) || (depth === 24 && compression !== 0)) fail("Unsupported")
  if (signedHeight < 0 && compression === 6) fail("InvalidData")
  const height = Math.abs(signedHeight)
  const pixelCount = width * height
  if (pixelCount > context.maxImagePixels || pixelCount * 4 > context.maxConversionBytes) fail("LimitExceeded")

  let externalMasks = 0
  let redMask = 0
  let greenMask = 0
  let blueMask = 0
  let alphaMask = 0
  if (compression === 0) {
    if (depth === 16) {
      redMask = 0x7c00
      greenMask = 0x03e0
      blueMask = 0x001f
    }
    if (depth === 32 && headerSize >= 108) {
      alphaMask = dib.readUInt32LE(52)
      if (alphaMask !== 0) {
        redMask = 0x00ff0000
        greenMask = 0x0000ff00
        blueMask = 0x000000ff
      }
    }
  } else {
    if (headerSize === 40) externalMasks = compression === 6 ? 16 : 12
    if (headerSize !== 40 && headerSize < 52) fail("Unsupported")
    if (headerSize === 40 && dib.length < 40 + externalMasks) fail("InvalidData")
    redMask = dib.readUInt32LE(40)
    greenMask = dib.readUInt32LE(44)
    blueMask = dib.readUInt32LE(48)
    if (compression === 6 && headerSize !== 40 && headerSize < 56) fail("Unsupported")
    if (externalMasks === 16 || headerSize >= 56) alphaMask = dib.readUInt32LE(52)
  }

  const masks = depth === 16 || compression !== 0 || alphaMask !== 0
    ? [parseMask(redMask, depth, false), parseMask(greenMask, depth, false), parseMask(blueMask, depth, false), parseMask(alphaMask, depth, true)]
    : null
  if (masks) {
    if ((redMask & greenMask) !== 0 || (redMask & blueMask) !== 0 || (greenMask & blueMask) !== 0 || (alphaMask & (redMask | greenMask | blueMask)) !== 0) fail("InvalidData")
  }
  const minimumPixelOffset = headerSize + externalMasks + dib.readUInt32LE(32) * 4
  const pixelOffset = explicitPixelOffset ?? minimumPixelOffset
  if (pixelOffset < minimumPixelOffset) fail("InvalidData")
  const stride = Math.ceil(width * depth / 32) * 4
  if (pixelOffset + stride * height > dib.length) fail("InvalidData")
  return { width, height, topDown: signedHeight < 0, depth, stride, pixelOffset, masks, channels: masks?.[3] ? 4 : 3 }
}

function parseMask(mask, depth, optional) {
  if (mask === 0) {
    if (optional) return null
    fail("InvalidData")
  }
  if (depth < 32 && mask >= 2 ** depth) fail("InvalidData")
  const shift = 31 - Math.clz32((mask & -mask) >>> 0)
  const maximum = mask >>> shift
  if (maximum !== 0xffffffff && (maximum & (maximum + 1)) !== 0) fail("InvalidData")
  return { mask, shift, maximum }
}

class BoundedOutput {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.bytes = Buffer.alloc(0)
    this.length = 0
  }
  reserve(additional) {
    const required = this.length + additional
    if (required > this.maxBytes) fail("LimitExceeded")
    if (required <= this.bytes.length) return
    const bytes = allocate(Math.min(this.maxBytes, Math.max(required, 256, this.bytes.length * 2)))
    this.bytes.copy(bytes, 0, 0, this.length)
    this.bytes = bytes
  }
  append(data) {
    this.reserve(data.length)
    this.bytes.set(data, this.length)
    this.length += data.length
  }
  byte(value) {
    this.reserve(1)
    this.bytes[this.length++] = value
  }
  integer(value) {
    this.reserve(4)
    this.bytes.writeUInt32BE(value, this.length)
    this.length += 4
  }
  chunk(type, data) {
    const tag = Buffer.from(type)
    this.integer(data.length)
    this.append(tag)
    this.append(data)
    this.integer(crc32(data, crc32(tag)))
  }
}

class DeflateWriter {
  constructor(output) {
    this.output = output
    this.bits = 0
    this.bitCount = 0
    this.adlerA = 1
    this.adlerB = 0
    this.previousByte = -1
    output.append(Buffer.from([0x78, 0x01]))
    this.writeBits(1, 1)
    this.writeBits(1, 2)
  }
  writeBits(value, count) {
    this.bits |= value << this.bitCount
    this.bitCount += count
    while (this.bitCount >= 8) {
      this.output.byte(this.bits & 0xff)
      this.bits >>>= 8
      this.bitCount -= 8
    }
  }
  symbol(value) {
    this.writeBits(fixedCodes[value], fixedBits[value])
  }
  async writeData(data, context) {
    for (let offset = 0; offset < data.length; offset += 4096) {
      await context.checkpoint()
      const end = Math.min(data.length, offset + 4096)
      for (let index = offset; index < end; index++) {
        this.adlerA += data[index]
        this.adlerB += this.adlerA
      }
      this.adlerA %= 65521
      this.adlerB %= 65521
    }
    let nextStop = 0
    for (let index = 0; index < data.length;) {
      if (index >= nextStop) {
        await context.checkpoint()
        nextStop = index + 4096
      }
      if (data[index] === this.previousByte) {
        let length = 1
        while (length < 258 && index + length < data.length && data[index + length] === this.previousByte) length++
        if (length >= 3) {
          let run = 0
          while (run + 1 < lengthBases.length && length >= lengthBases[run + 1]) run++
          this.symbol(257 + run)
          if (lengthBits[run] > 0) this.writeBits(length - lengthBases[run], lengthBits[run])
          this.writeBits(0, 5)
          index += length
          continue
        }
      }
      this.previousByte = data[index]
      this.symbol(data[index++])
    }
  }
  finish() {
    this.symbol(256)
    if (this.bitCount > 0) this.output.byte(this.bits & 0xff)
    this.output.integer(((this.adlerB << 16) | this.adlerA) >>> 0)
  }
}

async function encodePng(dib, info, context) {
  const filtered = allocate(info.width * info.channels + 1)
  const output = new BoundedOutput(context.maxBytes)
  output.append(signature)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(info.width, 0)
  header.writeUInt32BE(info.height, 4)
  header[8] = 8
  header[9] = info.channels === 3 ? 2 : 6
  output.chunk("IHDR", header)
  const lengthOffset = output.length
  output.integer(0)
  output.append(Buffer.from("IDAT"))
  const dataOffset = output.length
  if (context.maxBytes < 16) fail("LimitExceeded")
  output.maxBytes = Math.min(context.maxBytes - 16, dataOffset + 0x7fffffff)
  const deflate = new DeflateWriter(output)
  const channels = new Uint8Array(4)
  for (let y = 0; y < info.height; y++) {
    await context.checkpoint()
    const sourceY = info.topDown ? y : info.height - 1 - y
    const sourceOffset = info.pixelOffset + sourceY * info.stride
    const left = [0, 0, 0, 0]
    filtered[0] = 1
    for (let x = 0; x < info.width; x++) {
      if (x % 4096 === 0) await context.checkpoint()
      const offset = sourceOffset + x * (info.depth / 8)
      if (info.depth === 24 || (info.depth === 32 && !info.masks)) {
        channels[0] = dib[offset + 2]
        channels[1] = dib[offset + 1]
        channels[2] = dib[offset]
      } else {
        const value = info.depth === 16 ? dib.readUInt16LE(offset) : dib.readUInt32LE(offset)
        for (let channel = 0; channel < info.channels; channel++) {
          const mask = info.masks[channel]
          const sample = (value & mask.mask) >>> mask.shift
          channels[channel] = Math.floor((sample * 255 + Math.floor(mask.maximum / 2)) / mask.maximum)
        }
      }
      for (let channel = 0; channel < info.channels; channel++) {
        filtered[1 + x * info.channels + channel] = (channels[channel] - left[channel]) & 0xff
        left[channel] = channels[channel]
      }
    }
    await deflate.writeData(filtered, context)
  }
  context.check()
  deflate.finish()
  output.bytes.writeUInt32BE(output.length - dataOffset, lengthOffset)
  let crc = crc32(Buffer.from("IDAT"))
  for (let offset = dataOffset; offset < output.length; offset += 4096) {
    await context.checkpoint()
    crc = crc32(output.bytes.subarray(offset, Math.min(output.length, offset + 4096)), crc)
  }
  output.maxBytes = context.maxBytes
  output.integer(crc)
  output.chunk("IEND", Buffer.alloc(0))
  return output.bytes.subarray(0, output.length)
}
