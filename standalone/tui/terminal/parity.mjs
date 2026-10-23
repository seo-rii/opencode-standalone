import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
// Replay the actual production transport, changing only its build-time virtual
// module reference to the checked-in reactor payload for this developer proof.
const source = (await readFile(path.join(directory, "backend/transport.mjs"), "utf8"))
  .replace('"virtual:standalone-tui-factory-wasm"', JSON.stringify(pathToFileURL(path.join(directory, "factory-wasm.mjs")).href))
const { createFactoryTransport } = await import(`data:text/javascript,${encodeURIComponent(source)}`)
const totals = { requests: 0, captures: 0, binaryOutputs: 0, checkedFailures: 0, widths: [20, 44, 100] }

for (const width of totals.widths) {
  const transport = createFactoryTransport()
  const trace = []
  const call = (operation, options, { input, output = false, failure = false } = {}) => {
    let request
    let response
    let binary = ""
    let status = 0
    const transferring = input !== undefined || output
    const value = typeof options === "function" ? options : () => options
    const finalOptions = transferring ? (spans) => {
      const result = value(spans)
      request = { [operation]: result }
      return result
    } : value()
    if (!transferring) request = { [operation]: finalOptions }
    try {
      response = transport.call(operation, finalOptions, transferring ? {
        input: input ?? [],
        read(result, view) {
          if (output) binary = Buffer.from(view(result)).toString("hex")
          return result
        },
      } : undefined)
    } catch (error) {
      status = 1
      response = { err: error.code, native_status: error.nativeStatus }
    }
    assert.equal(status, Number(failure), JSON.stringify({ request, response }))
    const cells = response?.handle && typeof response.char === "number" ? Object.fromEntries([
      ["char", 4], ["fg", 8], ["bg", 8], ["attributes", 4],
    ].map(([name, size]) => [name, Buffer.from(new Uint8Array(transport.buffer, response[name], response.width * response.height * size)).toString("hex")])) : null
    trace.push({ request, input: input ? Buffer.concat(input) : Buffer.alloc(0), transferring, expected: { status, response, binary, cells } })
    totals.requests++
    if (cells) totals.captures++
    if (output && !failure) totals.binaryOutputs++
    if (failure) totals.checkedFailures++
    return output && !failure ? Buffer.from(binary, "hex") : response
  }
  const terminal = (operation, options, transfer) => call("terminal", typeof options === "function" ? (spans) => ({ [operation]: options(spans) }) : { [operation]: options }, transfer)
  call("context_create", { object_capacity: 128, render_cells_max: 4096 })
  const handle = terminal("create", { cols: width, rows: 6, max_scrollback: 65536 })
  const target = call("buffer_create", { width, height: 8, width_method: 0 })
  const write = (text) => terminal("write", ([bytes]) => ({ terminal: handle, bytes }), { input: [typeof text === "string" ? Buffer.from(text) : text] })
  const command = (command, argument = 0) => terminal("command", { terminal: handle, command, argument })
  const compose = (x = 0, y = 0) => {
    terminal("compose", { terminal: handle, target, x, y })
    const lease = call("buffer_lease", { buffer: target })
    const text = call("lease_resolved", { lease: lease.handle, add_line_breaks: true, include_lengths: true })
    call("lease_release", { lease: lease.handle })
    terminal("cursor", { terminal: handle })
    return Buffer.from(text.bytes, "base64").toString()
  }
  write("hello 한국어 é 👩🏽‍💻")
  const legacyEmoji = compose()
  write("\x1bc\x1b[?2027hhello 한국어 é 👩🏽‍💻")
  const graphemeEmoji = compose()
  if (width === 20) {
    assert.match(legacyEmoji, /👩🏽‍[ \n]*💻/u)
    assert.match(graphemeEmoji, /hello 한국어 é 👩🏽‍💻/u)
  }
  write("\x1bc\x1b]4;1;#1256ab\x1b\\\x1b[1;3;4;31mRGB 한국어 é 👩🏽‍💻\x1b[0m\r\nsecond row")
  compose()
  terminal("selection", { terminal: handle, start_x: 0, start_y: 0, end_x: 2, end_y: 0 })
  assert.equal(terminal("selected_text", { terminal: handle }, { output: true }).toString(), "RGB")
  compose()
  command(2)
  assert.equal(terminal("selected_text", { terminal: handle }, { output: true }).length, 0)
  write("\x1b]10;rgb:12/34/56\x07\x1b]11;rgb:09/08/07\x07\x1b[2;3H\x1b[5 q")
  compose()
  command(3, 1)
  compose()
  command(3, 0)
  write("\x1b[?1049hALT-SCREEN\x1b[7m inverse\x1b[0m")
  assert.match(compose(), /ALT-SCREEN/)
  write("\x1b[?1049l")
  compose()
  write("\x1bc" + Array.from({ length: 24 }, (_, index) => `line-${String(index).padStart(2, "0")}`).join("\r\n"))
  assert.match(compose(), /line-23/)
  command(1, -3)
  assert.doesNotMatch(compose(), /line-23/)
  command(1, 1000)
  assert.match(compose(), /line-23/)
  const resized = width === 100 ? 44 : 100
  terminal("resize", { terminal: handle, cols: resized, rows: 6 })
  call("buffer_resize", { buffer: target, width: resized, height: 8 })
  compose()
  terminal("resize", { terminal: handle, cols: width, rows: 6 })
  call("buffer_resize", { buffer: target, width, height: 8 })
  command(0)
  compose(-1, 1)
  command(0)
  compose()
  write("\x1bc\x1b[?20")
  write("04h\x1b[?1004h\x1b[?1003h\x1b[?1006h")
  assert.equal(terminal("encode_paste", ([bytes]) => ({ terminal: handle, bytes }), { input: [Buffer.from("one\ntwo")], output: true }).toString(), "\x1b[200~one\ntwo\x1b[201~")
  assert.equal(terminal("encode_focus", { terminal: handle, focused: 1 }, { output: true }).toString(), "\x1b[I")
  assert.equal(terminal("encode_focus", { terminal: handle, focused: 0 }, { output: true }).toString(), "\x1b[O")
  const key = (physical, text = "", options = {}) => terminal("encode_key", ([key, text]) => ({ terminal: handle, options, key, text }), { input: [Buffer.from(physical), Buffer.from(text)], output: true })
  assert.equal(key("Enter").toString(), "\r")
  assert.equal(key("KeyC", "c", { mods: 2, unshifted_codepoint: 99 }).toString(), "\x03")
  const mouse = { terminal: handle, options: { action: 2, x: 2, y: 1 } }
  assert.equal(terminal("encode_mouse", mouse, { output: true }).toString(), "\x1b[<35;3;2M")
  assert.equal(terminal("encode_mouse", mouse, { output: true }).length, 0)
  terminal("resize", { terminal: handle, cols: width, rows: 6 })
  assert.ok(terminal("encode_mouse", mouse, { output: true }).length > 0)
  write("\x1b[>3u")
  assert.equal(key("KeyA", "", { action: 0, unshifted_codepoint: 97 }).toString(), "\x1b[97;1:3u")
  write("\x1b[<u\x1b[5n\x1b[6n\x1b[c")
  assert.match(terminal("drain_responses", { terminal: handle }, { output: true }).toString(), /^\x1b\[0n/)
  assert.equal(terminal("drain_responses", { terminal: handle }, { output: true }).length, 0)
  write("\x1b]10;#123456\x1b\\\x1b]10;?\x07")
  assert.equal(terminal("drain_responses", { terminal: handle }, { output: true }).toString(), "\x1b]10;rgb:1212/3434/5656\x07")
  terminal("selection", { terminal: handle, start_x: width, start_y: 0, end_x: 0, end_y: 0 }, { failure: true })
  terminal("command", { terminal: handle, command: 99 }, { failure: true })
  terminal("encode_key", ([key, text]) => ({ terminal: handle, options: { mods: 64 }, key, text }), { input: [Buffer.from("KeyA"), Buffer.from("a")], output: true, failure: true })
  terminal("encode_paste", ([bytes]) => ({ terminal: handle, bytes }), { input: [Buffer.alloc(1024 * 1024 + 1)], output: true, failure: true })
  terminal("cursor", { terminal: { ...handle, context: "9999" } }, { failure: true })
  terminal("destroy", { terminal: handle })
  terminal("write", ([bytes]) => ({ terminal: handle, bytes }), { input: [Buffer.from("stale")], failure: true })
  const replacement = terminal("create", { cols: 2, rows: 2, max_scrollback: 0 })
  assert.notDeepEqual(replacement, handle)
  terminal("destroy", { terminal: replacement })
  call("object_destroy", { handle: target })
  call("context_destroy", {})

  const frames = trace.flatMap((entry) => {
    const request = Buffer.from(JSON.stringify(entry.request))
    return [Buffer.from(`${Number(entry.transferring)} ${entry.input.length} ${request.length}\n`), entry.input, request]
  })
  const native = spawnSync(path.join(directory, ".cache/terminal-native-build/bin/opentui-terminal-reference"), [], {
    input: Buffer.concat(frames), encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(native.status, 0, native.stderr || native.error?.message || `Native oracle exited ${native.signal}`)
  const actual = native.stdout.trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(actual.length, trace.length)
  for (let index = 0; index < actual.length; index++) {
    assert.deepEqual(normalize(actual[index]), normalize(trace[index].expected), `Native ${width}-column request ${index}: ${JSON.stringify(trace[index].request).slice(0, 240)}`)
  }
}
const payload = await readFile(path.join(directory, "factory-wasm.mjs"))
const receipt = { ...totals, factoryPayloadSha256: createHash("sha256").update(payload).digest("hex"), platform: process.platform, arch: process.arch, runtime: process.version }
await writeFile(path.join(directory, ".cache/terminal-native-parity.json"), JSON.stringify(receipt, null, 2) + "\n")
console.log(JSON.stringify(receipt))

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value === null || typeof value !== "object") return value
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
  if ("offset" in result && "length" in result && "generation" in result) result.offset = "<owned-output-pointer>"
  if ("char" in result && "attributes" in result && "handle" in result) {
    for (const lane of ["char", "fg", "bg", "attributes"]) result[lane] = `<${lane}-pointer>`
  }
  return result
}
