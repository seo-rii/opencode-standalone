import assert from "node:assert/strict"
import { PassThrough, Writable } from "node:stream"
import { CliRenderer, NativeSession, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core"

const host = createHostClipboard({ maxWriteBytes: 5 })
const invalid = [
  () => createHostClipboard({ timeoutMs: -1 }),
  () => createHostClipboard({ timeoutMs: 0.5 }),
  () => createHostClipboard({ maxConcurrentOperations: 0 }),
  () => createHostClipboard({ maxProviderTransfers: 0 }),
  () => createHostClipboard({ waylandSeat: "" }),
  () => createHostClipboard({ waylandSeat: "seat\0" }),
]
for (const create of invalid) assert.throws(create, { name: /Error$/ })
await assert.rejects(host.read({ preferredTypes: [] }), /at least one MIME/)
await assert.rejects(host.read({ preferredTypes: ["text/plain; charset=utf-8"] }), /valid MIME essence/)
await assert.rejects(host.read({ preferredTypes: ["text/plain"], selection: "other" }), /selection must/)
await assert.rejects(host.writeText(""), /non-empty/)
await assert.rejects(host.writeText("a\0b"), /NUL/)
await assert.rejects(host.writeText("\ud800"), /surrogates/)
await assert.rejects(host.writeText("한글"), /5 byte limit/)
assert.deepEqual(await host.writeText("한a"), { status: "unsupported" })
assert.deepEqual(await host.read({ preferredTypes: ["TEXT/PLAIN", "image/png"] }), { status: "unsupported" })
assert.deepEqual(await host.clear(), { status: "unsupported" })

const controller = new AbortController()
controller.abort()
assert.deepEqual(await host.read({ preferredTypes: ["text/plain"], signal: controller.signal }), { status: "cancelled" })
assert.deepEqual(await host.writeText("a", { signal: controller.signal }), { status: "cancelled" })
assert.deepEqual(await host.clear({ signal: controller.signal }), { status: "cancelled" })
const timeout = createHostClipboard({ timeoutMs: 0 })
assert.deepEqual(await timeout.read({ preferredTypes: ["text/plain"] }), { status: "timed-out" })
assert.deepEqual(await timeout.writeText("a"), { status: "timed-out" })
assert.deepEqual(await timeout.clear(), { status: "timed-out" })
await timeout.dispose()
const disposal = host.dispose()
assert.equal(host.dispose(), disposal)
await disposal
await assert.rejects(host.read({ preferredTypes: ["text/plain"] }), /disposed/)
await assert.rejects(host.writeText("a"), /disposed/)
await assert.rejects(host.clear(), /disposed/)

const chunks = []
const stdin = new PassThrough()
const stdout = new Writable({ write(bytes, _encoding, complete) { chunks.push(Buffer.from(bytes)); complete() } })
const session = new NativeSession(stdout)
const renderer = new CliRenderer(stdin, stdout, 44, 4, {
  nativeSession: session, remote: false, useMouse: false, useConsole: false,
  exitSignals: [], openConsoleOnError: false, flushTerminalInputOnClose: false,
})
const clipboard = createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) })
try {
  await session.setupTerminal({ useAlternateScreen: false, mouse: false, mouseMovement: false, kittyKeyboardFlags: 0 })
  const text = "standalone 한국어 👩🏽‍💻"
  const result = await clipboard.writeText(text, { destination: "best-available" })
  assert.equal(result.host.status, "unsupported")
  assert.equal(result.terminal.status, "attempted")
  await session.idle()
  const output = Buffer.concat(chunks).toString("utf8")
  assert.ok(output.includes(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x1b\\`), "actual native feed must contain the terminal OSC 52 payload")
  const clear = await clipboard.clear({ destination: "terminal-only", selection: "primary" })
  assert.equal(clear.host.status, "not-attempted")
  assert.equal(clear.terminal.status, "attempted")
  await session.idle()
  assert.ok(Buffer.concat(chunks).toString("utf8").includes("\x1b]52;p;\x1b\\"))
  const before = Buffer.concat(chunks).length
  assert.equal((await clipboard.writeText("host only", { destination: "host-only" })).host.status, "unsupported")
  assert.equal((await clipboard.writeText("cancelled", { destination: "all-available", signal: controller.signal })).terminal.status, "not-attempted")
  await session.idle()
  assert.equal(Buffer.concat(chunks).length, before)
  const disposed = clipboard.dispose()
  assert.equal(clipboard.dispose(), disposed)
  await disposed
  await assert.rejects(clipboard.writeText("closed", { destination: "terminal-only" }), /disposed/)
  await assert.rejects(clipboard.read({ preferredTypes: ["text/plain"] }), /disposed/)
} finally {
  await clipboard.dispose()
  renderer.destroy()
  await renderer.closed
  stdin.destroy()
  stdout.destroy()
}
assert.equal(session.disposed, true)
assert.equal(session.contextDisposed, true)
console.log(JSON.stringify({ validation: true, unsupported: true, cancelled: true, timedOut: true, disposed: true, actualRenderer: true, nativeOsc52: true }))
