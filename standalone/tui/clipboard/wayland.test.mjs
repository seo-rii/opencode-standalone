import assert from "node:assert/strict"
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { closeSync, fstatSync } from "node:fs"
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createRequire, isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { createWaylandClipboard } from "./wayland.mjs"
import { waylandClient, waylandFixture } from "./wayland-fixture.mjs"

const directory = dirname(fileURLToPath(import.meta.url))

async function owner(fixture, backend, bytes, mime = "text/plain", selection = "clipboard") {
  const client = waylandClient(fixture, "wl-copy", ["--foreground", "--type", mime, ...(selection === "primary" ? ["--primary"] : [])], bytes)
  const expected = Buffer.from(bytes)
  const deadline = performance.now() + 5000
  const essence = mime.split(";")[0].toLowerCase()
  while (performance.now() < deadline) {
    const result = await backend.read({ preferredTypes: [essence], selection, maxBytes: expected.length + 1 })
    if (result.status === "read" && result.representation.bytes.equals(expected)) return client
    if (client.child.exitCode !== null) throw new Error(`wl-copy failed: ${JSON.stringify(await client.result)}`)
    await setTimeout(10)
  }
  await client.dispose()
  throw new Error("Independent wl-copy did not become the selection owner")
}

test("direct Wayland clipboard interoperates with real wlroots clipboard and primary clients", { timeout: 30_000 }, async () => {
  const fixture = await waylandFixture()
  let backend
  const clients = []
  try {
    backend = await createWaylandClipboard({ env: fixture.env, timeoutMs: 0xffffffff })
    assert.deepEqual(await backend.clear({}), { status: "cleared" })
    assert.deepEqual(await backend.read({ preferredTypes: ["text/plain"], timeoutMs: 0xffffffff }), { status: "empty" })
    const text = "Wayland 한글 👩🏽‍💻\nsecond line\n"
    for (const selection of ["clipboard", "primary"]) {
      assert.deepEqual(await backend.writeText(text, { selection }), { status: "written" })
      const pasted = waylandClient(fixture, "wl-paste", ["--no-newline", "--type", "text/plain", ...(selection === "primary" ? ["--primary"] : [])])
      clients.push(pasted)
      const result = await pasted.result
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(result.stdout, Buffer.from(text))
      const read = await backend.read({ preferredTypes: ["image/png", "TEXT/PLAIN"], selection })
      assert.equal(read.status, "read")
      assert.equal(read.representation.mimeType, "text/plain")
      assert.deepEqual(read.representation.bytes, Buffer.from(text))
      assert.deepEqual(await backend.clear({ selection }), { status: "cleared" })
      assert.deepEqual(await backend.read({ preferredTypes: ["text/plain"], selection }), { status: "empty" })
    }
    const types = waylandClient(fixture, "wl-paste", ["--list-types"])
    clients.push(types)
    assert.notEqual((await types.result).code, 0)
    const large = Buffer.from("크게 👩🏽‍💻\n".repeat(32768))
    assert.deepEqual(await backend.writeText(large.toString(), {}), { status: "written" })
    const pasted = waylandClient(fixture, "wl-paste", ["--no-newline", "--type", "text/plain;charset=utf-8"])
    clients.push(pasted)
    const result = await pasted.result
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(result.stdout, large)
    assert.deepEqual(await backend.read({ preferredTypes: ["text/plain"], maxBytes: large.length - 1 }), { status: "limit-exceeded" })
    assert.deepEqual((await backend.read({ preferredTypes: ["text/plain"], maxBytes: large.length })).representation.bytes, large)
    clients.push(await owner(fixture, backend, "replacement 외부 owner"))
    assert.equal((await backend.read({ preferredTypes: ["text/plain"] })).representation.bytes.toString(), "replacement 외부 owner")
    assert.deepEqual(await backend.clear({}), { status: "cleared" })
    assert.equal((await backend.read({ preferredTypes: ["text/plain"] })).status, "empty")
  } finally {
    await backend?.dispose()
    for (const client of clients) await client.dispose()
    await fixture.dispose()
  }
})

test("Wayland data-control preserves image bytes, UTF-8 MIME matching and original read statuses", { timeout: 30_000 }, async () => {
  const fixture = await waylandFixture()
  let backend
  const clients = []
  try {
    backend = await createWaylandClipboard({ env: fixture.env, timeoutMs: 10_000 })
    const bytes = Buffer.from(Array.from({ length: 196613 }, (_, index) => index % 256))
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      clients.push(await owner(fixture, backend, bytes, mime))
      if (mime === "image/png") {
        // Exercise the real offer parser without advertising text types that
        // this image owner never supplied to the compositor.
        const offer = { ...backend.selections.clipboard, mimes: [] }
        for (const value of ["text/plain", "TEXT/PLAIN", "text/plain;charset=utf-8", "text/plain; charset=\"UTF-8\"", "text/plain;ignored=yes", "text/plain; charset=utf-8;other=value", "image/png"]) {
          const encoded = Buffer.from(value)
          const packet = Buffer.alloc(4 + ((encoded.length + 4) & ~3))
          packet.writeUInt32LE(encoded.length + 1)
          encoded.copy(packet, 4)
          backend.event(offer.id, offer, 0, packet)
        }
        assert.deepEqual(offer.mimes, ["text/plain", "image/png"])
      }
      const result = await backend.read({ preferredTypes: ["application/json", mime], maxBytes: bytes.length })
      assert.equal(result.status, "read")
      assert.equal(result.representation.mimeType, mime)
      assert.deepEqual(result.representation.bytes, bytes)
      assert.equal((await backend.read({ preferredTypes: ["text/plain"] })).status, "empty")
      assert.equal((await backend.read({ preferredTypes: ["application/json"] })).status, "unsupported")
      assert.equal((await backend.read({ preferredTypes: [mime], maxBytes: 0 })).status, "limit-exceeded")
    }
    clients.push(await owner(fixture, backend, "UTF-8 한글", "TEXT/PLAIN; charset=\"utf-8\""))
    const utf8 = await backend.read({ preferredTypes: ["text/plain"] })
    assert.equal(utf8.status, "read")
    assert.equal(utf8.representation.bytes.toString(), "UTF-8 한글")
    assert.equal((await backend.read({ preferredTypes: ["image/bmp"] })).status, "unsupported")
    assert.equal((await backend.read({ preferredTypes: ["text/plain;charset=iso-8859-1"] })).status, "unsupported")
  } finally {
    await backend?.dispose()
    for (const client of clients) await client.dispose()
    await fixture.dispose()
  }
})

test("Wayland transfer cancellation, deadlines, seat selection and disposal close their descriptors", { timeout: 30_000 }, async () => {
  await assert.rejects(createWaylandClipboard({ env: {} }), { code: "WAYLAND_UNSUPPORTED" })
  const fixture = await waylandFixture()
  let backend
  const clients = []
  try {
    backend = await createWaylandClipboard({ env: fixture.env, waylandSeat: "seat0", timeoutMs: 10_000 })
    await assert.rejects(createWaylandClipboard({ env: fixture.env, waylandSeat: "absent-seat", timeoutMs: 10_000 }), { code: "WAYLAND_UNSUPPORTED" })
    const before = (await readdir("/proc/self/fd")).length
    const client = await owner(fixture, backend, "paused external owner")
    clients.push(client)
    client.child.kill("SIGSTOP")
    for (let index = 0; index < 4; index++) {
      assert.deepEqual(await backend.read({ preferredTypes: ["text/plain"], timeoutMs: 30 }), { status: "timed-out" })
      assert.deepEqual(await backend.read({ preferredTypes: ["text/plain"], signal: AbortSignal.timeout(30) }), { status: "cancelled" })
    }
    assert.deepEqual(await backend.writeText("cancelled", { signal: AbortSignal.abort() }), { status: "cancelled" })
    assert.deepEqual(await backend.clear({ signal: AbortSignal.abort() }), { status: "cancelled" })
    const pending = backend.read({ preferredTypes: ["text/plain"] })
    await setTimeout(10)
    const disposal = backend.dispose()
    assert.equal(backend.dispose(), disposal)
    await disposal
    assert.deepEqual(await pending, { status: "cancelled" })
    client.child.kill("SIGCONT")
    await client.dispose()
    assert.ok((await readdir("/proc/self/fd")).length <= before, "transfers and Wayland connection descriptors must be released")
    await assert.rejects(backend.read({ preferredTypes: ["text/plain"] }), /disposed/)
    await assert.rejects(backend.writeText("closed", {}), /disposed/)
    await assert.rejects(backend.clear({}), /disposed/)
  } finally {
    for (const client of clients) { client.child.kill("SIGCONT"); await client.dispose() }
    await backend?.dispose()
    await fixture.dispose()
  }
})

test("copied one-JS Wayland provider serves real clipboard clients with empty PATH and no addons", { timeout: 30_000 }, async () => {
  const fixture = await waylandFixture()
  const root = await mkdtemp(join(tmpdir(), "opencode-wayland-copy-"))
  const clients = []
  let child
  let closed
  let lines
  try {
    const artifact = join(directory, "../.cache/wayland-fixture/proof.mjs")
    const result = await build({ entryPoints: [join(directory, "wayland-proof.mjs")], outfile: artifact, bundle: true, platform: "node", format: "esm", target: "node26", keepNames: true, legalComments: "inline", metafile: true, logLevel: "warning" })
    for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) assert.ok(isBuiltin(dependency.path), `Unexpected runtime dependency: ${dependency.path}`)
    const copied = join(root, "clipboard.mjs")
    await copyFile(artifact, copied)
    const env = { ...fixture.env, PATH: "", HOME: root, USERPROFILE: root, XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), TMPDIR: root, TMP: root, TEMP: root }
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "LD_LIBRARY_PATH"]) delete env[name]
    child = spawn(process.execPath, ["--no-addons", "--experimental-ffi", "--disable-warning=ExperimentalWarning", copied], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000 })
    const errors = []
    child.stderr.on("data", (bytes) => errors.push(bytes))
    closed = once(child, "close")
    lines = createInterface({ input: child.stdout })
    const iterator = lines[Symbol.asyncIterator]()
    assert.deepEqual(JSON.parse((await iterator.next()).value), { ready: true })
    for (const selection of ["clipboard", "primary"]) {
      const client = waylandClient(fixture, "wl-paste", ["--no-newline", "--type", "text/plain", ...(selection === "primary" ? ["--primary"] : [])])
      clients.push(client)
      const pasted = await client.result
      assert.equal(pasted.code, 0, pasted.stderr)
      assert.equal(pasted.stdout.toString(), "copied Wayland 한글 👩🏽‍💻")
    }
    child.stdin.end("inspect\n")
    assert.deepEqual(JSON.parse((await iterator.next()).value), { copied: true, clipboard: true, primary: true, read: true, written: true, cleared: true, disposed: true })
    const [code, signal] = await closed
    assert.equal(code, 0, Buffer.concat(errors).toString())
    assert.equal(signal, null)
    assert.equal(Buffer.concat(errors).toString(), "")
    assert.deepEqual((await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name), ["clipboard.mjs"])
    assert.ok((await readFile(copied, "utf8")).includes("ext_data_control_manager_v1"))
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGTERM")
    await closed
    lines?.close()
    for (const client of clients) await client.dispose()
    await fixture.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("a stopped real Wayland compositor cannot accumulate unbounded timed-out sync objects", { timeout: 30_000 }, async () => {
  const fixture = await waylandFixture()
  let backend
  try {
    backend = await createWaylandClipboard({ env: fixture.env, timeoutMs: 10_000 })
    fixture.compositor.kill("SIGSTOP")
    const results = await Promise.all(Array.from({ length: 1030 }, () => backend.read({ preferredTypes: ["text/plain"], timeoutMs: 50 })))
    assert.ok(results.some((result) => result.status === "timed-out"), "in-flight callbacks must respect deadlines")
    assert.ok(results.some((result) => result.status === "failed" && /object limit/.test(result.error.message)), "new admissions must stop at the object cap")
    assert.ok(results.every((result) => ["timed-out", "failed"].includes(result.status)))
    fixture.compositor.kill("SIGCONT")
    const deadline = performance.now() + 5000
    while ((await backend.read({ preferredTypes: ["text/plain"] })).status !== "empty") {
      assert.ok(performance.now() < deadline, "acknowledged callback IDs must become reusable after compositor recovery")
      await setTimeout(10)
    }
    assert.deepEqual(await backend.writeText("after compositor recovery", {}), { status: "written" })
    assert.equal((await backend.read({ preferredTypes: ["text/plain"] })).representation.bytes.toString(), "after compositor recovery")
  } finally { fixture.compositor.kill("SIGCONT"); await backend?.dispose(); await fixture.dispose() }
})

test("inherited WAYLAND_SOCKET ownership ends when its clipboard backend is disposed", { timeout: 30_000 }, async () => {
  const fixture = await waylandFixture()
  const ffi = createRequire(import.meta.url)("node:ffi")
  const native = ffi.dlopen(null, {
    socket: { arguments: ["i32", "i32", "i32"], return: "i32" },
    connect: { arguments: ["i32", "pointer", "u32"], return: "i32" },
  })
  let descriptor
  let backend
  const clients = []
  try {
    descriptor = native.functions.socket(1, 1 | 0x80000, 0)
    assert.ok(descriptor >= 0)
    const pathname = Buffer.from(join(fixture.env.XDG_RUNTIME_DIR, fixture.env.WAYLAND_DISPLAY))
    const address = Buffer.alloc(110)
    address.writeUInt16LE(1)
    pathname.copy(address, 2)
    assert.equal(native.functions.connect(descriptor, address, pathname.length + 3), 0)
    backend = await createWaylandClipboard({ env: { WAYLAND_SOCKET: String(descriptor) }, timeoutMs: 10_000 })
    assert.deepEqual(await backend.writeText("inherited socket 한글", {}), { status: "written" })
    const client = waylandClient(fixture, "wl-paste", ["--no-newline", "--type", "text/plain"])
    clients.push(client)
    assert.equal((await client.result).stdout.toString(), "inherited socket 한글")
    const provider = backend.providers.clipboard
    assert.ok(provider.bytes.length > 0)
    await backend.dispose()
    assert.equal(provider.bytes.length, 0, "disposed ownership must release the retained payload")
    assert.equal(backend.providers.clipboard, undefined)
    assert.equal(backend.providers.primary, undefined)
    assert.throws(() => fstatSync(descriptor), { code: "EBADF" })
    descriptor = undefined
  } finally {
    if (backend) { await backend.dispose(); descriptor = undefined }
    if (descriptor !== undefined) closeSync(descriptor)
    for (const client of clients) await client.dispose()
    native.lib.close()
    await fixture.dispose()
  }
})

test("a real socket failure while destroying a retired Wayland offer still settles its read", { timeout: 30_000 }, async () => {
  const fixture = await waylandFixture()
  const ffi = createRequire(import.meta.url)("node:ffi")
  const native = ffi.dlopen(null, { shutdown: { arguments: ["i32", "i32"], return: "i32" } })
  let backend
  let client
  try {
    backend = await createWaylandClipboard({ env: fixture.env, timeoutMs: 10_000 })
    client = await owner(fixture, backend, "retired external selection")
    const offer = backend.selections.clipboard
    client.child.kill("SIGSTOP")
    const pending = backend.read({ preferredTypes: ["text/plain"] })
    const deadline = performance.now() + 5000
    while (!offer.readers) { assert.ok(performance.now() < deadline); await setTimeout(1) }
    assert.deepEqual(await backend.writeText("replacement selection", {}), { status: "written" })
    assert.equal(offer.selection, false)
    const transport = backend.io
    const send = transport.send.bind(transport)
    let injected = false
    transport.send = (bytes, descriptors) => {
      if (bytes.readUInt32LE() === offer.id && bytes.readUInt16LE(4) === 1) { injected = true; assert.equal(native.functions.shutdown(transport.descriptor, 2), 0) }
      return send(bytes, descriptors)
    }
    client.child.kill("SIGCONT")
    const result = await Promise.race([pending, setTimeout(1000).then(() => { throw new Error("Retired-offer cleanup left its read unresolved") })])
    assert.equal(injected, true, "the fault must occur in the offer destructor send")
    assert.equal(result.status, "failed")
    assert.match(result.error.message, /send Wayland message/)
  } finally {
    client?.child.kill("SIGCONT")
    await client?.dispose()
    await backend?.dispose()
    native.lib.close()
    await fixture.dispose()
  }
})
