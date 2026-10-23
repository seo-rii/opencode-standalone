import assert from "node:assert/strict"
import { dlopen, toArrayBuffer } from "node:ffi"
import { fileURLToPath } from "node:url"
import { createUnicode } from "./unicode.mjs"

const extension = { linux: "so", darwin: "dylib", win32: "dll" }[process.platform]
const filename = process.platform === "win32" ? "opentui-unicode-reference.dll" : `libopentui-unicode-reference.${extension}`
const directory = process.platform === "win32" ? "bin" : "lib"
const native = dlopen(fileURLToPath(new URL(`.cache/build/${directory}/${filename}`, import.meta.url)), {
  inputPointer: { arguments: [], return: "pointer" },
  inputCapacity: { arguments: [], return: "uint32" },
  resultPointer: { arguments: [], return: "pointer" },
  textWidth: { arguments: ["uint32", "uint8", "uint8", "uint8"], return: "uint32" },
  wrapPosition: { arguments: ["uint32", "uint32", "uint8", "uint8", "uint8"], return: "void" },
})
const input = new Uint8Array(toArrayBuffer(native.functions.inputPointer(), native.functions.inputCapacity(), false))
const result = new DataView(toArrayBuffer(native.functions.resultPointer(), 12, false))
const unicode = createUnicode()
const encoder = new TextEncoder()
const fixtures = [
  "", "OpenCode", "한국어와 English", "e\u0301", "🇰🇷🇺🇸", "👩🏽‍💻", "👨‍👩‍👧‍👦", "a\tb", "a\n한글",
  "·Ω→", "\x00\x1b\x7f\x85", "\u0301\u0300a", "क्‍ष", "مرحبا بالعالم", "日本語 / 中文", "A\ufe0f⚙️Z",
]
let widths = 0
let wraps = 0
try {
  for (const text of fixtures) {
    const bytes = encoder.encode(text)
    input.set(bytes)
    for (const [method, name] of ["wcwidth", "unicode", "no_zwj", "unicode_wide"].entries()) {
      for (const tab of [0, 4, 8]) {
        for (const notation of [0, 1]) {
          const options = { method: name, tabWidth: tab, controlDisplay: notation ? "notation" : "hidden" }
          const label = JSON.stringify({ text, ...options })
          assert.equal(unicode.width(text, options), native.functions.textWidth(bytes.length, method, tab, notation), label)
          widths++
          for (let columns = 0; columns <= 16; columns++) {
            native.functions.wrapPosition(bytes.length, columns, method, tab, notation)
            const wasm = unicode.wrap(text, columns, options)
            assert.deepEqual([wasm.byteOffset, wasm.graphemeCount, wasm.columnsUsed], [result.getUint32(0, true), result.getUint32(4, true), result.getUint32(8, true)], `${label} columns=${columns}`)
            assert.equal(wasm.text + wasm.remainder, text, label)
            wraps++
          }
        }
      }
    }
  }
} finally {
  native.lib.close()
}
console.log(JSON.stringify({ upstream: "OpenTUI 0.6.6 utf8.zig", nativeWasmParity: true, widths, wraps }))

