import { getBuiltinModule } from "node:process"
import { factoryWasmBrotliBase64 } from "virtual:standalone-tui-factory-wasm"

let compiled
// The checked Context explicitly permits these scene reads during measurement.
// All other calls stay outside the shared request/response windows until layout returns.
const measureReads = new Set(["scene_layout", "scene_style", "scene_has_measure", "scene_get_text", "scene_text_info", "scene_text_lines", "scene_selection_state"])

/** One actual Context reactor per opaque public Context; native IDs may repeat between reactors. */
export function createFactoryTransport({ sceneMeasure } = {}) {
  const { WASI } = getBuiltinModule("node:wasi")
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {}, returnOnExit: true })
  if (!compiled) {
    const { brotliDecompressSync } = getBuiltinModule("node:zlib")
    compiled = new WebAssembly.Module(brotliDecompressSync(Buffer.from(factoryWasmBrotliBase64, "base64")))
  }
  const state = { buffer: undefined, active: 0 }
  const imports = wasi.getImportObject()
  imports.opentui_standalone = {
    scene_measure(contextId, slot, generation, width, widthMode, height, heightMode, pointer) {
      if (!state.buffer || !Number.isInteger(pointer) || pointer < 0 || pointer % 4 !== 0 || pointer + 8 > state.buffer.byteLength) throw new RangeError("WASM measurement output exceeds its checked memory")
      const output = new Float32Array(state.buffer, pointer, 2)
      output.fill(NaN)
      sceneMeasure(contextId, slot, generation, width, widthMode, height, heightMode, output)
    },
  }
  const instance = new WebAssembly.Instance(compiled, imports)
  wasi.initialize(instance)
  const api = instance.exports
  // Resizable WASM buffers preserve existing scoped typed views across memory.grow.
  const buffer = api.memory.toResizableBuffer()
  state.buffer = buffer
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  return {
    buffer,
    call(operation, options, transfer) {
      if (state.active !== 0 && (state.active !== 1 || transfer || !measureReads.has(operation))) throw Object.assign(new Error("Cannot reenter the WASM JSON transport with this operation during measurement"), { code: "ContextBusy", nativeStatus: -6 })
      state.active++
      let generation
      try {
        if (transfer) {
          const input = transfer.input ?? []
          if (input.some((bytes) => !(bytes instanceof Uint8Array))) throw new TypeError("Binary image input must be a Uint8Array")
          const length = input.reduce((total, bytes) => total + bytes.byteLength, 0)
          // The native 256 MiB admission check must see oversized lengths,
          // rather than a count truncated to u32 by the WASM call boundary.
          const status = api.factoryBinaryReserve(Math.min(length, 0xffffffff))
          if (status !== 0) throw binaryError(status)
          generation = api.factoryBinaryGeneration() >>> 0
          const pointer = api.factoryBinaryPointer()
          if (api.factoryBinaryLength() !== length || pointer < 0 || pointer + length > buffer.byteLength) throw new RangeError("WASM binary input exceeds its checked allocation")
          let offset = 0
          const spans = input.map((bytes) => {
            const span = { offset, length: bytes.byteLength, generation }
            // Keep cross-reactor copies bounded without an intermediate JS
            // image allocation; resizable source views survive memory.grow.
            for (let at = 0; at < bytes.byteLength; at += 256 * 1024) {
              const chunk = bytes.subarray(at, Math.min(at + 256 * 1024, bytes.byteLength))
              new Uint8Array(buffer, pointer + offset + at, chunk.byteLength).set(chunk)
            }
            offset += bytes.byteLength
            return span
          })
          if (typeof options === "function") options = options(spans)
        }
        const bytes = encoder.encode(JSON.stringify({ [operation]: options }))
        if (bytes.length > api.factoryInputCapacity()) throw new RangeError("OpenTUI backend request exceeds its bounded input window")
        new Uint8Array(buffer, api.factoryInputPointer(), bytes.length).set(bytes)
        const status = api.factoryCall(bytes.length)
        const response = JSON.parse(decoder.decode(new Uint8Array(buffer, api.factoryOutputPointer(), api.factoryOutputLength())))
        if (status !== 0) throw Object.assign(new Error(response.err), { code: response.err, nativeStatus: response.native_status })
        if (transfer?.read) {
          // Outputs belong to this call, not to its caller. Consume them before
          // the input window is released or edit-event draining calls WASM.
          return transfer.read(response, (span) => {
            if (!Number.isInteger(span.offset) || span.offset < 0 || !Number.isInteger(span.length) || span.length < 0 || span.length > buffer.byteLength - span.offset || span.generation === 0 || span.generation !== (api.factoryBinaryOutputGeneration() >>> 0)) throw new RangeError("WASM binary output exceeds its checked generation or memory")
            return new Uint8Array(buffer, span.offset, span.length)
          })
        }
        return response
      } finally {
        try {
          if (generation !== undefined) {
            const status = api.factoryBinaryRelease(generation)
            if (status !== 0) throw binaryError(status)
          }
        } finally {
          state.active--
        }
      }
    },
  }
}

function binaryError(status) {
  return Object.assign(new Error("OpenTUI binary image transfer was rejected"), { code: "ImageTransfer", nativeStatus: status })
}
