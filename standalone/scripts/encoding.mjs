// Every printable ASCII character. A newline separates '*' from a following
// slash, and the decoder accepts only that exact escape inside each payload.
export const alphabet = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32))
  .join("")
const digits = Buffer.from(alphabet, "ascii")

export function encodePayload(bytes) {
  // Each pair consumes at least 13 bits. Delimiter escapes cannot overlap, so
  // at most half as many extra bytes are needed. Keep storage binary and bounded.
  const rawMaximum = Math.ceil(bytes.length * 16 / 13) + 2
  const output = Buffer.allocUnsafe(rawMaximum + Math.floor(rawMaximum / 2))
  let position = 0
  let value = 0
  let bits = 0
  for (const byte of bytes) {
    value |= byte << bits
    bits += 8
    if (bits <= 13) continue
    // 95² = 8192 + 833, so the low 833 values can consume a fourteenth bit.
    const width = (value & 8191) >= 833 ? 13 : 14
    const pair = value & ((1 << width) - 1)
    value >>>= width
    bits -= width
    const first = digits[pair % 95]
    if (position > 0 && output[position - 1] === 42 && first === 47) output[position++] = 10
    output[position++] = first
    const second = digits[Math.floor(pair / 95)]
    if (first === 42 && second === 47) output[position++] = 10
    output[position++] = second
  }
  if (bits > 0) {
    const first = digits[value % 95]
    if (position > 0 && output[position - 1] === 42 && first === 47) output[position++] = 10
    output[position++] = first
    if (bits > 7 || value >= 95) {
      const second = digits[Math.floor(value / 95)]
      if (first === 42 && second === 47) output[position++] = 10
      output[position++] = second
    }
  }
  return output.toString("ascii", 0, position)
}

// This exact implementation is also embedded into the generated launcher.
export function decodePayload(encoded, size, alphabet) {
  // The exported alphabet is contiguous ASCII, so digit lookup is subtraction.
  const first = alphabet.charCodeAt(0)
  const output = Buffer.alloc(size)
  let pair = -1
  let value = 0
  let bits = 0
  let position = 0
  for (let index = 0; index < encoded.length; index++) {
    const byte = encoded[index]
    if (byte === 10) {
      if (index === 0 || encoded[index - 1] !== 42 || encoded[index + 1] !== 47) throw new Error("Invalid embedded payload escape")
      continue
    }
    if (byte < 32 || byte > 126) throw new Error("Invalid embedded payload encoding")
    if (byte === 47 && index > 0 && encoded[index - 1] === 42) throw new Error("Unescaped embedded comment delimiter")
    const digit = byte - first
    if (pair < 0) {
      pair = digit
      continue
    }
    pair += digit * 95
    value |= pair << bits
    bits += (pair & 8191) >= 833 ? 13 : 14
    while (bits >= 8) {
      if (position >= size) throw new Error("Embedded payload exceeds its recorded size")
      output[position++] = value & 255
      value >>>= 8
      bits -= 8
    }
    pair = -1
  }
  if (pair >= 0) {
    if (position >= size) throw new Error("Embedded payload exceeds its recorded size")
    output[position++] = (value | pair << bits) & 255
  }
  if (position !== size) throw new Error("Truncated embedded payload")
  return output
}
