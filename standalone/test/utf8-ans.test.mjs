import assert from "node:assert/strict"
import { isUtf8 } from "node:buffer"
import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { test } from "node:test"
import { promisify } from "node:util"
import { utf8Ranges } from "../scripts/utf8.mjs"
import { encodeUtf8AnsPayload, decodeUtf8AnsPayload } from "../scripts/utf8-ans.mjs"

test("UTF-8 rANS agrees with independent integer-reference wire vectors", () => {
  // Produced with a separate Python reference using unbounded integer divmod.
  // The vectors include zero, two and three literal tail bytes and astral UTF-8.
  for (const [input, expected] of [
    ["", "657d50503c20202020202020"],
    ["00", "2061227a5d2020202020202020"],
    ["ff", "6463227a5d2020202020202020"],
    ["000102030405", "66704c713027225f2e20202020527c4a"],
    ["000102030405060708090a0b0c0d0e0f", "602b2329472820202020202020527c4af2ba86be5c3775787c472c447b47"],
    ["ffffffffffffffffffffffffffffffff", "5a2c786b4e2e20202020202020527c4b7b66382f614758ec8d9128254e70"],
    ["c63c1ed377c68af81c1f7d49e0fbe66ef1", "7c67563a332223316224342020527c4bd091202c2f3a772944335432"],
  ]) {
    const bytes = Buffer.from(input, "hex"), encoded = Buffer.from(expected, "hex")
    assert.deepEqual(encodeUtf8AnsPayload(bytes), encoded)
    assert.deepEqual(decodeUtf8AnsPayload(encoded, bytes.length, utf8Ranges), bytes)
  }
  const encoded = encodeUtf8AnsPayload(Buffer.from(Array.from({ length: 256 }, (_, index) => index)))
  assert.equal(encoded.length, 310)
  assert.equal(createHash("sha256").update(encoded).digest("hex"), "763af822ae6f979cc837b4e24d7ad75c95958ac027f3bb6bd61e0ef08892b491")
})

test("UTF-8 rANS preserves every two-byte input and every short tail", { timeout: 30_000 }, () => {
  const bytes = Buffer.alloc(2)
  for (let value = 0; value < 65_536; value++) {
    bytes.writeUInt16LE(value)
    const encoded = encodeUtf8AnsPayload(bytes)
    assert.ok(isUtf8(encoded))
    assert.equal(encoded.indexOf(0), -1)
    assert.equal(encoded.indexOf(42), -1)
    assert.deepEqual(decodeUtf8AnsPayload(encoded, bytes.length, utf8Ranges), bytes)
  }
  const cases = [Buffer.alloc(0), Buffer.from(Array.from({ length: 256 }, (_, index) => index)), Buffer.alloc(65_536, 255), randomBytes(262_144)]
  for (let size = 1; size <= 128; size++) cases.push(randomBytes(size))
  for (const input of cases) {
    const encoded = encodeUtf8AnsPayload(input)
    assert.ok(isUtf8(encoded))
    assert.doesNotMatch(encoded.toString("utf8"), /[\p{Cc}\p{Cf}\p{Cs}\p{Bidi_Control}\u2028\u2029]/u)
    assert.equal(encoded.indexOf(42), -1)
    assert.deepEqual(decodeUtf8AnsPayload(encoded, input.length, utf8Ranges), input)
  }
})

test("UTF-8 rANS rejects malformed UTF-8, forbidden symbols, and invalid sizes", () => {
  const header = Buffer.from("2061227a5d20202020202020", "hex")
  for (const hex of [
    "00", "2a", "7f", "c080", "c280", "c2ad", "e02080", "e080a0", "eda080", "e280ae", "e280a8", "efbfbe",
    "f0808080", "f4908080", "f5908080", "80", "c2", "e080", "8080808080", "e0c2a0",
  ]) assert.throws(() => decodeUtf8AnsPayload(Buffer.concat([header, Buffer.from(hex, "hex")]), 1, utf8Ranges), /UTF8/)
  for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => decodeUtf8AnsPayload(header, size, utf8Ranges), /size/)
  assert.throws(() => decodeUtf8AnsPayload(header, Number.MAX_SAFE_INTEGER, utf8Ranges), /Truncated/)
  for (let size = 0; size < 12; size++) assert.throws(() => decodeUtf8AnsPayload(header.subarray(0, size), 0, utf8Ranges), /header/)
  const encoded = encodeUtf8AnsPayload(Buffer.from([0, 1, 2, 3]))
  assert.throws(() => decodeUtf8AnsPayload(encoded, 0, utf8Ranges), /size/)
  assert.throws(() => decodeUtf8AnsPayload(encoded, 3, utf8Ranges), /exceeds|noncanonical/)
  assert.throws(() => decodeUtf8AnsPayload(encoded, 5, utf8Ranges), /noncanonical|Truncated/)
  assert.throws(() => decodeUtf8AnsPayload(encoded.subarray(0, -1), 4, utf8Ranges), /noncanonical|Truncated|state/)
})

test("UTF-8 rANS rejects invalid normalization states and noncanonical tail padding", () => {
  const header = Buffer.from("657d50503c20202020202020", "hex")
  for (const digit of [0, 31, 42, 127, 255]) {
    const invalid = Buffer.from(header)
    invalid[0] = digit
    assert.throws(() => decodeUtf8AnsPayload(invalid, 0, utf8Ranges), /header/)
  }
  for (const state of [Buffer.alloc(6, 32), Buffer.alloc(6, 126)]) {
    assert.throws(() => decodeUtf8AnsPayload(Buffer.concat([state, header.subarray(6)]), 0, utf8Ranges), /state/)
  }
  const oversizedTail = Buffer.from(header)
  oversizedTail[6] = 36
  assert.throws(() => decodeUtf8AnsPayload(oversizedTail, 4, utf8Ranges), /tail/)
  const hiddenTailValue = Buffer.from(header)
  hiddenTailValue[7] = 33
  assert.throws(() => decodeUtf8AnsPayload(hiddenTailValue, 0, utf8Ranges), /padding/)
  const sufficientTail = Buffer.from(header)
  sufficientTail[6] = 33
  assert.throws(() => decodeUtf8AnsPayload(sufficientTail, 1, utf8Ranges), /Noncanonical.*tail/)
  assert.throws(() => decodeUtf8AnsPayload(sufficientTail, 0, utf8Ranges), /tail/)
  // This independently calculated extra '#' symbol consumes no binary bytes.
  // It would recover the same bytes as the canonical six-byte encoding without
  // the terminal-padding check, but the forward transducer would have stopped.
  const extraSymbol = Buffer.from("3164695a3e2020202020202020527c4a745f23", "hex")
  assert.throws(() => decodeUtf8AnsPayload(extraSymbol, 6, utf8Ranges), /terminal padding/)
  const empty = encodeUtf8AnsPayload(Buffer.alloc(0))
  assert.throws(() => decodeUtf8AnsPayload(Buffer.concat([empty, Buffer.from(" ")]), 0, utf8Ranges), /exceeds|state|padding/)
})

test("UTF-8 rANS round-trips a browser-sized binary with a 96 MiB Node heap", { timeout: 30_000 }, async () => {
  const result = await promisify(execFile)(process.execPath, ["--no-addons", "--max-old-space-size=96", "--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { isUtf8 } from "node:buffer"
    import { randomBytes } from "node:crypto"
    import { utf8Ranges } from ${JSON.stringify(new URL("../scripts/utf8.mjs", import.meta.url).href)}
    import { encodeUtf8AnsPayload, decodeUtf8AnsPayload } from ${JSON.stringify(new URL("../scripts/utf8-ans.mjs", import.meta.url).href)}
    const bytes = randomBytes(24 * 1024 * 1024)
    const encoded = encodeUtf8AnsPayload(bytes)
    assert.ok(isUtf8(encoded))
    assert.equal(encoded.indexOf(0), -1)
    assert.equal(encoded.indexOf(42), -1)
    assert.ok(encoded.length < bytes.length * 1.17)
    assert.ok(decodeUtf8AnsPayload(encoded, bytes.length, utf8Ranges).equals(bytes))
    console.log("large-utf8-ans-round-trip-ok")
  `], { env: { PATH: "" }, timeout: 25_000, maxBuffer: 65_536 })
  assert.equal(result.stdout.trim(), "large-utf8-ans-round-trip-ok")
})
