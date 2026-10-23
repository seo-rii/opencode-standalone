import { WASI } from "node:wasi"
import { rendererWasmBase64 } from "./renderer-wasm.mjs"

/** OpenTUI's real computational Context, Scene, buffer, text, and Yoga reactor. */
export function createComputationalRenderer(options = {}) {
  return createRendererClient(createComputationalTransport(), options)
}

/** Own the WASM instance and bounded memory windows; also used to record parity requests. */
export function createComputationalTransport() {
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {}, returnOnExit: true })
  const instance = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(rendererWasmBase64, "base64")), wasi.getImportObject())
  wasi.initialize(instance)
  const api = instance.exports
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  return (request) => {
    const bytes = encoder.encode(JSON.stringify(request))
    if (bytes.length > api.rendererInputCapacity()) throw new RangeError("Renderer request exceeds the 64 KiB input window")
    new Uint8Array(api.memory.buffer, api.rendererInputPointer(), bytes.length).set(bytes)
    const status = api.rendererCall(bytes.length)
    // Calls allocate and can grow linear memory; never retain views across calls.
    const response = JSON.parse(decoder.decode(new Uint8Array(api.memory.buffer, api.rendererOutputPointer(), api.rendererOutputLength())))
    if (status !== 0) throw Object.assign(new Error(`OpenTUI: ${response.err}`), { code: response.err })
    return response
  }
}

/** The same JS boundary is used by the development-only native parity oracle. */
export function createRendererClient(call, options = {}) {
  call({ create_context: options })
  let closed = false
  function request(value) {
    if (closed) throw new Error("Renderer is closed")
    return call(value)
  }
  return {
    request,
    createSession(width, height) { return request({ create_session: { width, height } }) },
    createNode(session, kind, num) {
      const kinds = { root: 0, box: 1, text: 2 }
      if (!Object.hasOwn(kinds, kind)) throw new RangeError("Supported computational node kinds: root, box, text")
      return request({ create_node: { session, kind: kinds[kind], num } })
    },
    move(node, parent, index = 0) { return request({ move_node: { node, parent, index } }) },
    destroyNode(node) { return request({ destroy_node: node }) },
    setStyle(node, options) { return request({ style: { node, ...options } }) },
    setPaint(node, options) { return request({ paint: { node, options } }) },
    setBoxDetails(node, options) { return request({ box_details: { node, options } }) },
    setText(node, text) { return request({ text: { node, text } }) },
    setTextOptions(node, options) { return request({ text_options: { node, options } }) },
    measure(session, root) { return request({ measure: { session, root } }) },
    layout(node, raw_yoga = false) { return request({ layout: { node, raw_yoga } }) },
    textInfo(node) { return request({ text_info: node }) },
    resize(session, width, height) { return request({ resize: { session, width, height } }) },
    capture(session, options = {}) { return request({ capture: { session, ...options } }) },
    close() {
      if (closed) return
      call({ destroy_context: {} })
      closed = true
    },
    [Symbol.dispose]() { this.close() },
  }
}
