import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createX11Clipboard } from "./x11.mjs"
import { startX11Fixture } from "./x11-fixture.mjs"

test("real X11 clipboard exchanges UTF-8, PRIMARY, targets, ownership and incremental bytes with independent Xlib", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-x11-"))
  const fixture = await startX11Fixture(root)
  const clipboard = await createX11Clipboard({ env: fixture.env })
  try {
    assert.deepEqual(await clipboard.read({ preferredTypes: ["text/plain"] }), { status: "empty" })
    assert.deepEqual(await clipboard.writeText("Hello 한글 😀\n", { selection: "clipboard" }), { status: "written" })
    assert.equal(Buffer.from(await fixture.read()).toString(), "Hello 한글 😀\n")
    assert.equal(await fixture.read({ target: "STRING" }), null)
    assert.deepEqual(await clipboard.writeText("Primary 한글", { selection: "primary" }), { status: "written" })
    assert.equal(Buffer.from(await fixture.read({ selection: "primary" })).toString(), "Primary 한글")
    const targets = await fixture.read({ target: "TARGETS" })
    assert.equal(targets.length, 24)
    const timestamp = await fixture.read({ target: "TIMESTAMP" })
    assert.equal(timestamp.length, 4)
    assert.notEqual(Buffer.from(timestamp).readUInt32LE(), 0)
    const large = "한글😀abcdef".repeat(30_000)
    assert.deepEqual(await clipboard.writeText(large), { status: "written" })
    assert.equal(Buffer.from(await fixture.read()).toString(), large)
    assert.deepEqual(await clipboard.writeText("Café"), { status: "written" })
    assert.deepEqual(Buffer.from(await fixture.read({ target: "STRING" })), Buffer.from([67, 97, 102, 233]))
    assert.deepEqual(await clipboard.writeText(""), { status: "written" })
    assert.equal((await clipboard.read({ preferredTypes: ["text/plain"], maxBytes: 0 })).representation.bytes.length, 0)
    const image = Buffer.from("89504e470d0a1a0a0000ff801234", "hex")
    const owner = await fixture.owner({ offers: [{ mimeType: "image/png", bytes: image }, { mimeType: "UTF8_STRING", bytes: Buffer.from("peer 한글") }] })
    try {
      const read = await clipboard.read({ preferredTypes: ["image/jpeg", "image/png", "text/plain"] })
      assert.equal(read.status, "read")
      assert.equal(read.representation.mimeType, "image/png")
      assert.deepEqual(Buffer.from(read.representation.bytes), image)
      const text = await clipboard.read({ preferredTypes: ["text/plain;charset=utf-8"] })
      assert.equal(text.status, "read")
      assert.equal(Buffer.from(text.representation.bytes).toString(), "peer 한글")
      assert.deepEqual(await clipboard.read({ preferredTypes: ["image/png"], maxBytes: 4 }), { status: "limit-exceeded" })
      assert.deepEqual(await clipboard.read({ preferredTypes: ["image/webp"] }), { status: "empty" })
      assert.deepEqual(await clipboard.read({ preferredTypes: ["image/bmp"] }), { status: "unsupported" })
    } finally { await owner.dispose() }
    const emptyImage = await fixture.owner({ offers: [
      { mimeType: "image/png", bytes: Buffer.alloc(0) },
      { mimeType: "image/jpeg", bytes: Buffer.alloc(0) },
      { mimeType: "UTF8_STRING", bytes: Buffer.from("empty PNG fallback 한글") },
    ] })
    try {
      const fallback = await clipboard.read({ preferredTypes: ["image/png", "text/plain"] })
      assert.equal(fallback.status, "read")
      assert.equal(fallback.representation.mimeType, "text/plain")
      assert.equal(Buffer.from(fallback.representation.bytes).toString(), "empty PNG fallback 한글")
      assert.deepEqual(await clipboard.read({ preferredTypes: ["image/png"] }), { status: "empty" })
      const jpeg = await clipboard.read({ preferredTypes: ["image/jpeg"] })
      assert.equal(jpeg.status, "read")
      assert.equal(jpeg.representation.bytes.length, 0)
    } finally { await emptyImage.dispose() }
    const nativeLarge = Buffer.from("Native INCR 한글😀\n".repeat(30_000))
    const incremental = await fixture.owner({ selection: "primary", offers: [{ mimeType: "UTF8_STRING", bytes: nativeLarge }], incremental: true })
    try {
      const read = await clipboard.read({ selection: "primary", preferredTypes: ["text/plain"], maxBytes: 2 * 1024 * 1024 })
      assert.equal(read.status, "read")
      assert.deepEqual(Buffer.from(read.representation.bytes), nativeLarge)
      assert.deepEqual(await clipboard.read({ selection: "primary", preferredTypes: ["text/plain"], maxBytes: 65536 }), { status: "limit-exceeded" })
    } finally { await incremental.dispose() }
    const noHint = await fixture.owner({ offers: [{ mimeType: "UTF8_STRING", bytes: Buffer.from("xclip INCR without hint") }], incremental: "no-hint" })
    try {
      const read = await clipboard.read({ preferredTypes: ["text/plain"] })
      assert.equal(read.status, "read")
      assert.equal(Buffer.from(read.representation.bytes).toString(), "xclip INCR without hint")
    } finally { await noHint.dispose() }
    assert.deepEqual(await clipboard.clear(), { status: "cleared" })
    assert.equal(await fixture.selectionOwner(), 0)
    assert.deepEqual(await clipboard.writeText("lifetime"), { status: "written" })
    await clipboard.dispose()
    assert.equal(await fixture.selectionOwner(), 0)
    await assert.rejects(clipboard.read({}), /disposed/)
  } finally {
    await clipboard.dispose()
    await fixture.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("X11 TCP transport authenticates and preserves target order, Latin1 conversion and long deadlines", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-x11-tcp-"))
  const fixture = await startX11Fixture(root, { tcp: true })
  const clipboard = await createX11Clipboard({ env: { ...fixture.env, DISPLAY: `127.0.0.1${fixture.env.DISPLAY}` }, maxConversionBytes: 0, maxImagePixels: 0 })
  try {
    const owner = await fixture.owner({ offers: [
      { mimeType: "UTF8_STRING", bytes: Buffer.from("third") },
      { mimeType: "text/plain;charset=utf-8", bytes: Buffer.from("second") },
      { mimeType: "text/plain;charset=UTF-8", bytes: Buffer.from("first") },
    ] })
    try {
      const read = await clipboard.read({ preferredTypes: ["text/plain"], timeoutMs: 4294967295 })
      assert.equal(read.status, "read")
      assert.equal(Buffer.from(read.representation.bytes).toString(), "first")
    } finally { await owner.dispose() }
    const latin1 = await fixture.owner({ offers: [{ mimeType: "STRING", bytes: Buffer.from([233]) }] })
    try {
      const read = await clipboard.read({ preferredTypes: ["text/plain"], maxBytes: 2 })
      assert.equal(Buffer.from(read.representation.bytes).toString(), "é")
      assert.deepEqual(await clipboard.read({ preferredTypes: ["text/plain"], maxBytes: 1 }), { status: "limit-exceeded" })
    } finally { await latin1.dispose() }
    assert.deepEqual(await clipboard.writeText("no conversion budget 한글"), { status: "written" })
    assert.equal(Buffer.from(await fixture.read()).toString(), "no conversion budget 한글")
  } finally {
    await clipboard.dispose()
    await fixture.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("X11 cancellation, deadlines, auth rejection and stalled-owner cleanup stay explicit", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-x11-cancel-"))
  const fixture = await startX11Fixture(root)
  const clipboard = await createX11Clipboard({ env: fixture.env })
  try {
    const owner = await fixture.owner({ offers: [{ mimeType: "UTF8_STRING", bytes: Buffer.from("stalled") }], stall: true })
    try {
      const controller = new AbortController()
      const read = clipboard.read({ preferredTypes: ["text/plain"], signal: controller.signal })
      await owner.requested
      controller.abort()
      assert.deepEqual(await read, { status: "cancelled" })
      assert.deepEqual(await clipboard.read({ preferredTypes: ["text/plain"], timeoutMs: 25 }), { status: "timed-out" })
      const pending = clipboard.read({ preferredTypes: ["text/plain"] })
      await owner.requested
      await clipboard.dispose()
      assert.deepEqual(await pending, { status: "cancelled" })
    } finally { await owner.dispose() }
    const badAuth = join(root, "bad-auth")
    await writeFile(badAuth, Buffer.alloc(0))
    await assert.rejects(createX11Clipboard({ env: fixture.env, xauthority: badAuth }), /setup rejected/)
    await assert.rejects(createX11Clipboard({ env: { DISPLAY: "" } }), { code: "X11_UNSUPPORTED" })
  } finally {
    await clipboard.dispose()
    await fixture.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
