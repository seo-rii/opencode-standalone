import { randomBytes, randomUUID } from "node:crypto"
import { readFileSync, readlinkSync, statSync } from "node:fs"
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "../pty/index.ts"
import { createTerminal } from "./terminal.ts"
import { createProcessOwners } from "./processes.ts"

export const daemonFlag = "--standalone-persistent-pty-daemon"

const protocol = 7
const maxFrameBytes = 8 * 1024 * 1024
const replayBytes = 2 * 1024 * 1024
const maxInputBytes = 1024 * 1024
const handoffTimeout = 120_000

type Role = "controller" | "observer"
type Size = { cols: number; rows: number }
type Request =
  | { op: "ping" | "list" | "prepare_handoff" | "shutdown" }
  | { op: "own"; instance_id: string; ticket?: string }
  | ({ op: "create"; program: string; args: string[]; cwd: string; title: string; group_id: string; env: Record<string, string> } & Size)
  | { op: "snapshot" | "terminate"; id: number }
  | { op: "read_rows"; id: number; rows?: number }
  | { op: "replay"; id: number; offset: number }
  | { op: "subscribe"; id: number; offset: number; attachment_id: string; role: Role; takeover: boolean }
  | { op: "write"; id: number; attachment_id?: string; bytes: Buffer }
  | ({ op: "resize"; id: number; attachment_id?: string } & Size)
  | ({ op: "control"; id: number; attachment_id: string } & Size)
  | ({ op: "input"; id: number; attachment_id: string; bytes: Buffer } & Size)
type Info = {
  id: number
  pid: number | null
  title: string
  foreground_process: string | null
  group_id: string
  command: string[]
  cwd: string
  cols: number
  rows: number
  lifecycle: { status: "running" } | { status: "exited"; exit_code: number | null } | { status: "failed"; message: string }
  output_head: number
  output_tail: number
}
type Subscriber = { socket: Socket; id: string; role: Role; lastControl: number }
type Connection = { kind: "initial" } | { kind: "owner"; generation: number } | { kind: "subscriber" } | { kind: "finished" }

/** Same protocol as opencode-pty, hosted by this executable instead of a downloaded binary. */
export async function runPersistentPtyDaemon(args: readonly string[]) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error(`Standalone persistent PTY is not implemented for ${process.platform}/${process.arch}`)
  const directory = runtimeDirectory(args)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const processes = createProcessOwners()
  const lock = await open(path.join(directory, "service.lock"), "a+", 0o600)
  const ffi = createRequire(import.meta.url)("node:ffi") as {
    dlopen(file: null, definitions: Record<string, { arguments: string[]; return: string }>): {
      lib: { close(): void }
      functions: { flock(fd: number, operation: number): number }
    }
  }
  const binding = ffi.dlopen(null, { flock: { arguments: ["i32", "i32"], return: "i32" } })
  // LOCK_EX | LOCK_NB. The kernel releases ownership even after SIGKILL, and
  // renaming the file during a server handoff preserves the held lock.
  if (binding.functions.flock(lock.fd, 6) !== 0) {
    await lock.close()
    binding.lib.close()
    throw new Error("persistent PTY runtime directory is already locked")
  }
  const socketPath = path.join(tmpdir(), `opencode-pty-${process.getuid?.() ?? "user"}-${randomBytes(12).toString("hex")}.sock`)
  const registration = {
    instance_id: randomUUID(),
    pid: process.pid,
    protocol,
    socket: socketPath,
    token: randomBytes(32).toString("hex"),
  }
  const terminals = new Map<number, LiveTerminal>()
  const connections = new Set<Socket>()
  let starting = true
  let stopping = false
  let generation = 0
  let owner: { socket: Socket; generation: number } | undefined
  let ticket: { value: string; expiresAt: number; deadline: number } | undefined
  let ticketTimer: ReturnType<typeof setTimeout> | undefined
  let stopPromise: Promise<void> | undefined
  let complete: () => void = () => {}
  const completion = new Promise<void>((resolve) => { complete = resolve })
  const acquireTimer = setTimeout(() => { void stop() }, 5_000)
  const server = createServer((socket) => {
    connections.add(socket)
    socket.on("error", () => {})
    socket.once("close", () => {
      connections.delete(socket)
      if (owner?.socket !== socket) return
      owner = undefined
      if (ticket && performance.now() < ticket.deadline) return
      void stop()
    })
    const reader = frames(socket)
    void (async () => {
      let connection: Connection = { kind: "initial" }
      while (!stopping) {
        const payload = await reader.next()
        if (!payload) return
        const envelope = decodeEnvelope(payload)
        if (envelope.token !== registration.token) {
          const response = encode({ type: "error", message: "authentication failed" })
          if (connection.kind === "owner") { socket.write(response); continue }
          socket.end(response)
          return
        }
        const request = envelope.request
        if (connection.kind === "owner") {
          if (owner?.generation !== connection.generation) {
            socket.end(encode({ type: "error", message: "owner connection has been superseded" }))
            return
          }
          if (request.op === "prepare_handoff") {
            if (!ticket || performance.now() >= ticket.deadline) {
              ticket = { value: randomBytes(16).toString("hex"), expiresAt: Date.now() + handoffTimeout, deadline: performance.now() + handoffTimeout }
              clearTimeout(ticketTimer)
              ticketTimer = setTimeout(() => {
                ticket = undefined
                if (!owner) void stop()
              }, handoffTimeout)
            }
            socket.write(encode({ type: "handoff", ticket: ticket.value, expires_at: ticket.expiresAt }))
            continue
          }
          if (request.op === "shutdown") {
            const current = connection.generation
            socket.end(encode({ type: "ok" }), () => { if (owner?.generation === current) void stop() })
            return
          }
          socket.write(encode({ type: "error", message: "owner connection only accepts prepare_handoff or shutdown" }))
          continue
        }
        if (request.op === "own") {
          if (request.instance_id !== registration.instance_id) throw new Error("daemon instance_id mismatch")
          const validTicket = ticket && performance.now() < ticket.deadline && request.ticket === ticket.value
          if (!(starting && request.ticket === undefined) && !validTicket)
            throw new Error(owner ? "daemon already has a live owner" : "invalid handoff ticket")
          starting = false
          clearTimeout(acquireTimer)
          clearTimeout(ticketTimer)
          ticket = undefined
          generation++
          owner = { socket, generation }
          connection = { kind: "owner", generation }
          socket.write(encode({ type: "owned" }))
          continue
        }
        if (request.op === "subscribe") {
          const terminal = get(request.id)
          terminal.attach(socket, request)
          connection = { kind: "subscriber" }
          // Subscription sockets carry output only; any further input is invalid.
          await reader.next()
          socket.destroy()
          return
        }
        if (request.op === "shutdown") {
          socket.end(encode({ type: "ok" }), () => { void stop() })
          return
        }
        const response = await dispatch(request)
        connection = { kind: "finished" }
        socket.end(encode(response))
        return
      }
    })().catch((error: unknown) => {
      if (socket.destroyed) return
      socket.end(encode({ type: "error", message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => reader.dispose())
  })

  async function dispatch(request: Request) {
    switch (request.op) {
      case "ping": return { type: "pong", instance_id: registration.instance_id, pid: process.pid, protocol }
      case "list": return { type: "terminals", terminals: [...terminals.values()].map((terminal) => terminal.info()).sort((a, b) => a.id - b.id) }
      case "create": {
        const screen = await createTerminal(request.cols, request.rows)
        if (stopping) { screen.free(); throw new Error("daemon is stopping") }
        const id = (() => {
          for (;;) {
            const value = randomBytes(6).readUIntBE(0, 6)
            if (value && !terminals.has(value)) return value
          }
        })()
        try {
          const terminal = new LiveTerminal(id, request, screen, processes.create)
          terminals.set(id, terminal)
          return { type: "created", terminal: terminal.info() }
        } catch (error) {
          screen.free()
          throw error
        }
      }
      case "write": get(request.id).write(request.attachment_id, request.bytes); return { type: "ok" }
      case "resize": get(request.id).resize(request.attachment_id, request.cols, request.rows); return { type: "ok" }
      case "control": get(request.id).control(request.attachment_id, request.cols, request.rows); return { type: "ok" }
      case "input": get(request.id).control(request.attachment_id, request.cols, request.rows, request.bytes); return { type: "ok" }
      case "snapshot": return get(request.id).snapshot()
      case "read_rows": return get(request.id).readRows(request.rows)
      case "replay": return { type: "replay", ...get(request.id).replay(request.offset, "data_base64") }
      case "terminate": {
        const terminal = get(request.id)
        await terminal.stop()
        terminals.delete(request.id)
        return { type: "ok" }
      }
      case "prepare_handoff": throw new Error("handoff requires the owner connection")
      default: throw new Error(`unsupported request: ${request.op}`)
    }
  }

  function get(id: number) {
    const terminal = terminals.get(id)
    if (!terminal) throw new Error(`terminal ${id} not found`)
    return terminal
  }

  function stop() {
    if (stopPromise) return stopPromise
    stopping = true
    clearTimeout(acquireTimer)
    clearTimeout(ticketTimer)
    stopPromise = (async () => {
      server.close()
      for (const socket of connections) socket.destroy()
      await Promise.all([...terminals.values()].map((terminal) => terminal.stop()))
      terminals.clear()
      processes.close()
      // Core can move registrations during handoff. The open lock's inode
      // follows that move, so cleanup must use its current directory.
      const currentLock = readlinkSync(`/proc/self/fd/${lock.fd}`)
      const service = path.join(path.dirname(currentLock), "service.json")
      const existing = await readFile(service, "utf8").catch(() => undefined)
      if (existing && JSON.parse(existing).instance_id === registration.instance_id) await unlink(service).catch(() => {})
      const held = await lock.stat()
      const found = statSync(currentLock, { throwIfNoEntry: false })
      if (found?.ino === held.ino && found.dev === held.dev) await unlink(currentLock)
      await lock.close()
      binding.lib.close()
      await unlink(socketPath).catch(() => {})
    })().finally(() => {
      process.off("SIGTERM", signal)
      process.off("SIGINT", signal)
      complete()
    })
    return stopPromise
  }
  function signal() { void stop() }
  process.on("SIGTERM", signal)
  process.on("SIGINT", signal)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, () => { server.off("error", reject); resolve() })
    })
    server.on("error", () => { void stop() })
    await chmod(socketPath, 0o600)
    const temporary = path.join(directory, `service.json.${registration.instance_id}.tmp`)
    await lock.writeFile(JSON.stringify({ pid: process.pid, instance_id: registration.instance_id }))
    await open(temporary, "wx", 0o600).then(async (file) => {
      try { await file.writeFile(JSON.stringify(registration)) } finally { await file.close() }
    })
    await rename(temporary, path.join(directory, "service.json"))
    await completion
    await stopPromise
  } catch (error) {
    await stop()
    throw error
  }
}

class LiveTerminal {
  private proc: ReturnType<typeof spawn>
  private screen: Awaited<ReturnType<typeof createTerminal>>
  private value: Info
  private subscribers = new Map<string, Subscriber>()
  private controller: string | undefined
  private generation = 0
  private output = Buffer.alloc(0)
  private lastTitle = ""
  private disposed = false
  private exit: Promise<void>
  private close: (() => void) | undefined
  private stopPromise: Promise<void> | undefined
  private processes: ReturnType<ReturnType<typeof createProcessOwners>["create"]>

  constructor(id: number, request: Extract<Request, { op: "create" }>, screen: Awaited<ReturnType<typeof createTerminal>>, own: ReturnType<typeof createProcessOwners>["create"]) {
    this.screen = screen
    this.proc = spawn(request.program, request.args, {
      name: "xterm-256color", cols: request.cols, rows: request.rows, cwd: request.cwd,
      env: { ...process.env, ...request.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    })
    try { this.processes = own(this.proc.pid) } catch (error) { this.proc.kill("SIGKILL"); throw error }
    this.proc.onProcessExit(() => this.processes.captureExited())
    this.value = {
      id, pid: this.proc.pid, title: request.title, foreground_process: null, group_id: request.group_id,
      command: [request.program, ...request.args], cwd: request.cwd, cols: request.cols, rows: request.rows,
      lifecycle: { status: "running" }, output_head: 0, output_tail: 0,
    }
    this.exit = new Promise<void>((resolve) => { this.close = resolve })
    this.proc.onBinaryData((data) => {
      if (this.disposed) return
      try {
        this.screen.write(data)
        this.replies()
        const start = this.value.output_tail
        this.value.output_tail += data.byteLength
        const incoming = Buffer.from(data)
        this.output = incoming.length >= replayBytes ? Buffer.from(incoming.subarray(-replayBytes)) :
          Buffer.concat([this.output.subarray(Math.max(0, this.output.length + incoming.length - replayBytes)), incoming])
        this.value.output_head = this.value.output_tail - this.output.length
        const frame = Buffer.allocUnsafe(17 + incoming.length)
        frame[0] = 0
        frame.writeBigUInt64BE(BigInt(start), 1)
        frame.writeBigUInt64BE(BigInt(this.value.output_tail), 9)
        incoming.copy(frame, 17)
        this.broadcast(frame)
        const title = this.screen.title()
        if (title !== this.lastTitle) {
          this.lastTitle = title
          this.value.title = title
          this.broadcast({ type: "title_changed", title })
        }
        this.foreground()
      } catch (error) {
        this.value.lifecycle = { status: "failed", message: error instanceof Error ? error.message : String(error) }
        this.processes.kill()
      }
    })
    this.proc.onExit((event) => {
      if (this.value.lifecycle.status !== "failed")
        this.value.lifecycle = { status: "exited", exit_code: event.signal ? null : event.exitCode }
      this.broadcast({ type: "exited", exit_code: event.signal ? null : event.exitCode, final_offset: this.value.output_tail })
      for (const subscriber of this.subscribers.values()) subscriber.socket.end()
      this.subscribers.clear()
      if (this.controller !== undefined) this.generation++
      this.controller = undefined
      this.close?.()
    })
  }

  info() { this.foreground(); return this.value }

  snapshot() {
    const snapshot = this.screen.snapshot()
    return { type: "snapshot", terminal: this.info(), text: snapshot.text, checkpoint_base64: snapshot.checkpoint.toString("base64"), cursor_x: snapshot.cursor_x, cursor_y: snapshot.cursor_y }
  }

  readRows(rows?: number) {
    return { type: "rows", terminal: this.info(), ...this.screen.readRows(rows) }
  }

  replay(offset: number, key: "replay_base64" | "data_base64" = "replay_base64") {
    if (offset > this.value.output_tail) throw new Error(`requested offset ${offset} is beyond tail ${this.value.output_tail}`)
    const available = Math.max(offset, this.value.output_head)
    return {
      requested_offset: offset, available_offset: available, end_offset: this.value.output_tail,
      truncated: offset < this.value.output_head, [key]: this.output.subarray(available - this.value.output_head).toString("base64"),
    }
  }

  attach(socket: Socket, request: Extract<Request, { op: "subscribe" }>) {
    const replay = this.replay(request.offset)
    const info = this.info()
    if (request.role === "controller" && this.controller && this.controller !== request.attachment_id && !request.takeover)
      throw new Error(`terminal already has controller ${this.controller}`)
    const previous = this.subscribers.get(request.attachment_id)
    const subscriber: Subscriber = { socket, id: request.attachment_id, role: request.role, lastControl: previous?.lastControl ?? 0 }
    this.subscribers.set(request.attachment_id, subscriber)
    previous?.socket.destroy()
    if (request.role === "controller") this.claim(subscriber, false)
    // Reusing an attachment ID as an observer relinquishes its controller role.
    if (request.role === "observer" && this.controller === subscriber.id) this.controller = undefined
    socket.once("close", () => this.detach(subscriber))
    socket.on("drain", () => this.flow())
    socket.write(encode({ type: "attached", terminal: info, role: request.role, generation: this.generation, ...replay }))
    if (request.role === "controller") this.broadcast({ type: "controller_changed", attachment_id: this.controller ?? null, generation: this.generation })
    if (this.value.lifecycle.status !== "running") {
      socket.end(encode({ type: "exited", exit_code: this.value.lifecycle.status === "exited" ? this.value.lifecycle.exit_code : null, final_offset: this.value.output_tail }))
    }
    this.flow()
  }

  write(attachment: string | undefined, bytes: Buffer) {
    this.authorize(attachment)
    this.proc.writeBinary(bytes)
  }

  resize(attachment: string | undefined, cols: number, rows: number) {
    this.authorize(attachment)
    this.proc.resize(cols, rows)
    this.screen.resize(cols, rows)
    this.replies()
    this.value.cols = cols
    this.value.rows = rows
    this.broadcast({ type: "resized", cols, rows, generation: this.generation, checkpoint_base64: this.screen.checkpoint().toString("base64") })
  }

  control(attachment: string, cols: number, rows: number, bytes?: Buffer) {
    const subscriber = this.subscribers.get(attachment)
    if (!subscriber) throw new Error(`attachment ${attachment} is not subscribed`)
    this.claim(subscriber, true)
    if (cols !== this.value.cols || rows !== this.value.rows) this.resize(attachment, cols, rows)
    if (bytes) this.proc.writeBinary(bytes)
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = (async () => {
      this.processes.kill()
      this.proc.resume()
      await this.exit
      await this.processes.reap()
      this.disposed = true
      for (const subscriber of this.subscribers.values()) subscriber.socket.destroy()
      this.subscribers.clear()
      this.screen.free()
    })()
    return this.stopPromise
  }

  private claim(subscriber: Subscriber, notify: boolean) {
    if (this.controller === subscriber.id) return
    const current = this.controller ? this.subscribers.get(this.controller) : undefined
    if (current) current.role = "observer"
    this.controller = subscriber.id
    subscriber.role = "controller"
    subscriber.lastControl = ++this.generation
    if (notify) this.broadcast({ type: "controller_changed", attachment_id: this.controller, generation: this.generation })
    this.flow()
  }

  private authorize(attachment?: string) {
    if (attachment === undefined && this.controller === undefined) return
    if (attachment === this.controller) return
    throw new Error(attachment === undefined ? "terminal input requires the active controller attachment" : `attachment ${attachment} is not the terminal controller`)
  }

  private detach(subscriber: Subscriber) {
    if (this.subscribers.get(subscriber.id) !== subscriber) return
    this.subscribers.delete(subscriber.id)
    if (this.controller !== subscriber.id) return
    this.controller = undefined
    this.generation++
    const successor = [...this.subscribers.values()].filter((item) => !item.socket.destroyed).sort((a, b) => b.lastControl - a.lastControl)[0]
    if (successor) {
      this.controller = successor.id
      successor.role = "controller"
      successor.lastControl = this.generation
    }
    this.broadcast({ type: "controller_changed", attachment_id: this.controller ?? null, generation: this.generation })
    this.flow()
  }

  private broadcast(value: unknown) {
    const frame = Buffer.isBuffer(value) ? framed(value) : encode(value)
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.socket.destroyed || (subscriber.role === "observer" && subscriber.socket.writableLength + frame.length > maxFrameBytes)) {
        subscriber.socket.destroy()
        this.detach(subscriber)
        continue
      }
      subscriber.socket.write(frame)
    }
    this.flow()
  }

  private flow() {
    const controller = this.controller ? this.subscribers.get(this.controller) : undefined
    if (controller && !controller.socket.destroyed && controller.socket.writableNeedDrain) { this.proc.pause(); return }
    this.proc.resume()
  }

  private replies() { for (const reply of this.screen.takeResponses()) this.proc.writeBinary(reply) }

  private foreground() {
    const processName = (() => {
      if (this.value.lifecycle.status !== "running") return null
      try {
        const stat = readFileSync(`/proc/${this.proc.pid}/stat`, "utf8")
        const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5])
        return group > 0 ? readFileSync(`/proc/${group}/comm`, "utf8").trim() || null : null
      } catch { return null }
    })()
    if (processName === this.value.foreground_process) return
    this.value.foreground_process = processName
    this.broadcast({ type: "foreground_process_changed", process: processName })
  }
}

function runtimeDirectory(args: readonly string[]) {
  const values = args[0] === "daemon" ? args.slice(1) : args
  if (values.length !== 4) throw new Error("persistent PTY daemon requires --runtime-dir <directory> --name <name>")
  const options = new Map([[values[0], values[1]], [values[2], values[3]]])
  const root = options.get("--runtime-dir")
  const name = options.get("--name")
  if (!root || !name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new Error("invalid persistent PTY runtime directory or name")
  return path.resolve(root, name)
}

function encode(value: unknown) { return framed(Buffer.from(JSON.stringify(value))) }

function framed(payload: Buffer) {
  if (payload.length > maxFrameBytes) throw new Error("opencode-pty frame too large")
  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame.writeUInt32BE(payload.length)
  payload.copy(frame, 4)
  return frame
}

/** One outstanding read; queued and partial frames share a bounded byte budget. */
function frames(socket: Socket) {
  let pending: Buffer = Buffer.alloc(0)
  const queue: Buffer[] = []
  let queued = 0
  let ended = false
  let failure: Error | undefined
  let waiting: { resolve(value: Buffer | undefined): void; reject(error: Error): void } | undefined
  const finish = (error?: Error) => {
    ended = true
    failure = error
    if (!waiting) return
    const current = waiting
    waiting = undefined
    if (error) { current.reject(error); return }
    current.resolve(undefined)
  }
  const data = (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= 4) {
      const size = pending.readUInt32BE()
      if (size > maxFrameBytes) { finish(new Error("opencode-pty frame too large")); socket.destroy(); return }
      if (pending.length < size + 4) break
      const payload = pending.subarray(4, size + 4)
      pending = pending.subarray(size + 4)
      if (waiting) {
        const current = waiting
        waiting = undefined
        current.resolve(payload)
        continue
      }
      queue.push(payload)
      queued += payload.length
    }
    if (pending.length + queued > maxFrameBytes) { finish(new Error("opencode-pty pending frames too large")); socket.destroy() }
  }
  const end = () => finish(pending.length ? new Error("opencode-pty truncated frame") : undefined)
  const close = () => finish()
  const error = (value: Error) => finish(value)
  socket.on("data", data)
  socket.once("end", end)
  socket.once("close", close)
  socket.once("error", error)
  return {
    next(): Promise<Buffer | undefined> {
      const value = queue.shift()
      if (value) { queued -= value.length; return Promise.resolve(value) }
      if (failure) return Promise.reject(failure)
      if (ended) return Promise.resolve(undefined)
      return new Promise((resolve, reject) => { waiting = { resolve, reject } })
    },
    dispose() {
      socket.off("data", data)
      socket.off("end", end)
      socket.off("close", close)
      socket.off("error", error)
    },
  }
}

function decodeEnvelope(payload: Buffer): { token: string; request: Request } {
  const object = record(JSON.parse(payload.toString("utf8")))
  const request = record(object.request)
  const token = string(object.token, "token")
  const op = string(request.op, "operation")
  if (["ping", "list", "prepare_handoff", "shutdown"].includes(op)) return { token, request: { op } as Request }
  if (op === "own") return { token, request: { op, instance_id: string(request.instance_id, "instance_id"), ticket: optionalString(request.ticket, "ticket") } }
  if (op === "create") {
    const env = record(request.env ?? {})
    const environment = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, string(value, `environment ${key}`)]))
    const args = request.args ?? []
    if (!Array.isArray(args)) throw new Error("args must be an array")
    const program = string(request.program ?? process.env.SHELL ?? "/bin/sh", "program")
    if (!program.trim()) throw new Error("terminal program cannot be empty")
    return { token, request: { op, program, args: args.map((arg) => string(arg, "argument")), env: environment,
      cwd: string(request.cwd ?? process.cwd(), "cwd"), title: string(request.title ?? "Terminal", "title"), group_id: string(request.group_id ?? "default", "group_id"),
      cols: dimension(request.cols ?? 100), rows: dimension(request.rows ?? 30) } }
  }
  const id = integer(request.id, "terminal ID", 1)
  if (op === "snapshot" || op === "terminate") return { token, request: { op, id } }
  if (op === "read_rows") return { token, request: { op, id, rows: request.rows == null ? undefined : dimension(request.rows) } }
  if (op === "replay") return { token, request: { op, id, offset: integer(request.offset ?? 0, "offset", 0) } }
  if (op === "subscribe") {
    if (request.role !== "controller" && request.role !== "observer") throw new Error("invalid attachment role")
    if (request.takeover != null && typeof request.takeover !== "boolean") throw new Error("takeover must be a boolean")
    return { token, request: { op, id, offset: integer(request.offset ?? 0, "offset", 0), attachment_id: string(request.attachment_id, "attachment_id"), role: request.role, takeover: request.takeover === true } }
  }
  const attachment_id = optionalString(request.attachment_id, "attachment_id")
  if (op === "write") return { token, request: { op, id, attachment_id, bytes: input(request.data_base64) } }
  const cols = dimension(request.cols)
  const rows = dimension(request.rows)
  if (op === "resize") return { token, request: { op, id, attachment_id, cols, rows } }
  if (op === "control" || op === "input") {
    if (attachment_id === undefined) throw new Error("attachment_id is required")
    if (op === "control") return { token, request: { op, id, attachment_id, cols, rows } }
    return { token, request: { op, id, attachment_id, cols, rows, bytes: input(request.data_base64) } }
  }
  throw new Error(`unsupported request: ${op}`)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request must be an object")
  return value as Record<string, unknown>
}
function string(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value
}
function optionalString(value: unknown, name: string) { return value == null ? undefined : string(value, name) }
function integer(value: unknown, name: string, minimum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`)
  return value
}
function dimension(value: unknown) {
  const result = integer(value, "terminal dimension", 1)
  if (result > 65535) throw new Error("terminal dimension must fit u16")
  return result
}
function input(value: unknown) {
  const encoded = string(value, "data_base64")
  if (encoded.length > Math.ceil(maxInputBytes / 3) * 4) throw new Error(`input exceeds ${maxInputBytes} byte limit`)
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("invalid input base64")
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.toString("base64") !== encoded) throw new Error("invalid input base64")
  if (bytes.length > maxInputBytes) throw new Error(`input exceeds ${maxInputBytes} byte limit`)
  return bytes
}
