import assert from "node:assert/strict"
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { standalonePackagePlugin } from "../backend/package.mjs"
import { adaptPublishedClipboardSource } from "../clipboard.mjs"
import images from "../image/fixtures.json" with { type: "json" }
import { startX11Fixture } from "./x11-fixture.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), "opencode-host-clipboard-"))
const artifact = join(temporary, "host-proof.mjs")
const bundled = await build({
  entryPoints: [join(directory, "host-proof.mjs")], outfile: artifact,
  bundle: true, platform: "node", format: "esm", target: "node26", keepNames: true,
  legalComments: "inline", metafile: true, logLevel: "warning", external: ["bun:*"],
  plugins: [
    { name: "host-clipboard-proof", setup(bundle) {
      bundle.onResolve({ filter: /^virtual:standalone-tui-factory-wasm$/ }, () => ({ path: join(directory, "../factory-wasm.mjs") }))
      bundle.onResolve({ filter: /^opencode:tui-clipboard$/ }, () => ({ path: join(directory, "../clipboard.mjs") }))
    } },
    await standalonePackagePlugin({ transform: adaptPublishedClipboardSource }),
  ],
})
for (const output of Object.values(bundled.metafile.outputs)) {
  for (const dependency of output.imports) assert.ok(isBuiltin(dependency.path), `Unexpected clipboard runtime dependency: ${dependency.path}`)
}
after(() => rm(temporary, { recursive: true, force: true }))

test("copied published host clipboard exchanges real Xlib text, images, primary and bounded operations", { timeout: 30_000 }, async () => {
  const fixture = await startX11Fixture(join(temporary, "host-display"))
  const client = await copiedClient(join(temporary, "host-child"), fixture.env)
  const owners = []
  const own = async (options) => {
    const owner = await fixture.owner(options)
    owners.push(owner)
    return owner
  }
  const text = "한글 👩🏽‍💻 clipboard\r\nsecond line"
  const png = Buffer.from(images["display-p3-rgba.png"], "base64")
  try {
    await client.request("open", { scope: "main", options: { maxImagePixels: 0, maxConversionBytes: 0 } })
    assert.deepEqual(await client.request("write", { scope: "main", text }), { status: "written" })
    assert.deepEqual(await fixture.read({}), new Uint8Array(Buffer.from(text)))
    assert.deepEqual(await client.request("write", { scope: "main", text: "PRIMARY 한글", options: { selection: "primary" } }), { status: "written" })
    assert.deepEqual(await fixture.read({ selection: "primary" }), new Uint8Array(Buffer.from("PRIMARY 한글")))
    assert.deepEqual(await fixture.read({}), new Uint8Array(Buffer.from(text)))
    const finalText = "마지막 👩🏽‍💻 ".repeat(32_768)
    assert.deepEqual(await Promise.all([
      client.request("write", { scope: "main", text: "first queued write" }),
      client.request("write", { scope: "main", text: finalText }),
    ]), [{ status: "written" }, { status: "written" }])
    assert.deepEqual(await fixture.read({}), new Uint8Array(Buffer.from(finalText)))
    assert.deepEqual(await client.request("clear", { scope: "main" }), { status: "cleared" })
    assert.equal(await fixture.read({}), null)
    assert.deepEqual(await fixture.read({ selection: "primary" }), new Uint8Array(Buffer.from("PRIMARY 한글")))

    await own({ offers: [{ mimeType: "image/png", bytes: png }, { mimeType: "text/plain", bytes: Buffer.from(text) }] })
    assertRead(await client.request("read", { scope: "main", options: { preferredTypes: ["image/png", "text/plain"] } }), "image/png", png)
    assertRead(await client.request("read", { scope: "main", options: { preferredTypes: ["TEXT/PLAIN", "image/png"] } }), "text/plain", Buffer.from(text))
    assertRead(await client.request("read", { scope: "main", options: { preferredTypes: ["application/json", "image/png"] } }), "image/png", png)

    const encoded = [
      ["image/jpeg", "baseline.jpg"], ["image/webp", "lossless.webp"], ["image/gif", "first-frame.gif"],
    ]
    for (const [mimeType, name] of encoded) {
      const bytes = Buffer.from(images[name], "base64")
      await own({ offers: [{ mimeType, bytes }] })
      assertRead(await client.request("read", { scope: "main", options: { preferredTypes: [mimeType] } }), mimeType, bytes)
      assert.deepEqual(await client.request("read", { scope: "main", options: { preferredTypes: ["image/png"] } }), { status: "empty" })
    }
    await own({ offers: [{ mimeType: "image/bmp", bytes: Buffer.from("BM") }, { mimeType: "text/plain", bytes: Buffer.from(text) }] })
    assert.deepEqual(await client.request("read", { scope: "main", options: { preferredTypes: ["image/bmp"] } }), { status: "unsupported" })
    assertRead(await client.request("read", { scope: "main", options: { preferredTypes: ["image/bmp", "text/plain"] } }), "text/plain", Buffer.from(text))
    // Direct clipboard transfer preserves even unrecognized image bytes. Image
    // pixel/conversion limits apply only when a native provider converts them.
    const opaque = Buffer.from([0, 255, 13, 10, 0, 23])
    await own({ offers: [{ mimeType: "image/png", bytes: opaque }] })
    assertRead(await client.request("read", { scope: "main", options: { preferredTypes: ["image/png"] } }), "image/png", opaque)

    const large = Buffer.alloc(1024 * 1024 + 19)
    for (let index = 0; index < large.length; index++) large[index] = index * 37 + 11
    await own({ offers: [{ mimeType: "image/png", bytes: large }], incremental: true })
    assertRead(await client.request("read", { scope: "main", options: { preferredTypes: ["image/png"] } }), "image/png", large)
    await client.request("open", { scope: "small", options: { maxReadBytes: 128 } })
    assert.deepEqual(await client.request("read", { scope: "small", options: { preferredTypes: ["image/png"] } }), { status: "limit-exceeded" })
    await client.request("dispose", { scope: "small" })

    const primary = await own({ selection: "primary", offers: [{ mimeType: "text/plain", bytes: Buffer.from("external primary") }] })
    assertRead(await client.request("read", { scope: "main", options: { selection: "primary", preferredTypes: ["text/plain"] } }), "text/plain", Buffer.from("external primary"))
    await primary.dispose()
    assert.deepEqual(await client.request("clear", { scope: "main", options: { selection: "primary" } }), { status: "cleared" })
    assert.equal(await fixture.read({ selection: "primary" }), null)

    for (const operation of ["read", "write", "clear"]) {
      assert.deepEqual(await client.request(operation, { scope: "main", cancelled: true, text: "cancelled", options: { preferredTypes: ["text/plain"] } }), { status: "cancelled" })
    }
    await client.request("open", { scope: "deadline", options: { timeoutMs: 250 } })
    const stalled = await own({ offers: [{ mimeType: "text/plain", bytes: Buffer.from("never sent") }], stall: true })
    const timeout = client.request("read", { scope: "deadline", options: { preferredTypes: ["text/plain"] } })
    await stalled.requested
    assert.deepEqual(await timeout, { status: "timed-out" })
    await client.request("dispose", { scope: "deadline" })

    const cancelled = await own({ offers: [{ mimeType: "text/plain", bytes: Buffer.from("never sent") }], stall: true })
    const pending = client.request("read", { scope: "main", token: "cancel-read", options: { preferredTypes: ["text/plain"] } })
    await cancelled.requested
    await client.request("abort", { token: "cancel-read" })
    assert.deepEqual(await pending, { status: "cancelled" })

    await client.request("open", { scope: "limited", options: { timeoutMs: 10_000, maxConcurrentOperations: 1 } })
    const blocking = await own({ offers: [{ mimeType: "text/plain", bytes: Buffer.from("never sent") }], stall: true })
    const inFlight = client.request("read", { scope: "limited", options: { preferredTypes: ["text/plain"] } })
    await blocking.requested
    const admission = await client.request("read", { scope: "limited", options: { preferredTypes: ["text/plain"] } })
    assert.equal(admission.status, "failed")
    assert.equal(admission.error.code, "CLIPBOARD_OPERATION_LIMIT")
    await client.request("dispose", { scope: "limited" })
    assert.deepEqual(await inFlight, { status: "cancelled" })
    await assert.rejects(client.request("read", { scope: "limited", options: { preferredTypes: ["text/plain"] } }), /disposed/)
    await client.request("dispose", { scope: "main" })
    await client.finish()
    assert.deepEqual((await readdir(client.directory)).sort(), ["clipboard.mjs"])
  } finally {
    await client.dispose()
    await Promise.all(owners.map((owner) => owner.dispose()))
    await fixture.dispose()
  }
})

test("copied application clipboard adapter pastes Xlib PNG and text and copies through host plus native OSC 52", { timeout: 30_000 }, async () => {
  const fixture = await startX11Fixture(join(temporary, "adapter-display"))
  const client = await copiedClient(join(temporary, "adapter-child"), fixture.env)
  const owners = []
  try {
    await client.request("open", { scope: "tui" })
    await client.request("tui-open", { scope: "tui" })
    const png = Buffer.from(images["display-p3-rgba.png"], "base64")
    owners.push(await fixture.owner({ offers: [{ mimeType: "image/png", bytes: png }, { mimeType: "text/plain", bytes: Buffer.from("text fallback") }] }))
    assert.deepEqual(await client.request("tui-read", { scope: "tui" }), { mime: "image/png", data: png.toString("base64") })
    const pasted = "실제 TUI 붙여넣기 👩🏽‍💻\nsecond line"
    owners.push(await fixture.owner({ offers: [{ mimeType: "text/plain", bytes: Buffer.from(pasted) }] }))
    assert.deepEqual(await client.request("tui-read", { scope: "tui" }), { mime: "text/plain", data: pasted })
    await client.request("tui-write", { scope: "tui", text: "복사\0 clipboard 👩🏽‍💻" })
    assert.deepEqual(await fixture.read({}), new Uint8Array(Buffer.from("복사 clipboard 👩🏽‍💻")))
    const output = Buffer.from(await client.request("terminal-output"), "base64").toString()
    assert.ok(output.includes(`\x1b]52;c;${Buffer.from("복사 clipboard 👩🏽‍💻").toString("base64")}\x1b\\`))
    await client.request("dispose", { scope: "tui" })
    await assert.rejects(client.request("tui-read", { scope: "tui" }), /disposed/)
    assert.equal(await fixture.read({}), null)
    await client.finish()
    assert.deepEqual((await readdir(client.directory)).sort(), ["clipboard.mjs"])
  } finally {
    await client.dispose()
    await Promise.all(owners.map((owner) => owner.dispose()))
    await fixture.dispose()
  }
})

function assertRead(result, mimeType, bytes) {
  assert.deepEqual(result, { status: "read", representation: { mimeType, base64: Buffer.from(bytes).toString("base64") } })
}

async function copiedClient(directory, connection) {
  await mkdir(directory, { recursive: true })
  const copied = join(directory, "clipboard.mjs")
  await copyFile(artifact, copied)
  const env = { ...connection, PATH: "", HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory, NODE_NO_WARNINGS: "1" }
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "WAYLAND_DISPLAY", "LD_LIBRARY_PATH", "OTUI_ASSET_ROOT", "OTUI_TREE_SITTER_WORKER_PATH"]) delete env[name]
  const child = spawn(process.execPath, ["--no-addons", "--disable-warning=ExperimentalWarning", copied], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] })
  const pending = new Map()
  const failures = []
  let next = 0
  let finished = false
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => failures.push(chunk))
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    const response = JSON.parse(line)
    const request = pending.get(response.id)
    assert.ok(request, "clipboard proof must answer each operation exactly once")
    pending.delete(response.id)
    if (response.error) request.reject(Object.assign(new Error(response.error.message), response.error))
    else request.resolve(response.result)
  })
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      const failure = new Error(`Copied clipboard child exited: ${code ?? signal}\n${failures.join("")}`)
      for (const request of pending.values()) request.reject(failure)
      pending.clear()
      resolve({ code, signal })
    })
  })
  const request = (operation, options = {}) => new Promise((resolve, reject) => {
    const id = ++next
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, operation, ...options }) + "\n")
  })
  return {
    directory, request,
    async finish() {
      assert.deepEqual(await request("shutdown"), { closed: true })
      child.stdin.end()
      const result = await closed
      finished = true
      assert.equal(failures.join(""), "")
      assert.deepEqual(result, { code: 0, signal: null })
      lines.close()
    },
    async dispose() {
      if (!finished) {
        child.kill("SIGKILL")
        await closed
      }
      lines.close()
    },
  }
}
