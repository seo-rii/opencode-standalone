import { wasmBase64 } from "./unicode-wasm.mjs"

const methods = ["wcwidth", "unicode", "no_zwj", "unicode_wide"]

/** Actual OpenTUI Unicode computation compiled to freestanding WASM. */
export function createUnicode() {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(wasmBase64, "base64")))
  const api = instance.exports
  const input = new Uint8Array(api.memory.buffer, api.inputPointer(), api.inputCapacity())
  const result = new DataView(api.memory.buffer, api.resultPointer(), 12)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  function prepare(text, options) {
    if (typeof text !== "string") throw new TypeError("text must be a string")
    const method = methods.indexOf(options.method ?? "unicode")
    if (method < 0) throw new RangeError(`Unknown OpenTUI width method: ${options.method}`)
    const tab = options.tabWidth ?? 4
    if (!Number.isInteger(tab) || tab < 0 || tab > 255) throw new RangeError("tabWidth must be an integer from 0 to 255")
    const display = options.controlDisplay ?? "hidden"
    if (display !== "hidden" && display !== "notation") throw new RangeError("controlDisplay must be hidden or notation")
    const encoded = encoder.encodeInto(text, input)
    if (encoded.read !== text.length) throw new RangeError(`text exceeds the ${input.length}-byte proof input window`)
    return [encoded.written, method, tab, display === "notation" ? 1 : 0]
  }

  return {
    width(text, options = {}) {
      return api.textWidth(...prepare(text, options))
    },
    wrap(text, columns, options = {}) {
      if (!Number.isInteger(columns) || columns < 0 || columns > 0xffffffff) throw new RangeError("columns must be an unsigned 32-bit integer")
      const [length, method, tab, display] = prepare(text, options)
      api.wrapPosition(length, columns, method, tab, display)
      const byteOffset = result.getUint32(0, true)
      return {
        byteOffset,
        graphemeCount: result.getUint32(4, true),
        columnsUsed: result.getUint32(8, true),
        text: decoder.decode(input.subarray(0, byteOffset)),
        remainder: decoder.decode(input.subarray(byteOffset, length)),
      }
    },
  }
}

