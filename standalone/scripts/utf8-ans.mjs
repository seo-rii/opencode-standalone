import { utf8Ranges } from "./utf8.mjs"

// Decode binary bytes as rANS symbols drawn from the frozen safe UTF-8 alphabet.
// Their probabilities approximate 2^(-6.85215877 * UTF8 width). These integer
// totals are part of the wire format; never derive them from floating-point math.
export function encodeUtf8AnsPayload(input) {
  const total = 2 ** 30, lower = 2 ** 31
  const frequencies = [0, 873619659, 151072288, 42731397, 6318480]
  const symbols = utf8Ranges.map((ranges) => ranges.reduce((sum, [start, end]) => sum + end - start, 0))
  const minimum = symbols.map((count, width) => count ? Math.floor(frequencies[width] / count) : 0)
  const extras = symbols.map((count, width) => count ? frequencies[width] % count : 0)
  const splits = extras.map((count, width) => count * (minimum[width] + 1))
  const cuts = [0]
  for (let width = 1; width <= 4; width++) cuts[width] = cuts[width - 1] + frequencies[width]
  const output = Buffer.allocUnsafe(input.length * 2 + 64)
  let state = lower, cursor = 0, position = 12
  while (cursor < input.length) {
    // Every state is an integer below 2^39. Its low 30 bits survive ToInt32;
    // multiplication, division and renormalization remain exact Number integers.
    const slot = state & 1073741823
    const width = slot < cuts[1] ? 1 : slot < cuts[2] ? 2 : slot < cuts[3] ? 3 : 4
    const relative = slot - cuts[width - 1]
    const before = relative < splits[width]
    const frequency = minimum[width] + Number(before)
    const rank = before ? Math.floor(relative / frequency) : extras[width] + Math.floor((relative - splits[width]) / frequency)
    const cumulative = cuts[width - 1] + (before ? rank * frequency : splits[width] + (rank - extras[width]) * frequency)
    let next = frequency * Math.floor(state / total) + slot - cumulative
    let read = cursor
    while (next < lower && read < input.length) next = next * 256 + input[read++]
    // Keep an incomplete final renormalization as at most three literal bytes in
    // the header; the inverse must start from a fully normalized state.
    if (next < lower) break
    let group = rank, point = 0
    for (const [start, end] of utf8Ranges[width]) {
      if (group < end - start) { point = start + group; break }
      group -= end - start
    }
    if (width === 1) output[position++] = point
    if (width === 2) { output[position++] = 0xc0 | point >> 6; output[position++] = 0x80 | point & 63 }
    if (width === 3) { output[position++] = 0xe0 | point >> 12; output[position++] = 0x80 | point >> 6 & 63; output[position++] = 0x80 | point & 63 }
    if (width === 4) { output[position++] = 0xf0 | point >> 18; output[position++] = 0x80 | point >> 12 & 63; output[position++] = 0x80 | point >> 6 & 63; output[position++] = 0x80 | point & 63 }
    state = next
    cursor = read
  }
  // Six base94 digits carry the 39-bit final state. One carries the tail length,
  // and five carry its value; all exclude '*' just like the UTF-8 symbols.
  let value = state
  for (let index = 0; index < 6; index++) {
    const digit = value % 94
    output[index] = digit + 32 + Number(digit >= 10)
    value = Math.floor(value / 94)
  }
  const tail = input.length - cursor
  output[6] = tail + 32
  value = 0
  for (let index = tail - 1; index >= 0; index--) value = value * 256 + input[cursor + index]
  for (let index = 0; index < 5; index++) {
    const digit = value % 94
    output[7 + index] = digit + 32 + Number(digit >= 10)
    value = Math.floor(value / 94)
  }
  return output.subarray(0, position)
}

// This function is also embedded by .toString(): it deliberately closes over no
// imports or module state. Decoding traverses codepoints backwards and writes
// binary bytes backwards, without creating a payload-sized JS string or BigInt.
export function decodeUtf8AnsPayload(encoded, size, ranges) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid embedded payload size")
  if (encoded.length < 12) throw new Error("Truncated UTF8 rANS header")
  // A symbol carries less than eight source bits per UTF-8 byte; normalization
  // can carry one extra byte in state and at most three bytes in the tail.
  if (size > encoded.length - 12 + 4) throw new Error("Truncated embedded payload")
  const total = 2 ** 30, lower = 2 ** 31
  const frequencies = [0, 873619659, 151072288, 42731397, 6318480]
  const symbols = ranges.map((list) => list.reduce((sum, [start, end]) => sum + end - start, 0))
  const minimum = symbols.map((count, width) => count ? Math.floor(frequencies[width] / count) : 0)
  const extras = symbols.map((count, width) => count ? frequencies[width] % count : 0)
  const splits = extras.map((count, width) => count * (minimum[width] + 1))
  const cuts = [0]
  for (let width = 1; width <= 4; width++) cuts[width] = cuts[width - 1] + frequencies[width]
  for (let index = 0; index < 12; index++) {
    const point = encoded[index]
    if (point < 32 || point > 126 || point === 42) throw new Error("Invalid UTF8 rANS header digit")
  }
  let state = 0
  for (let index = 5; index >= 0; index--) state = state * 94 + encoded[index] - 32 - Number(encoded[index] > 42)
  const tail = encoded[6] - 32
  let value = 0
  for (let index = 11; index >= 7; index--) value = value * 94 + encoded[index] - 32 - Number(encoded[index] > 42)
  if (state < lower || state >= lower * 256) throw new Error("Invalid UTF8 rANS state")
  if (tail > 3 || tail > size || value >= 2 ** (tail * 8)) throw new Error("Invalid UTF8 rANS tail padding")
  const output = Buffer.allocUnsafe(size)
  let position = size - tail, cursor = encoded.length, terminal = tail === 0
  for (let index = 0; index < tail; index++) { output[position + index] = value & 255; value = Math.floor(value / 256) }
  if (tail > 0) {
    const slot = state & 1073741823
    const width = slot < cuts[1] ? 1 : slot < cuts[2] ? 2 : slot < cuts[3] ? 3 : 4
    const relative = slot - cuts[width - 1]
    const before = relative < splits[width]
    const frequency = minimum[width] + Number(before)
    const rank = before ? Math.floor(relative / frequency) : extras[width] + Math.floor((relative - splits[width]) / frequency)
    const cumulative = cuts[width - 1] + (before ? rank * frequency : splits[width] + (rank - extras[width]) * frequency)
    let next = frequency * Math.floor(state / total) + slot - cumulative
    for (let index = position; next < lower && index < size; index++) next = next * 256 + output[index]
    if (next >= lower) throw new Error("Noncanonical UTF8 rANS tail padding")
  }
  const pointFrequencies = new Uint32Array(encoded.length > 64 ? 65_536 : 128)
  const pointCumulative = new Uint32Array(pointFrequencies.length)
  for (let width = 1; width <= (encoded.length > 64 ? 3 : 1); width++) {
    let rank = 0
    for (const [start, end] of ranges[width]) for (let point = start; point < end; point++) {
      const before = rank < extras[width]
      const frequency = minimum[width] + Number(before)
      pointFrequencies[point] = frequency
      pointCumulative[point] = cuts[width - 1] + (before ? rank * frequency : splits[width] + (rank - extras[width]) * frequency)
      rank++
    }
  }
  while (cursor > 12) {
    let frequency = 0, cumulative = 0
    const last = encoded[cursor - 1]
    if (last < 128) {
      frequency = pointFrequencies[last]
      cumulative = pointCumulative[last]
      if (!frequency) throw new Error("Forbidden UTF8 ASCII codepoint")
      cursor--
    } else {
      let start = cursor - 1
      while ((encoded[start] & 0xc0) === 0x80 && cursor - start <= 4 && start >= 12) start--
      const first = encoded[start]
      const width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
      if (!width || cursor - start !== width || start < 12) throw new Error("Invalid UTF8 symbol")
      let point = first & ((1 << (7 - width)) - 1)
      for (let index = start + 1; index < cursor; index++) point = point * 64 + (encoded[index] & 63)
      if (point < (width === 2 ? 128 : width === 3 ? 2048 : 65536)) throw new Error("Noncanonical UTF8 codepoint")
      if (point < pointFrequencies.length) {
        frequency = pointFrequencies[point]
        cumulative = pointCumulative[point]
        if (!frequency) throw new Error("Forbidden UTF8 codepoint")
      } else {
        let rank = 0
        let found = false
        for (const [begin, end] of ranges[width]) {
          if (point >= begin && point < end) { rank += point - begin; found = true; break }
          rank += end - begin
        }
        if (!found) throw new Error("Forbidden UTF8 codepoint")
        const before = rank < extras[width]
        frequency = minimum[width] + Number(before)
        cumulative = cuts[width - 1] + (before ? rank * frequency : splits[width] + (rank - extras[width]) * frequency)
      }
      cursor = start
    }
    const previous = position
    const threshold = frequency * 512
    // state < 2^39 throughout. Integer quotient/remainder arithmetic therefore
    // stays below Number's 2^53 exact-integer limit, including all products.
    while (state >= threshold) {
      if (position <= 0) throw new Error("Embedded payload exceeds recorded size")
      output[--position] = state & 255
      state = Math.floor(state / 256)
    }
    if (terminal) {
      if (previous === position) throw new Error("Noncanonical UTF8 rANS terminal padding")
      terminal = false
    }
    // Renormalization guarantees 2*f <= state < 512*f, hence this inverse is
    // normalized again. Check only the initial header and final state.
    const quotient = Math.floor(state / frequency)
    state += quotient * (total - frequency) + cumulative
  }
  if (position !== 0 || state !== lower) throw new Error("Truncated or noncanonical UTF8 rANS payload")
  return output
}
