import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { deadline, diagnostic, sandbox } from "./harness.mjs"

test("copied artifact preserves a real terminal and Ghostty state across server handoff", { timeout: 120_000 }, async (t) => {
  const isolated = await sandbox(t)
  let server = await isolated.serve()
  let handoff
  const sockets = []
  const base = "/api/experimental/persistent-pty"
  const session = "/api/experimental/session/ses_standalone_persistent/terminal"
  try {
    const created = await server.request(session, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "/bin/sh", args: ["-c", [
          "test -t 0 && test -t 1 && test -t 2 && test -z \"$PATH\" || exit 91",
          "printf '\\033[31mPERSISTENT_READY:%s\\033[0m\\n' \"$$\"",
          "while IFS= read -r value; do case $value in done) printf 'FINISHED\\n'; exit 23;; *) printf 'SEEN:%s\\n' \"$value\";; esac; done",
        ].join("; ")],
        cwd: isolated.paths.project, title: "Standalone persistent terminal", env: { PATH: "" },
        size: { cols: 50, rows: 5 },
      }),
    })
    assert.equal(created.status, 200, `${await created.clone().text()}\n${diagnostic(server.output)}`)
    const terminal = (await created.json()).data
    const first = await connect(server, terminal.id, "first-controller")
    sockets.push(first.socket)
    await first.until(() => first.text.includes(`PERSISTENT_READY:${terminal.pid}`), "initial terminal output")
    first.socket.send("before-restart 한글\n")
    await first.until(() => first.text.includes("SEEN:before-restart 한글"), "input before restart")
    const initial = (await server.json(`${base}/${terminal.id}/snapshot`)).data
    assert.match(initial.text, /PERSISTENT_READY/)
    assert.match(initial.text, /SEEN:before-restart 한글/)
    assert.ok(initial.checkpoint.length > 0)
    assert.match((await server.json(`${session}/read`)).data.screen.text, /SEEN:before-restart 한글/)
    const transferred = await server.request(`${base}/handoff`, { method: "POST" })
    assert.equal(transferred.status, 200, await transferred.clone().text())
    handoff = (await transferred.json()).handoff
    assert.ok(handoff?.ticket)
    await server.stop()
    server = await isolated.serve({ env: { OPENCODE_PTY_HANDOFF: JSON.stringify(handoff) } })
    const resumed = (await server.json(`${base}/${terminal.id}`)).data
    assert.equal(resumed.pid, terminal.pid)
    assert.equal(resumed.status, "running")
    const second = await connect(server, terminal.id, "second-controller")
    sockets.push(second.socket)
    await second.until(() => second.text.includes("SEEN:before-restart 한글"), "replayed output after restart")
    second.socket.send("after-restart\n")
    await second.until(() => second.text.includes("SEEN:after-restart"), "input after restart")
    const resized = await server.request(`${base}/${terminal.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachmentID: "second-controller", size: { cols: 61, rows: 7 } }),
    })
    assert.equal(resized.status, 200, await resized.clone().text())
    assert.deepEqual((await resized.json()).data.size, { cols: 61, rows: 7 })
    second.socket.send("done\n")
    await second.until(() => second.events.some((event) => event.type === "exited"), "terminal exit")
    assert.equal(second.events.find((event) => event.type === "exited").exitCode, 23)
    assert.match(second.text, /FINISHED/)
    // Upstream removes a visible terminal as soon as its exit event arrives.
    // Wait for that asynchronous removal instead of racing it with DELETE.
    await deadline((async () => {
      while ((await server.json(session)).data.length) await setTimeout(25)
    })(), 10_000, () => `Exited terminal was not removed\n${diagnostic(server.output)}`)
    assert.deepEqual((await server.json(session)).data, [])
  } finally {
    sockets.forEach((socket) => socket.close())
    await server.request(`${base}/shutdown`, { method: "POST" }).catch(() => undefined)
    // If replacement startup fails after a handoff, no owner remains to send
    // shutdown. Reap only the daemon belonging to this test's private directory.
    if (handoff) {
      const registration = await readFile(path.join(handoff.directory, "service.json"), "utf8").then(JSON.parse).catch(() => undefined)
      if (registration) {
        try { process.kill(registration.pid, "SIGTERM") } catch (cause) { if (cause.code !== "ESRCH") throw cause }
      }
    }
  }
})

async function connect(server, id, attachmentID) {
  const token = await server.request(`/api/experimental/persistent-pty/${id}/connect-token`, {
    method: "POST", headers: { "x-opencode-ticket": "1", origin: server.url },
  })
  assert.equal(token.status, 200, await token.clone().text())
  const url = new URL(`/api/experimental/persistent-pty/${id}/connect`, server.url)
  url.protocol = "ws:"
  url.searchParams.set("ticket", (await token.json()).data.ticket)
  url.searchParams.set("attachment_id", attachmentID)
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  const updates = new EventEmitter()
  const decoder = new TextDecoder()
  const state = { text: "", events: [], failure: undefined, closed: false }
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") state.events.push(JSON.parse(event.data))
    else state.text += decoder.decode(event.data, { stream: true })
    updates.emit("changed")
  })
  socket.addEventListener("error", () => { state.failure = new Error("Persistent PTY WebSocket failed"); updates.emit("changed") })
  socket.addEventListener("close", () => { state.closed = true; updates.emit("changed") })
  const result = {
    socket,
    events: state.events,
    get text() { return state.text },
    async until(condition, description) {
      let changed
      try {
        await deadline(new Promise((resolve, reject) => {
          changed = () => {
            if (condition()) return resolve()
            if (state.failure || state.closed) reject(state.failure ?? new Error(`Socket closed before ${description}`))
          }
          updates.on("changed", changed)
          changed()
        }), 10_000, () => `Missing ${description}\n${state.text}\n${diagnostic(server.output)}`)
      } finally { updates.off("changed", changed) }
    },
  }
  await result.until(() => state.events.some((event) => event.type === "replay_complete"), "persistent PTY attachment")
  return result
}
