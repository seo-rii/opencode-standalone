import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createComputationalTransport, createRendererClient } from "./renderer.mjs"
import { rendererTrace } from "./renderer-fixtures.mjs"

const filename = `opentui-renderer-reference${process.platform === "win32" ? ".exe" : ""}`
const executable = fileURLToPath(new URL(`.cache/renderer-build/bin/${filename}`, import.meta.url))

for (const width of [44, 100]) {
  const requests = []
  const wasm = createComputationalTransport()
  const wasmTrace = rendererTrace((options) => createRendererClient((request) => {
    requests.push(request)
    return wasm(request)
  }, options), width)
  // Running the native bridge in its own process prevents Node's C++ exception
  // runtime from interposing on the oracle's libc++/libunwind allocation errors.
  const result = callNative(requests.map((request) => JSON.stringify(request)).join("\n") + "\n")
  assert.equal(result.status, 0, result.stderr || String(result.error ?? result.signal))
  const responses = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line))
  assert.equal(responses.length, requests.length)
  let cursor = 0
  const nativeTrace = rendererTrace((options) => createRendererClient((request) => {
    assert.deepEqual(request, requests[cursor], "native trace must issue the same exact checked-bridge requests")
    const response = responses[cursor++]
    if (response.status !== 0) throw Object.assign(new Error(`OpenTUI: ${response.response.err}`), { code: response.response.err })
    return response.response
  }, options), width)
  assert.equal(cursor, responses.length, "native trace must consume every response including context teardown")
  assert.deepEqual(wasmTrace, nativeTrace, `real scene/layout/cell/exception parity at ${width} columns`)
}
const request = '{"exception_probe":0}'
const exactWindow = callNative(request + " ".repeat(64 * 1024 - request.length) + '\n{"exception_probe":1}\n')
assert.equal(exactWindow.status, 0, exactWindow.stderr)
assert.deepEqual(exactWindow.stdout.trimEnd().split("\n").map((line) => JSON.parse(line)), [{ status: 0, response: 0 }, { status: 0, response: 1 }])
const overflow = callNative("x".repeat(64 * 1024 + 1) + "\n")
assert.equal(overflow.status, 2)
assert.match(overflow.stderr, /64 KiB input window/)
console.log(JSON.stringify({ upstream: "OpenTUI 0.6.6 Context/Scene/Buffer + patched Yoga", nativeWasmParity: true, terminalWidths: [44, 100], captures: 8, exceptionResults: [0, 1, 2, 1, 4], nativeOracle: "isolated executable", nativeInputBounds: true }))

function callNative(input) {
  return spawnSync(executable, [], {
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    env: { PATH: "" },
  })
}
