import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { readFile, readdir } from "node:fs/promises"
import { test } from "node:test"
import { deadline, diagnostic, sandbox } from "./harness.mjs"

test("copied single file serves the upstream browser HTML, JS, CSS, service worker, WASM, and font", { timeout: 90_000 }, async (t) => {
  const manifest = JSON.parse(await readFile(new URL("../.cache/web/manifest.json", import.meta.url), "utf8"))
  const files = new Map(manifest.files.map((entry) => [entry.path, entry]))
  const isolated = await sandbox(t)
  const server = await isolated.serve()

  async function asset(route, mime, name = route.replace(/^\//, "")) {
    const expected = files.get(name)
    assert.ok(expected, `${name} is absent from the browser build manifest`)
    const response = await server.request(route)
    assert.equal(response.status, 200, `${route}: ${response.status}\n${diagnostic(server.output)}`)
    assert.match(response.headers.get("content-type") ?? "", mime, route)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.length, expected.bytes, `${route}: served byte count differs from the browser build`)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, `${route}: served bytes differ from the browser build`)
    return bytes
  }

  const html = (await asset("/", /text\/html/i, "index.html")).toString("utf8")
  assert.match(html, /<title>OpenCode<\/title>/)
  const modules = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((match) => match[1])
  assert.ok(modules.length > 0, "The upstream HTML must reference its compiled module entry")
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)].map((match) => match[1])
  await Promise.all([
    ...modules.map((route) => asset(route, /(?:text|application)\/(?:java|ecma)script/i)),
    ...styles.map((route) => asset(route, /text\/css/i)),
  ])

  const worker = await asset("/sw.js", /(?:text|application)\/(?:java|ecma)script/i)
  assert.match(worker.toString("utf8"), /addEventListener\("(?:fetch|install|activate)"/)
  const wasm = manifest.files.filter((entry) => entry.path.endsWith(".wasm")).toSorted((a, b) => a.bytes - b.bytes)[0]
  assert.ok(wasm, "The real browser build must include Office WASM")
  assert.equal((await asset(`/${wasm.path}`, /application\/wasm/i)).subarray(0, 4).toString("hex"), "0061736d")
  const font = manifest.files.find((entry) => entry.path.endsWith(".woff2"))
  assert.ok(font, "The real browser build must include a WOFF2 font")
  assert.equal((await asset(`/${font.path}`, /(?:font\/woff2|application\/font-woff)/i)).subarray(0, 4).toString("ascii"), "wOF2")
  assert.deepEqual(await readdir(isolated.paths.bin), ["opencode-standalone.js"])
})

test("copied single file runs a real PTY through HTTP and WebSocket with an empty PATH", { timeout: 90_000 }, async (t) => {
  const isolated = await sandbox(t)
  const server = await isolated.serve()
  const script = [
    "test -t 0 && test -t 1 && test -t 2 || exit 91",
    "test -z \"$PATH\" || exit 92",
    "trap 'printf \"RESIZED\\n\"' WINCH",
    "printf 'TTY_READY:%s\\n' \"$$\"",
    // A resize interrupts read on some shells; keep waiting for the test's input.
    "while ! IFS= read -r value; do :; done",
    "printf 'INPUT:%s\\n' \"$value\"",
    "exit 17",
  ].join("; ")
  const created = await server.request("/api/pty", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "/bin/sh", args: ["-c", script], title: "Standalone PTY fixture" }),
  })
  assert.equal(created.status, 200, `${await created.clone().text()}\n${diagnostic(server.output)}`)
  const pty = (await created.json()).data
  assert.equal(pty.command, "/bin/sh")
  assert.equal(pty.status, "running")
  assert.ok(pty.pid > 0)

  const token = await server.request(`/api/pty/${pty.id}/connect-token`, {
    method: "POST",
    headers: { "x-opencode-ticket": "1", origin: server.url },
  })
  assert.equal(token.status, 200, `Could not create PTY connection ticket\n${diagnostic(server.output)}`)
  const url = new URL(`/api/pty/${pty.id}/connect`, server.url)
  url.protocol = "ws:"
  url.searchParams.set("location[directory]", isolated.paths.project)
  url.searchParams.set("ticket", (await token.json()).data.ticket)
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  t.after(() => socket.close())
  const transcript = observe(socket, server)
  await transcript.until(() => transcript.cursors.length > 0 && transcript.text.includes(`TTY_READY:${pty.pid}\r\n`), "terminal readiness and replay cursor")
  assert.ok(transcript.cursors.every((cursor) => Number.isSafeInteger(cursor) && cursor >= 0))

  const updated = await server.request(`/api/pty/${pty.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Resized standalone PTY fixture", size: { cols: 101, rows: 37 } }),
  })
  assert.equal(updated.status, 200, `${await updated.clone().text()}\n${diagnostic(server.output)}`)
  assert.equal((await updated.json()).data.title, "Resized standalone PTY fixture")
  // SIGWINCH proves that the update reached the actual terminal's foreground process.
  await transcript.until(() => transcript.text.includes("RESIZED\r\n"), "the shell's SIGWINCH trap")
  socket.send("standalone hello 한글\n")
  const closed = await deadline(transcript.closed, 10_000, () => `PTY did not exit\n${transcript.text}\n${diagnostic(server.output)}`)
  assert.equal(closed.code, 1000, transcript.text)
  assert.match(transcript.text, /INPUT:standalone hello 한글\r\n/)
  const exited = (await server.json(`/api/pty/${pty.id}`)).data
  assert.equal(exited.status, "exited")
  assert.equal(exited.exitCode, 17, transcript.text)
  assert.ok((await server.json("/api/pty")).data.some((entry) => entry.id === pty.id && entry.exitCode === 17))
  assert.equal((await server.request(`/api/pty/${pty.id}`, { method: "DELETE" })).status, 204)
  assert.ok((await server.json("/api/pty")).data.every((entry) => entry.id !== pty.id))
  assert.deepEqual(await readdir(isolated.paths.bin), ["opencode-standalone.js"])
})

function observe(socket, server) {
  const events = new EventEmitter()
  const state = { text: "", cursors: [], failure: undefined, ended: false }
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)
    if (text.startsWith("\0")) state.cursors.push(JSON.parse(text.slice(1)).cursor)
    else state.text += text
    events.emit("output")
  })
  socket.addEventListener("error", () => {
    state.failure = new Error("PTY WebSocket failed")
    events.emit("output")
  })
  const closed = new Promise((resolve) => socket.addEventListener("close", (event) => {
    state.ended = true
    resolve(event)
    events.emit("output")
  }, { once: true }))
  return {
    get text() { return state.text },
    cursors: state.cursors,
    closed,
    async until(condition, description) {
      let listener
      try {
        await deadline(new Promise((resolve, reject) => {
          listener = () => {
            if (condition()) return resolve()
            if (state.failure) return reject(state.failure)
            if (state.ended) reject(new Error(`PTY ended before ${description}\n${state.text}`))
          }
          events.on("output", listener)
          listener()
        }), 10_000, () => `PTY did not emit ${description}\n${state.text}\n${diagnostic(server.output)}`)
      } finally {
        events.off("output", listener)
      }
    },
  }
}
