// Four-byte codewords are complete UTF-8 sequences. The frozen ranges exclude
// ASCII controls, '*', Unicode Cc/Cf/Cs and bidi controls, line separators, and
// noncharacters; a payload can never close the block comment that contains it.
// Keep this table stable rather than using a future runtime's Unicode version.
export const utf8Ranges = [
  [],
  [
    [
      32,
      42
    ],
    [
      43,
      127
    ]
  ],
  [
    [
      160,
      173
    ],
    [
      174,
      1536
    ],
    [
      1542,
      1564
    ],
    [
      1565,
      1757
    ],
    [
      1758,
      1807
    ],
    [
      1808,
      2048
    ]
  ],
  [
    [
      2048,
      2192
    ],
    [
      2194,
      2274
    ],
    [
      2275,
      6158
    ],
    [
      6159,
      8203
    ],
    [
      8208,
      8232
    ],
    [
      8239,
      8288
    ],
    [
      8293,
      8294
    ],
    [
      8304,
      55296
    ],
    [
      57344,
      64976
    ],
    [
      65008,
      65279
    ],
    [
      65280,
      65529
    ],
    [
      65532,
      65534
    ]
  ],
  [
    [
      65536,
      69821
    ],
    [
      69822,
      69837
    ],
    [
      69838,
      78896
    ],
    [
      78912,
      113824
    ],
    [
      113828,
      119155
    ],
    [
      119163,
      131070
    ],
    [
      131072,
      196606
    ],
    [
      196608,
      262142
    ],
    [
      262144,
      327678
    ],
    [
      327680,
      393214
    ],
    [
      393216,
      458750
    ],
    [
      458752,
      524286
    ],
    [
      524288,
      589822
    ],
    [
      589824,
      655358
    ],
    [
      655360,
      720894
    ],
    [
      720896,
      786430
    ],
    [
      786432,
      851966
    ],
    [
      851968,
      917502
    ],
    [
      917504,
      917505
    ],
    [
      917506,
      917536
    ],
    [
      917632,
      983038
    ],
    [
      983040,
      1048574
    ],
    [
      1048576,
      1114110
    ]
  ]
]
const symbols = utf8Ranges.map((list) => list.reduce((sum, [start, end]) => sum + end - start, 0))
const words = [1]
for (let width = 1; width <= 4; width++) words[width] = Array.from({ length: width }, (_, index) => symbols[index + 1] * words[width - index - 1]).reduce((sum, count) => sum + count, 0)

export function encodeUtf8Payload(bytes) {
  // 143,969,969 codewords = 2^27 + 9,752,241. Low values can consume a
  // twenty-eighth bit; all other words consume 27. The final word is zero-padded.
  const output = Buffer.allocUnsafe(Math.ceil(bytes.length * 8 / 27) * 4)
  const threshold = words[4] - 2 ** 27
  let position = 0
  const emit = (byte) => {
    output[position++] = byte
  }
  const word = (index) => {
    for (let remaining = 4; remaining > 0;) {
      let width = 1
      while (index >= symbols[width] * words[remaining - width]) {
        index -= symbols[width] * words[remaining - width]
        width++
      }
      let group = Math.floor(index / words[remaining - width])
      index %= words[remaining - width]
      let point
      for (const [start, end] of utf8Ranges[width]) {
        if (group < end - start) { point = start + group; break }
        group -= end - start
      }
      if (width === 1) emit(point)
      if (width === 2) { emit(0xc0 | point >> 6); emit(0x80 | point & 63) }
      if (width === 3) { emit(0xe0 | point >> 12); emit(0x80 | point >> 6 & 63); emit(0x80 | point & 63) }
      if (width === 4) { emit(0xf0 | point >> 18); emit(0x80 | point >> 12 & 63); emit(0x80 | point >> 6 & 63); emit(0x80 | point & 63) }
      remaining -= width
    }
  }
  let value = 0, bits = 0
  for (const byte of bytes) {
    // The reservoir can hold 35 bits. Number arithmetic preserves them, whereas
    // JavaScript bitwise operations would discard the three highest bits.
    value += byte * 2 ** bits
    bits += 8
    if (bits < 28) continue
    const width = value % 2 ** 27 >= threshold ? 27 : 28
    word(value % 2 ** width)
    value = Math.floor(value / 2 ** width)
    bits -= width
  }
  if (bits > 0) word(value)
  return output.subarray(0, position)
}

export function decodeUtf8Payload(encoded, size, ranges) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid embedded payload size")
  if (encoded.length % 4) throw new Error("Truncated UTF8 codeword")
  if (size > Math.floor(encoded.length * 7 / 8)) throw new Error("Truncated embedded payload")
  const symbols = ranges.map((list) => list.reduce((sum, [start, end]) => sum + end - start, 0))
  const words = [1]
  for (let width = 1; width <= 4; width++) words[width] = Array.from({ length: width }, (_, index) => symbols[index + 1] * words[width - index - 1]).reduce((sum, count) => sum + count, 0)
  const threshold = words[4] - 2 ** 27
  // A one-word tail needs at most four lookups; avoid a 256 KiB table for it.
  const ranks = encoded.length > 4 ? new Int32Array(65_536).fill(-1) : undefined
  for (let width = 1; ranks && width <= 3; width++) {
    let rank = 0
    for (const [start, end] of ranges[width]) for (let point = start; point < end; point++) ranks[point] = rank++
  }
  const previousCounts = Array.from({ length: 5 }, (_, remaining) => Array.from({ length: remaining + 1 }, (_, width) => {
    let previous = 0
    for (let index = 1; index < width; index++) previous += symbols[index] * words[remaining - index]
    return previous
  }))
  const powers = [1, 2, 4, 8, 16, 32, 64, 128]
  const output = Buffer.allocUnsafe(size)
  let position = 0, cursor = 0, value = 0, bits = 0
  while (cursor < encoded.length) {
    if (position >= size) throw new Error("Embedded payload exceeds recorded size")
    let index = 0
    if ((encoded[cursor] | encoded[cursor + 1] | encoded[cursor + 2] | encoded[cursor + 3]) < 128) {
      if (ranks) {
        const first = ranks[encoded[cursor++]], second = ranks[encoded[cursor++]], third = ranks[encoded[cursor++]], fourth = ranks[encoded[cursor++]]
        if ((first | second | third | fourth) < 0) throw new Error("Forbidden ASCII codepoint")
        index = first * words[3] + second * words[2] + third * words[1] + fourth
      } else for (let remaining = 4; remaining > 0; remaining--) {
        const point = encoded[cursor++]
        if (point < 32 || point > 126 || point === 42) throw new Error("Forbidden ASCII codepoint")
        index += (point - 32 - Number(point > 42)) * words[remaining - 1]
      }
    } else for (let remaining = 4; remaining > 0;) {
      const first = encoded[cursor++]
      const width = first < 128 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
      if (!width || width > remaining) throw new Error("Invalid UTF8 symbol")
      let point = width === 1 ? first : first & ((1 << (7 - width)) - 1)
      for (let continuation = 1; continuation < width; continuation++) {
        const next = encoded[cursor++]
        if ((next & 0xc0) !== 0x80) throw new Error("Invalid UTF8 continuation")
        point = point * 64 + (next & 63)
      }
      let group = ranks && point < 65_536 ? ranks[point] : -1
      if (width === 4 || !ranks) {
        group = 0
        let found = false
        for (const [start, end] of ranges[width]) {
          if (point >= start && point < end) { group += point - start; found = true; break }
          group += end - start
        }
        if (!found) group = -1
      }
      if (group < 0 || point < [0, 0, 128, 2048, 65536][width]) throw new Error("Forbidden/noncanonical UTF8 codepoint")
      index += previousCounts[remaining][width] + group * words[remaining - width]
      remaining -= width
    }
    const width = (index & 134217727) >= threshold ? 27 : 28
    value += index * powers[bits]
    bits += width
    while (bits >= 8 && position < size) {
      output[position++] = value & 255
      value = Math.floor(value / 256)
      bits -= 8
    }
  }
  if (position !== size || value) throw new Error("Truncated or noncanonical UTF8 payload")
  return output
}
