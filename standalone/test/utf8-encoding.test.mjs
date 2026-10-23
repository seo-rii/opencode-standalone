import assert from "node:assert/strict"
import { isUtf8 } from "node:buffer"
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { test } from "node:test"
import { promisify } from "node:util"
import { utf8Ranges, encodeUtf8Payload, decodeUtf8Payload } from "../scripts/utf8.mjs"

test("UTF-8 codewords preserve their frozen alphabet and independent wire vectors", () => {
  const counts = utf8Ranges.map((ranges) => ranges.reduce((sum, [start, end]) => sum + end - start, 0))
  assert.deepEqual(counts, [0, 94, 1878, 61371, 1048417])
  const words = [1]
  for (let length = 1; length <= 4; length++) words[length] = counts.slice(1, length + 1).reduce((sum, count, index) => sum + count * words[length - index - 1], 0)
  assert.equal(words[4], 143_969_969)
  assert.ok(words[4] > 2 ** 27 && words[4] < 2 ** 28)
  const forbidden = /[\p{Cc}\p{Cf}\p{Cs}\p{Bidi_Control}\u2028\u2029]/u
  for (let width = 1; width <= 4; width++) {
    let previous = -1
    for (const [start, end] of utf8Ranges[width]) {
      assert.ok(start > previous && end > start)
      previous = end
      assert.equal(Buffer.byteLength(String.fromCodePoint(start)), width)
      assert.equal(Buffer.byteLength(String.fromCodePoint(end - 1)), width)
      for (let point = start; point < end; point++) {
        assert.equal(point === 42 || forbidden.test(String.fromCodePoint(point)), false)
        assert.equal(point >= 0xfdd0 && point <= 0xfdef || (point & 0xffff) >= 0xfffe, false)
      }
    }
  }
  for (const [input, expected] of [
    ["00", "20202020"], ["01", "20202021"], ["5d", "2020207e"], ["5e", "20202120"],
    ["8422", "2020c2a0"], ["a00f12", "20e0a080"],
    // The largest codeword is U+10FFFD; the final word contains zero padding.
    ["b0ce9408", "f48fbfbd20202020"],
    // Adjacent inputs straddle the 27/28-bit width threshold.
    ["b0ce9400", "27c7a02520202020"], ["b1ce9400", "27c7a02620202020"],
  ]) {
    const bytes = Buffer.from(input, "hex"), encoded = Buffer.from(expected, "hex")
    assert.deepEqual(encodeUtf8Payload(bytes), encoded)
    assert.deepEqual(decodeUtf8Payload(encoded, bytes.length, utf8Ranges), bytes)
  }
})

test("UTF-8 encoding round-trips every two-byte input and every short tail", { timeout: 30_000 }, () => {
  const bytes = Buffer.alloc(2)
  for (let value = 0; value < 65_536; value++) {
    bytes.writeUInt16LE(value)
    const encoded = encodeUtf8Payload(bytes)
    assert.ok(isUtf8(encoded))
    assert.equal(encoded.indexOf(42), -1)
    assert.deepEqual(decodeUtf8Payload(encoded, bytes.length, utf8Ranges), bytes)
  }
  const cases = [Buffer.alloc(0), Buffer.from(Array.from({ length: 256 }, (_, index) => index)), Buffer.alloc(65_536, 255), randomBytes(262_144)]
  for (let size = 1; size <= 128; size++) cases.push(randomBytes(size))
  for (const input of cases) {
    const encoded = encodeUtf8Payload(input)
    assert.equal(encoded.length % 4, 0)
    assert.ok(isUtf8(encoded))
    assert.equal(encoded.indexOf(0), -1)
    assert.equal(encoded.indexOf(42), -1)
    assert.deepEqual(decodeUtf8Payload(encoded, input.length, utf8Ranges), input)
  }
})

test("UTF-8 decoding rejects forbidden characters, malformed codewords, and invalid sizes", () => {
  for (const hex of [
    "00202020", "2a2f2020", "c0802020", "c2802020", "c2ad2020", "e0208020",
    "e080af20", "eda08020", "e280ae20", "e280a820", "efbfbe20", "f0808080", "f4908080", "f5908080", "202020c2",
  ]) assert.throws(() => decodeUtf8Payload(Buffer.from(hex, "hex"), 2, utf8Ranges), /UTF8|codepoint|ASCII/)
  for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => decodeUtf8Payload(Buffer.alloc(0), size, utf8Ranges), /size/)
  assert.throws(() => decodeUtf8Payload(Buffer.alloc(0), Number.MAX_SAFE_INTEGER, utf8Ranges), /Truncated/)
  for (const size of [1, 2, 3]) assert.throws(() => decodeUtf8Payload(Buffer.alloc(size, 32), 1, utf8Ranges), /codeword/)
  const encoded = encodeUtf8Payload(Buffer.from([0, 1]))
  assert.throws(() => decodeUtf8Payload(encoded, 1, utf8Ranges), /noncanonical/)
  assert.throws(() => decodeUtf8Payload(encoded, 4, utf8Ranges), /Truncated/)
  assert.throws(() => decodeUtf8Payload(encoded, 0, utf8Ranges), /exceeds/)
  assert.throws(() => decodeUtf8Payload(Buffer.concat([encoded, Buffer.alloc(4, 32)]), 2, utf8Ranges), /exceeds/)
})

test("UTF-8 encoding round-trips a browser-archive-sized binary with a 96 MiB Node heap", { timeout: 30_000 }, async () => {
  const result = await promisify(execFile)(process.execPath, ["--no-addons", "--max-old-space-size=96", "--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { isUtf8 } from "node:buffer"
    import { randomBytes } from "node:crypto"
    import { utf8Ranges, encodeUtf8Payload, decodeUtf8Payload } from ${JSON.stringify(new URL("../scripts/utf8.mjs", import.meta.url).href)}
    const bytes = randomBytes(24 * 1024 * 1024)
    const encoded = encodeUtf8Payload(bytes)
    assert.ok(isUtf8(encoded))
    assert.equal(encoded.indexOf(0), -1)
    assert.equal(encoded.indexOf(42), -1)
    assert.ok(encoded.length < bytes.length * 1.19)
    assert.ok(decodeUtf8Payload(encoded, bytes.length, utf8Ranges).equals(bytes))
    console.log("large-utf8-round-trip-ok")
  `], { env: { PATH: "" }, timeout: 25_000, maxBuffer: 65_536 })
  assert.equal(result.stdout.trim(), "large-utf8-round-trip-ok")
})
