import assert from "node:assert/strict"
import { createInterface } from "node:readline"
import { PassThrough, Writable } from "node:stream"
import { CliRenderer, NativeSession, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core"
import { createClipboardAdapter } from "../../../packages/tui/src/clipboard.ts"

// The copied artifact runs the published policies and the real application
// adapter. Its independent Xlib peer and X server live in the parent test.
const scopes = new Map()
const controllers = new Map()
const chunks = []
let terminal

async function renderer() {
  if (terminal) return terminal
  const stdin = new PassThrough()
  const stdout = new Writable({ write(bytes, _encoding, complete) { chunks.push(Buffer.from(bytes)); complete() } })
  const session = new NativeSession(stdout)
  const view = new CliRenderer(stdin, stdout, 44, 4, {
    nativeSession: session, remote: false, useMouse: false, useConsole: false,
    exitSignals: [], openConsoleOnError: false, flushTerminalInputOnClose: false,
  })
  terminal = { stdin, stdout, session, view }
  await session.setupTerminal({ useAlternateScreen: false, mouse: false, mouseMovement: false, kittyKeyboardFlags: 0 })
  return terminal
}

async function run(message) {
  if (message.operation === "open") {
    assert.ok(!scopes.has(message.scope))
    scopes.set(message.scope, { host: createHostClipboard(message.options) })
    return { opened: true }
  }
  if (message.operation === "abort") {
    const controller = controllers.get(message.token)
    assert.ok(controller, "the real public operation must start before cancellation")
    controller.abort()
    return { aborted: true }
  }
  if (message.operation === "terminal-output") {
    if (terminal) await terminal.session.idle()
    return Buffer.concat(chunks).toString("base64")
  }
  if (message.operation === "shutdown") {
    for (const scope of scopes.values()) await (scope.adapter ?? scope.host).dispose()
    if (terminal) {
      terminal.view.destroy()
      await terminal.view.closed
      terminal.stdin.destroy()
      terminal.stdout.destroy()
      assert.equal(terminal.session.contextDisposed, true)
    }
    return { closed: true }
  }
  const scope = scopes.get(message.scope)
  assert.ok(scope, "clipboard scope must exist")
  if (message.operation === "tui-open") {
    const actual = await renderer()
    scope.clipboard = createClipboard({ host: scope.host, terminal: createRendererClipboardAdapter(actual.view) })
    scope.adapter = createClipboardAdapter(scope.clipboard)
    return { adapter: true }
  }
  if (message.operation === "dispose") {
    const service = scope.adapter ?? scope.host
    const result = service.dispose()
    assert.equal(service.dispose(), result)
    await result
    return { disposed: true }
  }
  if (message.operation === "tui-read") return scope.adapter.read()
  if (message.operation === "tui-write") {
    await scope.adapter.write(message.text)
    return { written: true }
  }
  const controller = message.cancelled ? undefined : new AbortController()
  if (message.token) controllers.set(message.token, controller)
  const options = { ...message.options, signal: message.cancelled ? AbortSignal.abort() : controller.signal }
  try {
    if (message.operation === "read") {
      const result = await scope.host.read(options)
      if (result.status === "failed") return { status: "failed", error: { name: result.error.name, message: result.error.message, code: result.error.code } }
      if (result.status !== "read") return result
      return { status: "read", representation: { mimeType: result.representation.mimeType, base64: Buffer.from(result.representation.bytes).toString("base64") } }
    }
    if (message.operation === "write") return scope.host.writeText(message.text, options)
    if (message.operation === "clear") return scope.host.clear(options)
    throw new Error(`Unknown clipboard proof operation: ${message.operation}`)
  } finally {
    if (message.token) controllers.delete(message.token)
  }
}

const input = createInterface({ input: process.stdin })
input.on("line", (line) => {
  const message = JSON.parse(line)
  run(message).then((result) => {
    if (result?.status === "failed") result = { status: "failed", error: { name: result.error.name, message: result.error.message, code: result.error.code } }
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n")
    if (message.operation === "shutdown") {
      input.close()
      process.stdin.destroy()
    }
  }, (error) => {
    process.stdout.write(JSON.stringify({ id: message.id, error: { name: error.name, message: error.message, code: error.code } }) + "\n")
  })
})
