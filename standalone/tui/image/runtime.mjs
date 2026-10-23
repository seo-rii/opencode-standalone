import { getBuiltinModule } from "node:process"
import { imageWasmBrotliBase64 } from "./wasm.mjs"

let compiled

export function createImageTransport() {
  const { WASI } = getBuiltinModule("node:wasi")
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {}, returnOnExit: true })
  if (!compiled) {
    const { brotliDecompressSync } = getBuiltinModule("node:zlib")
    compiled = new WebAssembly.Module(brotliDecompressSync(Buffer.from(imageWasmBrotliBase64, "base64")))
  }
  const instance = new WebAssembly.Instance(compiled, wasi.getImportObject())
  wasi.initialize(instance)
  const api = instance.exports
  const buffer = api.memory.toResizableBuffer()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let active = false
  return {
    buffer,
    call(request) {
      if (active) throw new Error("Cannot reenter the synchronous image reactor")
      const bytes = encoder.encode(JSON.stringify(request))
      if (bytes.length > api.imageInputCapacity()) throw new RangeError("Image request exceeds the bounded 1 MiB input window")
      new Uint8Array(buffer, api.imageInputPointer(), bytes.length).set(bytes)
      active = true
      try {
        const status = api.imageCall(bytes.length)
        const response = JSON.parse(decoder.decode(new Uint8Array(buffer, api.imageOutputPointer(), api.imageOutputLength())))
        if (status) throw Object.assign(new Error(response.err), { code: response.err, nativeStatus: response.native_status })
        return response
      } finally {
        active = false
      }
    },
  }
}
