import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { unwatchFile, watchFile } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises"
import { createConnection } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { helperFlag, runPtyHelper } from "../pty/index.ts"
import { daemonFlag, runPersistentPtyDaemon } from "./index.ts"

type Registration = { instance_id: string; pid: number; protocol: number; socket: string; token: string }
type Json = Record<string, unknown>

if (process.argv[2] === helperFlag) {
  await runPtyHelper()
} else if (process.argv[2] === daemonFlag) {
  await runPersistentPtyDaemon(process.argv.slice(3))
} else {
  test("protocol 7 carries real PTY state, replay bytes, controller changes, resize and exit", { timeout: 15_000 }, async (t) => {
    const daemon = await fixture(t)
    const owner = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id })
    assert.equal((await owner.json()).type, "owned")
    const created = await daemon.request({ op: "create", program: "/bin/sh", args: ["-c", [
      "test -t 0 && test -t 1 && test -t 2 || exit 91",
      "stty -echo",
      "printf '\\033]0;real title\\007\\033[2J\\033[H\\033[31mold\\033[0m\\rnew\\033[K\\r\\nREADY\\r\\n'",
      "read value",
      "printf 'INPUT:%s\\n' \"$value\"",
      "printf 'SIZE:'; stty size",
      "exit 17",
    ].join("; ")], cwd: daemon.directory, title: "Initial", group_id: "session-1", env: {}, cols: 20, rows: 6 })
    assert.equal(created.type, "created")
    const id = (created.terminal as Json).id
    const controller = await daemon.connect({ op: "subscribe", id, offset: 0, attachment_id: "first", role: "controller", takeover: false })
    const attached = await controller.json()
    assert.equal(attached.type, "attached")
    assert.equal(attached.role, "controller")
    assert.equal(attached.generation, 1)
    const capture = output(controller, attached)
    await capture.until("READY")
    const snapshot = await daemon.request({ op: "snapshot", id })
    assert.equal(snapshot.type, "snapshot")
    assert.equal((snapshot.terminal as Json).title, "real title")
    assert.match(String(snapshot.text), /^new\nREADY/)
    assert.doesNotMatch(String(snapshot.text), /old|\x1b/)
    assert.ok(Buffer.from(String(snapshot.checkpoint_base64), "base64").includes(Buffer.from("\x1b[")))
    const rows = await daemon.request({ op: "read_rows", id, rows: 2 })
    assert.equal(rows.type, "rows")
    assert.equal((rows.lines as string[]).length, 2)
    assert.deepEqual(rows.lines, ["", ""])
    const observer = await daemon.connect({ op: "subscribe", id, offset: attached.end_offset, attachment_id: "second", role: "observer", takeover: false })
    const observed = await observer.json()
    assert.equal(observed.role, "observer")
    const observedOutput = output(observer, observed)
    assert.match(String((await daemon.request({ op: "write", id, attachment_id: "second", data_base64: "eA==" })).message), /not the terminal controller/)
    assert.match(String((await daemon.request({ op: "subscribe", id, offset: 0, attachment_id: "third", role: "controller", takeover: false })).message), /already has controller/)
    assert.equal((await daemon.request({ op: "control", id, attachment_id: "second", cols: 101, rows: 37 })).type, "ok")
    const resized = await observedOutput.event("resized")
    assert.equal(resized.cols, 101)
    assert.equal(resized.rows, 37)
    assert.equal(resized.generation, 2)
    assert.ok(Buffer.from(String(resized.checkpoint_base64), "base64").length > 0)
    assert.match(String((await daemon.request({ op: "write", id, attachment_id: "first", data_base64: "eA==" })).message), /not the terminal controller/)
    observer.socket.destroy()
    assert.equal((await capture.event("controller_changed", 3)).attachment_id, "first")
    assert.equal((await daemon.request({ op: "input", id, attachment_id: "first", cols: 101, rows: 37, data_base64: Buffer.from("한글\n").toString("base64") })).type, "ok")
    const exited = await capture.event("exited")
    assert.equal(exited.exit_code, 17)
    assert.match(capture.text(), /INPUT:한글\r\nSIZE:37 101\r\n/)
    assert.equal(exited.final_offset, capture.offset())
    const terminal = ((await daemon.request({ op: "list" })).terminals as Json[])[0]
    assert.deepEqual(terminal.lifecycle, { status: "exited", exit_code: 17 })
    assert.equal(terminal.output_tail, exited.final_offset)
    const replay = await daemon.request({ op: "replay", id, offset: 0 })
    const replayed = Buffer.from(String(replay.data_base64), "base64")
    assert.equal(replayed.length, replay.end_offset)
    assert.match(replayed.toString(), /INPUT:한글/)
    const partialOffset = replayed.indexOf(Buffer.from("한글")) + 1
    assert.deepEqual(Buffer.from(String((await daemon.request({ op: "replay", id, offset: partialOffset })).data_base64), "base64"), replayed.subarray(partialOffset))
    const late = await daemon.connect({ op: "subscribe", id, offset: exited.final_offset, attachment_id: "late", role: "controller", takeover: false })
    assert.equal((await late.json()).replay_base64, "")
    assert.equal((await late.json()).type, "controller_changed")
    assert.equal((await late.json()).type, "exited")
    assert.equal((await daemon.request({ op: "terminate", id })).type, "ok")
    assert.deepEqual((await daemon.request({ op: "list" })).terminals, [])
    assert.equal((await daemon.request({ op: "shutdown" })).type, "ok")
    assert.deepEqual(await daemon.exit, { code: 0, signal: null })
  })

  test("ownership handoff is exclusive, one use, fenced and preserves the terminal PID", { timeout: 15_000 }, async (t) => {
    const daemon = await fixture(t)
    assert.equal((await daemon.request({ op: "ping" }, "wrong-token")).message, "authentication failed")
    assert.equal((await daemon.request({ op: "own", instance_id: "wrong-instance" })).message, "daemon instance_id mismatch")
    const first = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id })
    assert.equal((await first.json()).type, "owned")
    assert.match(String((await daemon.request({ op: "own", instance_id: daemon.registration.instance_id })).message), /live owner/)
    assert.match(String((await daemon.request({ op: "prepare_handoff" })).message), /owner connection/)
    const created = await daemon.request({ op: "create", program: "/bin/sh", args: ["-c", "printf 'READY\\n'; read value"], cwd: daemon.directory, title: "handoff", group_id: "same-session", env: {}, cols: 80, rows: 24 })
    const terminal = created.terminal as Json
    const attachment = await daemon.connect({ op: "subscribe", id: terminal.id, offset: 0, attachment_id: "pane", role: "controller", takeover: false })
    const capture = output(attachment, await attachment.json())
    await capture.until("READY")
    first.send({ op: "prepare_handoff" })
    const handoff = await first.json()
    assert.equal(handoff.type, "handoff")
    assert.ok(Number(handoff.expires_at) > Date.now())
    first.send({ op: "prepare_handoff" })
    assert.deepEqual(await first.json(), handoff)
    assert.match(String((await daemon.request({ op: "own", instance_id: daemon.registration.instance_id, ticket: "wrong" })).message), /live owner/)
    const second = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id, ticket: handoff.ticket })
    assert.equal((await second.json()).type, "owned")
    first.send({ op: "shutdown" })
    assert.match(String((await first.json()).message), /superseded/)
    assert.match(String((await daemon.request({ op: "own", instance_id: daemon.registration.instance_id, ticket: handoff.ticket })).message), /live owner/)
    assert.equal(((await daemon.request({ op: "list" })).terminals as Json[])[0].pid, terminal.pid)
    second.send({ op: "prepare_handoff" })
    const waiting = await second.json()
    second.socket.destroy()
    const third = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id, ticket: waiting.ticket })
    assert.equal((await third.json()).type, "owned")
    assert.equal(((await daemon.request({ op: "list" })).terminals as Json[])[0].pid, terminal.pid)
    third.socket.destroy()
    assert.deepEqual(await daemon.exit, { code: 0, signal: null })
    assert.throws(() => process.kill(Number(terminal.pid), 0), { code: "ESRCH" })
    await assert.rejects(stat(path.join(daemon.directory, "service.json")), { code: "ENOENT" })
    await assert.rejects(stat(path.join(daemon.directory, "service.lock")), { code: "ENOENT" })
    await assert.rejects(stat(daemon.registration.socket), { code: "ENOENT" })
  })

  test("framing handles fragmented requests and rejects malformed bounds without stopping the daemon", { timeout: 10_000 }, async (t) => {
    const daemon = await fixture(t)
    const owner = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id })
    assert.equal((await owner.json()).type, "owned")
    const fragmented = await daemon.connect()
    const payload = frame({ token: daemon.registration.token, request: { op: "ping" } })
    for (const byte of payload) fragmented.socket.write(Buffer.from([byte]))
    assert.equal((await fragmented.json()).protocol, 7)
    for (const request of [
      { op: "create", program: "/bin/sh", cols: 0, rows: 24 },
      { op: "create", program: "/bin/sh", cols: 80, rows: 65536 },
      { op: "write", id: 1, data_base64: "!invalid!" },
      { op: "replay", id: 1, offset: -1 },
      { op: "read_rows", id: 1, rows: 0 },
    ]) assert.equal((await daemon.request(request)).type, "error")
    assert.match(String((await daemon.request({ op: "write", id: 1, data_base64: Buffer.alloc(1024 * 1024).toString("base64") })).message), /not found/)
    const excessive = await daemon.connect()
    const closed = new Promise<void>((resolve) => excessive.socket.once("close", () => resolve()))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(8 * 1024 * 1024 + 1)
    excessive.socket.write(header)
    await closed
    assert.equal((await daemon.request({ op: "ping" })).type, "pong")
    assert.equal((await daemon.request({ op: "shutdown" })).type, "ok")
    assert.deepEqual(await daemon.exit, { code: 0, signal: null })
  })

  test("bounded replay reports truncation, preserves exact offsets and rejects a future cursor", { timeout: 15_000 }, async (t) => {
    const daemon = await fixture(t)
    const owner = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id })
    assert.equal((await owner.json()).type, "owned")
    const created = await daemon.request({ op: "create", program: "/bin/sh", args: ["-c", "stty -echo; /usr/bin/head -c 2097189 /dev/zero; printf REPLAY_READY; read value"], cwd: daemon.directory, title: "replay", group_id: "session", env: {}, cols: 20, rows: 4 })
    const id = (created.terminal as Json).id
    const controller = await daemon.connect({ op: "subscribe", id, offset: 0, attachment_id: "pane", role: "controller", takeover: false })
    const capture = output(controller, await controller.json())
    await capture.until("REPLAY_READY")
    const replay = await daemon.request({ op: "replay", id, offset: 0 })
    assert.equal(replay.truncated, true)
    assert.equal(replay.available_offset, Number(replay.end_offset) - 2 * 1024 * 1024)
    const bytes = Buffer.from(String(replay.data_base64), "base64")
    assert.equal(bytes.length, 2 * 1024 * 1024)
    assert.ok(bytes.subarray(-12).equals(Buffer.from("REPLAY_READY")))
    const attachment = await daemon.connect({ op: "subscribe", id, offset: 0, attachment_id: "observer", role: "observer", takeover: false })
    const attached = await attachment.json()
    assert.equal(attached.available_offset, replay.available_offset)
    assert.equal(attached.end_offset, replay.end_offset)
    assert.equal(attached.truncated, true)
    assert.deepEqual(Buffer.from(String(attached.replay_base64), "base64"), bytes)
    assert.match(String((await daemon.request({ op: "replay", id, offset: Number(replay.end_offset) + 1 })).message), /beyond tail/)
    assert.equal((await daemon.request({ op: "shutdown" })).type, "ok")
    assert.deepEqual(await daemon.exit, { code: 0, signal: null })
  })

  for (const cleanup of ["terminate", "shutdown"] as const) {
    test(`${cleanup} kills and reaps background jobs after their shell has exited`, { timeout: 10_000 }, async (t) => {
      const daemon = await fixture(t)
      const owner = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id })
      assert.equal((await owner.json()).type, "owned")
      const created = await daemon.request({ op: "create", program: "/bin/sh", args: ["-c", "trap '' HUP; /bin/sleep 30 & printf 'BG:%s\\n' \"$!\"; exit 0"], cwd: daemon.directory, title: "background", group_id: "session", env: {}, cols: 80, rows: 24 })
      const terminal = created.terminal as Json
      const attachment = await daemon.connect({ op: "subscribe", id: terminal.id, offset: 0, attachment_id: "pane", role: "observer", takeover: false })
      const capture = output(attachment, await attachment.json())
      assert.equal((await capture.event("exited")).exit_code, 0)
      const match = /BG:(\d+)/.exec(capture.text())
      assert.ok(match, capture.text())
      const background = Number(match[1])
      t.after(() => {
        try { process.kill(background, "SIGKILL") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
      })
      assert.throws(() => process.kill(Number(terminal.pid), 0), { code: "ESRCH" })
      const stat = await readFile(`/proc/${background}/stat`, "utf8")
      assert.equal(Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]), daemon.registration.pid, "the daemon adopts the shell's orphaned job")
      assert.equal((await daemon.request({ op: cleanup, id: terminal.id })).type, "ok")
      if (cleanup === "shutdown") assert.deepEqual(await daemon.exit, { code: 0, signal: null })
      assert.throws(() => process.kill(background, 0), { code: "ESRCH" })
      await assert.rejects(readFile(`/proc/${background}/stat`), { code: "ENOENT" })
      if (cleanup === "terminate") {
        assert.equal((await daemon.request({ op: "shutdown" })).type, "ok")
        assert.deepEqual(await daemon.exit, { code: 0, signal: null })
      }
    })
  }

  test("concurrent terminal removal and daemon shutdown finish process cleanup before closing FFI", { timeout: 10_000 }, async (t) => {
    const daemon = await fixture(t)
    const owner = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id })
    assert.equal((await owner.json()).type, "owned")
    const terminal = (await daemon.request({ op: "create", program: "/bin/sh", args: ["-c", "printf 'READY\\n'; read value"], cwd: daemon.directory, title: "concurrent", group_id: "session", env: {}, cols: 80, rows: 24 })).terminal as Json
    const attachment = await daemon.connect({ op: "subscribe", id: terminal.id, offset: 0, attachment_id: "pane", role: "observer", takeover: false })
    await output(attachment, await attachment.json()).until("READY")
    const remove = await daemon.connect()
    const shutdown = await daemon.connect()
    remove.send({ op: "terminate", id: terminal.id })
    shutdown.send({ op: "shutdown" })
    // Shutdown may close the outstanding removal socket; the daemon must still
    // await that terminal's cleanup before unloading its native functions.
    await Promise.allSettled([remove.json(), shutdown.json()])
    assert.deepEqual(await daemon.exit, { code: 0, signal: null })
    assert.throws(() => process.kill(Number(terminal.pid), 0), { code: "ESRCH" })
    await assert.rejects(readFile(path.join(daemon.directory, "service.json")), { code: "ENOENT" })
  })

  test("removing an older exited terminal preserves a newer live terminal and its input", { timeout: 10_000 }, async (t) => {
    const daemon = await fixture(t)
    const owner = await daemon.connect({ op: "own", instance_id: daemon.registration.instance_id })
    assert.equal((await owner.json()).type, "owned")
    const older = (await daemon.request({ op: "create", program: "/bin/sh", args: ["-c", "printf OLD; exit 0"], cwd: daemon.directory, title: "old", group_id: "old", env: {}, cols: 80, rows: 24 })).terminal as Json
    const oldAttachment = await daemon.connect({ op: "subscribe", id: older.id, offset: 0, attachment_id: "old", role: "observer", takeover: false })
    assert.equal((await output(oldAttachment, await oldAttachment.json()).event("exited")).exit_code, 0)
    const newer = (await daemon.request({ op: "create", program: "/bin/sh", args: ["-c", "stty -echo; printf 'NEW_READY\\n'; read value; printf 'NEW:%s\\n' \"$value\"; exit 19"], cwd: daemon.directory, title: "new", group_id: "new", env: {}, cols: 80, rows: 24 })).terminal as Json
    const attachment = await daemon.connect({ op: "subscribe", id: newer.id, offset: 0, attachment_id: "new", role: "controller", takeover: false })
    const capture = output(attachment, await attachment.json())
    await capture.until("NEW_READY")
    assert.equal((await daemon.request({ op: "terminate", id: older.id })).type, "ok")
    process.kill(Number(newer.pid), 0)
    assert.equal((await daemon.request({ op: "write", id: newer.id, attachment_id: "new", data_base64: Buffer.from("still alive\n").toString("base64") })).type, "ok")
    assert.equal((await capture.event("exited")).exit_code, 19)
    assert.match(capture.text(), /NEW:still alive/)
    assert.equal((await daemon.request({ op: "shutdown" })).type, "ok")
    assert.deepEqual(await daemon.exit, { code: 0, signal: null })
  })
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "standalone-persistent-pty-"))
  const directory = path.join(root, "daemon")
  await mkdir(directory)
  const sockets = new Set<Socket>()
  let stderr = ""
  let registration: Registration | undefined
  const child = spawn(process.execPath, ["--experimental-ffi", "--no-addons", fileURLToPath(import.meta.url), daemonFlag, "daemon", "--runtime-dir", root, "--name", "daemon"], { stdio: ["ignore", "ignore", "pipe"] })
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16_384) })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    const escalation = setTimeout(() => child.kill("SIGKILL"), 1_000).unref()
    await exit
    clearTimeout(escalation)
    if (registration) await unlink(registration.socket).catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const registered = await new Promise<Registration>((resolve, reject) => {
    const file = path.join(directory, "service.json")
    // Stat watching also works on hosts whose shared inotify quota is full.
    watchFile(file, { interval: 20 }, (current) => {
      if (!current.nlink) return
      unwatchFile(file)
      child.off("exit", failed)
      void readFile(file, "utf8").then((value) => resolve(JSON.parse(value)), reject)
    })
    const failed = () => { unwatchFile(file); reject(new Error(`daemon exited before registration: ${stderr}`)) }
    child.once("exit", failed)
    child.once("error", reject)
  })
  registration = registered
  assert.equal(registered.protocol, 7)
  assert.equal((await stat(path.join(directory, "service.json"))).mode & 0o777, 0o600)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(registered.socket)).mode & 0o777, 0o600)
  const connect = async (request?: Json, token = registered.token) => {
    const socket = createConnection(registered.socket)
    socket.on("error", () => {})
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    const frames = decoder(socket)
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject) })
    const connection = {
      socket,
      send(value: Json) { socket.write(frame({ token, request: value })) },
      async next() {
        const value = await frames.next()
        if (value.done) throw new Error(`daemon connection closed: ${stderr}`)
        return value.value
      },
      async json(): Promise<Json> { return JSON.parse((await connection.next()).toString("utf8")) },
    }
    if (request) connection.send(request)
    return connection
  }
  return {
    registration: registered, directory, exit, connect,
    async request(request: Json, token = registered.token) {
      const connection = await connect(request, token)
      try { return await connection.json() } finally { connection.socket.destroy() }
    },
  }
}

function frame(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  const framed = Buffer.alloc(bytes.length + 4)
  framed.writeUInt32BE(bytes.length)
  bytes.copy(framed, 4)
  return framed
}

async function* decoder(socket: Socket) {
  let pending: Buffer = Buffer.alloc(0)
  for await (const chunk of socket) {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 4 && pending.length >= pending.readUInt32BE() + 4) {
      const length = pending.readUInt32BE()
      yield pending.subarray(4, length + 4)
      pending = pending.subarray(length + 4)
    }
  }
  assert.equal(pending.length, 0, "daemon returned a truncated frame")
}

function output(connection: { next(): Promise<Buffer> }, attached: Json) {
  let offset = Number(attached.end_offset)
  const chunks: Buffer[] = [Buffer.from(String(attached.replay_base64), "base64")]
  const events: Json[] = []
  const next = async () => {
    const frame = await connection.next()
    if (frame[0] !== 0) { const event = JSON.parse(frame.toString()) as Json; events.push(event); return event }
    assert.ok(frame.length >= 17)
    assert.equal(Number(frame.readBigUInt64BE(1)), offset)
    offset = Number(frame.readBigUInt64BE(9))
    assert.equal(offset - Number(frame.readBigUInt64BE(1)), frame.length - 17)
    chunks.push(frame.subarray(17))
    return undefined
  }
  return {
    text: () => Buffer.concat(chunks).toString(),
    offset: () => offset,
    async until(text: string) { while (!Buffer.concat(chunks).includes(Buffer.from(text))) await next() },
    async event(type: string, generation?: number) {
      for (;;) {
        const known = events.find((item) => item.type === type && (generation === undefined || generation === item.generation))
        if (known) return known
        await next()
      }
    },
  }
}
