import { readFile } from "node:fs/promises"
import { lookup } from "node:dns/promises"
import { connect } from "node:net"
import { homedir, hostname } from "node:os"
import { join } from "node:path"

const propertyMask = (1 << 22) | (1 << 17)
const maxPacket = 256 * 1024
const textMimeTypes = ["text/plain;charset=utf-8", "text/plain"]

/** A real X11 selection owner/requestor. No addon, helper process, or extracted file is used. */
export async function createX11Clipboard(options = {}) {
  const environment = options.env ?? process.env
  const display = parseDisplay(options.display ?? environment.DISPLAY)
  const auth = await readAuthorization(options.xauthority ?? environment.XAUTHORITY ?? join(environment.HOME ?? homedir(), ".Xauthority"), display)
  const connection = new XConnection(display, auth, options)
  const stopTimer = startDeadline(options.timeoutMs ?? 5000, () => connection.fail(Object.assign(new Error("X11 initialization deadline exceeded"), { code: "X11_TIMEOUT" })))
  try {
    await connection.initialize()
    return await createX11Service(connection, options)
  } catch (error) {
    connection.dispose()
    throw error
  } finally {
    stopTimer()
  }
}

async function createX11Service(connection, options) {
  let disposed = false
  let mutations = Promise.resolve()
  const owned = new Map()
  const transfers = new Map()
  const maxTransfers = options.maxProviderTransfers ?? 16
  const maxBytes = options.maxReadBytes ?? 64 * 1024 * 1024
  const chunkBytes = Math.min(64 * 1024, connection.maximumRequestBytes - 24)
  const atoms = Object.fromEntries(await Promise.all([
    "CLIPBOARD", "PRIMARY", "TARGETS", "TIMESTAMP", "UTF8_STRING", "TEXT", "STRING", "ATOM", "INTEGER", "INCR",
    "text/plain;charset=UTF-8", "text/plain;charset=utf-8", "text/plain", "_OPENCODE_CLIPBOARD", "_OPENCODE_CLIPBOARD_CLOCK",
  ].map(async (name) => [name, await connection.atom(name)])))
  const ownerWindow = connection.createWindow()
  const active = new Set()
  await connection.barrier()

  function finishTransfer(key) {
    const transfer = transfers.get(key)
    if (!transfer) return
    clearTimeout(transfer.timer)
    transfers.delete(key)
    if (![...transfers.values()].some((other) => other.requestor === transfer.requestor)) connection.selectEvents(transfer.requestor, 0)
  }

  function notify(event, property) {
    const bytes = Buffer.alloc(32)
    bytes[0] = 31
    event.copy(bytes, 4, 4, 8)
    event.copy(bytes, 8, 12, 24)
    bytes.writeUInt32LE(property, 20)
    connection.sendEvent(event.readUInt32LE(12), bytes)
  }

  function serveTarget(requestor, property, target, provider) {
    if (target === atoms.TARGETS) {
      connection.changeProperty(requestor, property, atoms.ATOM, 32, words([
        atoms.TARGETS, atoms.TIMESTAMP, atoms.UTF8_STRING,
        ...textMimeTypes.map((mime) => atoms[mime]), atoms.TEXT,
        ...(provider.latin1?.length ? [atoms.STRING] : []),
      ]))
      return true
    }
    if (target === atoms.TIMESTAMP) {
      connection.changeProperty(requestor, property, atoms.INTEGER, 32, words([provider.timestamp]))
      return true
    }
    if (target === atoms.STRING && !provider.latin1?.length) return false
    const bytes = target === atoms.STRING ? provider.latin1 : provider.bytes
    if (![atoms.UTF8_STRING, atoms.TEXT, atoms.STRING, ...textMimeTypes.map((mime) => atoms[mime])].includes(target)) return false
    const type = target === atoms.TEXT ? atoms.UTF8_STRING : target
    if (bytes.length <= chunkBytes) {
      connection.changeProperty(requestor, property, type, 8, bytes)
      return true
    }
    const key = `${requestor}:${property}`
    if (transfers.has(key) || transfers.size >= maxTransfers) return false
    const transfer = { requestor, property, bytes, type, offset: 0, timer: undefined }
    transfer.timer = setTimeout(() => finishTransfer(key), 30_000)
    transfer.timer.unref()
    transfers.set(key, transfer)
    connection.selectEvents(requestor, propertyMask)
    connection.changeProperty(requestor, property, atoms.INCR, 32, words([bytes.length]))
    return true
  }

  connection.onEvent = (event) => {
    const kind = event[0] & 127
    if (kind === 29) {
      const selection = event.readUInt32LE(12)
      const provider = owned.get(selection)
      if (provider && ((event.readUInt32LE(4) - provider.timestamp) | 0) >= 0) owned.delete(selection)
      return
    }
    if (kind === 17) {
      for (const [key, transfer] of transfers) if (transfer.requestor === event.readUInt32LE(8)) finishTransfer(key)
      return
    }
    if (kind === 28 && event[16] === 1) {
      const key = `${event.readUInt32LE(4)}:${event.readUInt32LE(8)}`
      const transfer = transfers.get(key)
      if (!transfer) return
      const chunk = transfer.bytes.subarray(transfer.offset, transfer.offset + chunkBytes)
      connection.changeProperty(transfer.requestor, transfer.property, transfer.type, 8, chunk)
      transfer.offset += chunk.length
      transfer.timer.refresh()
      if (!chunk.length) finishTransfer(key)
      return
    }
    if (kind !== 30) return
    const provider = owned.get(event.readUInt32LE(16))
    const property = event.readUInt32LE(24) || event.readUInt32LE(20)
    if (!provider || (event.readUInt32LE(4) !== 0 && ((event.readUInt32LE(4) - provider.timestamp) | 0) < 0)) return notify(event, 0)
    const requestor = event.readUInt32LE(12)
    notify(event, serveTarget(requestor, property, event.readUInt32LE(20), provider) ? property : 0)
  }

  async function operate(operationOptions, body) {
    if (disposed) throw new Error("Host clipboard backend is disposed")
    const controller = new AbortController()
    const cancel = () => controller.abort(operationOptions.signal.reason)
    if (operationOptions.signal?.aborted) return { status: "cancelled" }
    operationOptions.signal?.addEventListener("abort", cancel, { once: true })
    const stopTimer = startDeadline(operationOptions.timeoutMs ?? options.timeoutMs ?? 5000, () => controller.abort(new Error("X11 clipboard deadline exceeded")))
    const timeout = () => ({ status: operationOptions.signal?.aborted || disposed ? "cancelled" : "timed-out" })
    active.add(controller)
    try {
      return await body(controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return timeout()
      return { status: error.code === "X11_LIMIT" ? "limit-exceeded" : "failed", ...(error.code === "X11_LIMIT" ? {} : { error }) }
    } finally {
      stopTimer()
      operationOptions.signal?.removeEventListener("abort", cancel)
      active.delete(controller)
    }
  }

  async function convert(window, selection, target, limit, signal) {
    connection.discardEvents(window)
    connection.deleteProperty(window, atoms._OPENCODE_CLIPBOARD)
    const notification = connection.waitEvent((event) => (event[0] & 127) === 31 && event.readUInt32LE(8) === window, signal)
    const request = Buffer.alloc(24)
    request.writeUInt32LE(window, 4)
    request.writeUInt32LE(selection, 8)
    request.writeUInt32LE(target, 12)
    request.writeUInt32LE(atoms._OPENCODE_CLIPBOARD, 16)
    connection.send(24, request)
    const event = await notification
    if (!event.readUInt32LE(20)) return null
    const first = await connection.getProperty(window, atoms._OPENCODE_CLIPBOARD, Math.min(limit + 4, 64 * 1024), false, signal)
    if (first.type !== atoms.INCR) return collectProperty(window, first, limit, false, signal)
    if (first.format !== 32 || first.bytes.length % 4) throw new Error("Invalid X11 INCR announcement")
    // xclip legitimately omits the ICCCM size hint; the accumulated byte limit still applies.
    if (first.bytes.length && first.bytes.readUInt32LE(0) > limit) throw Object.assign(new Error("X11 selection exceeds read limit"), { code: "X11_LIMIT" })
    connection.discardEvents(window)
    const chunks = []
    let length = 0
    let actualType = 0
    let format = 0
    while (true) {
      const next = connection.waitEvent((event) => (event[0] & 127) === 28 && event.readUInt32LE(4) === window && event.readUInt32LE(8) === atoms._OPENCODE_CLIPBOARD && event[16] === 0, signal)
      connection.deleteProperty(window, atoms._OPENCODE_CLIPBOARD)
      await next
      const property = await connection.getProperty(window, atoms._OPENCODE_CLIPBOARD, Math.min(limit - length + 4, 64 * 1024), false, signal)
      if (!property.type) throw new Error("X11 incremental selection property disappeared")
      if (actualType && (actualType !== property.type || format !== property.format)) throw new Error("X11 incremental selection changed its type")
      actualType = property.type
      format = property.format
      const chunk = await collectProperty(window, property, limit - length, true, signal)
      if (!chunk.bytes.length) return { type: actualType, format, bytes: Buffer.concat(chunks, length) }
      chunks.push(chunk.bytes)
      length += chunk.bytes.length
    }
  }

  async function collectProperty(window, first, limit, incremental, signal) {
    const chunks = []
    let length = 0
    let property = first
    while (true) {
      if (property.bytes.length + property.bytesAfter > limit - length) throw Object.assign(new Error("X11 selection exceeds read limit"), { code: "X11_LIMIT" })
      if (property.type !== first.type || property.format !== first.format) throw new Error("X11 selection property changed its type")
      chunks.push(property.bytes)
      length += property.bytes.length
      if (!property.bytesAfter) break
      if (!property.bytes.length || property.bytes.length % 4) throw new Error("Invalid X11 property continuation")
      property = await connection.getProperty(window, atoms._OPENCODE_CLIPBOARD, Math.min(limit - length + 4, 64 * 1024), false, signal, length / 4)
    }
    if (!incremental) connection.deleteProperty(window, atoms._OPENCODE_CLIPBOARD)
    return { type: first.type, format: first.format, bytes: Buffer.concat(chunks, length) }
  }

  async function mutate(text, operationOptions, clear) {
    return operate(operationOptions, async (signal) => {
      const selection = atoms[operationOptions.selection === "primary" ? "PRIMARY" : "CLIPBOARD"]
      const clockWindow = connection.createWindow()
      connection.trackWindow(clockWindow)
      try {
        const tick = connection.waitEvent((event) => (event[0] & 127) === 28 && event.readUInt32LE(4) === clockWindow && event.readUInt32LE(8) === atoms._OPENCODE_CLIPBOARD_CLOCK, signal)
        connection.changeProperty(clockWindow, atoms._OPENCODE_CLIPBOARD_CLOCK, atoms.INTEGER, 8, Buffer.alloc(0))
        const timestamp = (await tick).readUInt32LE(12)
        signal.throwIfAborted()
        const bytes = clear ? undefined : Buffer.from(text)
        if (!clear) owned.set(selection, { bytes, latin1: /^[\x00-\xff]*$/u.test(text) ? Buffer.from(text, "latin1") : undefined, timestamp })
        const request = Buffer.alloc(16)
        request.writeUInt32LE(clear ? 0 : ownerWindow, 4)
        request.writeUInt32LE(selection, 8)
        request.writeUInt32LE(timestamp, 12)
        connection.send(22, request)
        const owner = await connection.selectionOwner(selection, signal)
        if (owner !== (clear ? 0 : ownerWindow)) {
          owned.delete(selection)
          throw new Error("X11 server did not confirm clipboard ownership")
        }
        if (clear) owned.delete(selection)
        return { status: clear ? "cleared" : "written" }
      } finally {
        connection.destroyWindow(clockWindow)
      }
    })
  }

  return {
    read(operationOptions = {}) {
      return operate(operationOptions, async (signal) => {
        const limit = operationOptions.maxBytes ?? maxBytes
        if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid X11 clipboard read limit")
        const preferences = (operationOptions.preferredTypes ?? textMimeTypes).map((mimeType) => ({ mimeType, essence: mimeType.split(";", 1)[0].trim().toLowerCase() })).filter((preference) => ["text/plain", "image/png", "image/jpeg", "image/webp", "image/gif"].includes(preference.essence))
        if (!preferences.length) return { status: "unsupported" }
        const selection = atoms[operationOptions.selection === "primary" ? "PRIMARY" : "CLIPBOARD"]
        if (!await connection.selectionOwner(selection, signal)) return { status: "empty" }
        const window = connection.createWindow()
        connection.trackWindow(window)
        try {
          const targets = await convert(window, selection, atoms.TARGETS, 64 * 1024, signal)
          const available = targets?.format === 32 && targets.type === atoms.ATOM ? new Set(Array.from({ length: targets.bytes.length / 4 }, (_, index) => targets.bytes.readUInt32LE(index * 4))) : null
          for (const { mimeType, essence } of preferences) {
            const candidates = essence === "text/plain" ? [atoms["text/plain;charset=UTF-8"], atoms["text/plain;charset=utf-8"], atoms.UTF8_STRING, atoms["text/plain"], atoms.TEXT, atoms.STRING] : [await connection.atom(essence, signal)]
            for (const target of new Set(candidates)) {
              if (available && !available.has(target)) continue
              const value = await convert(window, selection, target, limit, signal)
              if (!value) continue
              if (value.format !== 8) throw new Error("X11 clipboard representation does not contain bytes")
              const accepted = essence === "text/plain" ? [atoms.UTF8_STRING, atoms["text/plain;charset=UTF-8"], atoms["text/plain;charset=utf-8"], atoms["text/plain"], atoms.STRING] : [target]
              if (!accepted.includes(value.type)) throw new Error("X11 clipboard representation has an unexpected type")
              const bytes = value.type === atoms.STRING ? Buffer.from(value.bytes.toString("latin1")) : value.bytes
              if (bytes.length > limit) return { status: "limit-exceeded" }
              if (essence === "image/png" && !bytes.length) break
              return { status: "read", representation: { mimeType, bytes: new Uint8Array(bytes) } }
            }
          }
          return { status: "empty" }
        } finally {
          connection.destroyWindow(window)
        }
      })
    },
    writeText(text, operationOptions = {}) {
      if (disposed) return Promise.reject(new Error("Host clipboard backend is disposed"))
      const result = mutations.then(() => mutate(text, operationOptions, false))
      mutations = result.catch(() => {})
      return result
    },
    clear(operationOptions = {}) {
      if (disposed) return Promise.reject(new Error("Host clipboard backend is disposed"))
      const result = mutations.then(() => mutate("", operationOptions, true))
      mutations = result.catch(() => {})
      return result
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const controller of active) controller.abort(new Error("X11 clipboard disposed"))
      for (const key of transfers.keys()) finishTransfer(key)
      owned.clear()
      connection.dispose()
      await mutations
    },
  }
}

function words(values) {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4))
  return bytes
}

function startDeadline(milliseconds, callback) {
  const deadline = performance.now() + milliseconds
  let timer
  function schedule() {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return callback()
    timer = setTimeout(schedule, Math.min(remaining, 2147483647))
  }
  schedule()
  return () => clearTimeout(timer)
}

function parseDisplay(value) {
  const match = /^(?:(unix)\/)?(\[[^\]]+\]|[^:]*):(\d+)(?:\.(\d+))?$/.exec(value ?? "")
  if (!match) throw Object.assign(new Error("No supported X11 DISPLAY is configured"), { code: "X11_UNSUPPORTED" })
  const number = Number(match[3])
  const screen = Number(match[4] ?? 0)
  if (number > 59535 || screen > 255) throw Object.assign(new Error("Invalid X11 DISPLAY number"), { code: "X11_UNSUPPORTED" })
  const host = match[2].replace(/^\[|\]$/g, "")
  return { number, screen, host, local: !!match[1] || host === "" || host === "unix" }
}

async function readAuthorization(path, display) {
  const source = await readFile(path).catch((error) => { if (error.code !== "ENOENT") throw error; return Buffer.alloc(0) })
  if (source.length > 1024 * 1024) throw new Error("Xauthority file exceeds 1 MiB")
  let offset = 0
  let wildcard
  const addresses = display.local ? [] : await lookup(display.host, { all: true })
  const local = display.local || ["localhost", "127.0.0.1", "::1", hostname()].includes(display.host)
  while (offset < source.length) {
    if (offset + 2 > source.length) throw new Error("Malformed Xauthority file")
    const family = source.readUInt16BE(offset)
    offset += 2
    const fields = []
    for (let index = 0; index < 4; index++) {
      if (offset + 2 > source.length) throw new Error("Malformed Xauthority file")
      const length = source.readUInt16BE(offset)
      offset += 2
      if (offset + length > source.length) throw new Error("Malformed Xauthority file")
      fields.push(source.subarray(offset, offset + length))
      offset += length
    }
    if (fields[1].toString() !== String(display.number) || fields[2].toString() !== "MIT-MAGIC-COOKIE-1" || fields[3].length !== 16) continue
    if (family === 65535) wildcard = { name: fields[2], data: fields[3] }
    if (local && family === 256 && [hostname(), "", display.host].includes(fields[0].toString())) return { name: fields[2], data: fields[3] }
    if (!display.local && (family === 0 && fields[0].length === 4 || family === 6 && fields[0].length === 16) && addresses.some((address) => addressBytes(address.address)?.equals(fields[0]))) return { name: fields[2], data: fields[3] }
  }
  return wildcard ?? { name: Buffer.alloc(0), data: Buffer.alloc(0) }
}

function addressBytes(address) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return Buffer.from(address.split(".").map(Number))
  const groups = address.split("::")
  if (groups.length > 2) return undefined
  const left = groups[0] ? groups[0].split(":") : []
  const right = groups[1] ? groups[1].split(":") : []
  const expanded = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
  if (expanded.length !== 8 || expanded.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined
  const bytes = Buffer.alloc(16)
  expanded.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2))
  return bytes
}

class XConnection {
  constructor(display, auth, options) {
    this.display = display
    this.auth = auth
    this.options = options
    this.sequence = 0
    this.resource = 0
    this.pending = new Map()
    this.waiters = new Set()
    this.tracked = new Set()
    this.events = []
    this.atoms = new Map()
    this.buffer = Buffer.alloc(0)
    this.onEvent = () => {}
  }

  async initialize() {
    if (this.error) throw this.error
    this.options.signal?.throwIfAborted()
    this.socket = connect(this.display.local ? { path: `/tmp/.X11-unix/X${this.display.number}` } : { host: this.display.host, port: 6000 + this.display.number })
    this.socket.setNoDelay(true)
    this.socket.unref()
    const signal = this.options.signal
    const abort = () => this.fail(signal.reason ?? new Error("X11 connection cancelled"))
    this.setup = Promise.withResolvers()
    const stopTimer = startDeadline(this.options.timeoutMs ?? 5000, () => this.fail(Object.assign(new Error("X11 connection deadline exceeded"), { code: "X11_TIMEOUT" })))
    this.socket.on("error", (error) => this.fail(error))
    this.socket.on("close", () => this.fail(new Error("X11 connection closed")))
    this.socket.on("data", (bytes) => {
      try { this.receive(bytes) } catch (error) { this.fail(error) }
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    const header = Buffer.alloc(12 + ((this.auth.name.length + 3) & ~3) + ((this.auth.data.length + 3) & ~3))
    header[0] = 108
    header.writeUInt16LE(11, 2)
    header.writeUInt16LE(this.auth.name.length, 6)
    header.writeUInt16LE(this.auth.data.length, 8)
    this.auth.name.copy(header, 12)
    this.auth.data.copy(header, 12 + ((this.auth.name.length + 3) & ~3))
    this.socket.write(header)
    try { await this.setup.promise } finally { stopTimer(); signal?.removeEventListener("abort", abort) }
  }

  receive(bytes) {
    if (this.buffer.length + bytes.length > maxPacket * 2) throw new Error("X11 receive buffer exceeds protocol limit")
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes
    while (this.buffer.length >= (this.ready ? 32 : 8)) {
      const length = this.ready ? 32 + (this.buffer[0] === 1 || (this.buffer[0] & 127) === 35 ? this.buffer.readUInt32LE(4) * 4 : 0) : 8 + this.buffer.readUInt16LE(6) * 4
      if (length > maxPacket) throw new Error("X11 reply exceeds protocol limit")
      if (this.buffer.length < length) return
      const packet = this.buffer.subarray(0, length)
      this.buffer = this.buffer.subarray(length)
      if (!this.ready) {
        if (packet[0] !== 1) throw new Error(`X11 setup rejected: ${packet.subarray(8, 8 + packet[1]).toString()}`)
        if (packet.length < 40 || !packet[28] || this.display.screen >= packet[28]) throw new Error("Invalid X11 setup screen")
        this.resourceBase = packet.readUInt32LE(12)
        this.resourceMask = packet.readUInt32LE(16)
        this.maximumRequestBytes = Math.min(packet.readUInt16LE(26) * 4, maxPacket)
        let screen = 40 + ((packet.readUInt16LE(24) + 3) & ~3) + packet[29] * 8
        for (let index = 0; index < this.display.screen; index++) {
          const depths = packet[screen + 39]
          screen += 40
          for (let depth = 0; depth < depths; depth++) screen += 8 + packet.readUInt16LE(screen + 2) * 24
        }
        if (screen + 40 > packet.length) throw new Error("Truncated X11 setup screen")
        this.root = packet.readUInt32LE(screen)
        this.ready = true
        this.setup.resolve()
        continue
      }
      if (packet[0] === 0 || packet[0] === 1) {
        const pending = this.pending.get(packet.readUInt16LE(2))
        if (!pending) continue
        this.pending.delete(packet.readUInt16LE(2))
        pending.finish(packet[0] === 0 ? new Error(`X11 protocol error ${packet[1]} for request ${packet[10]}`) : null, packet)
        continue
      }
      this.onEvent(packet)
      const waiter = [...this.waiters].find((candidate) => candidate.predicate(packet))
      if (waiter) { waiter.finish(null, packet); continue }
      const kind = packet[0] & 127
      const window = kind === 28 ? packet.readUInt32LE(4) : kind === 31 ? packet.readUInt32LE(8) : 0
      if (!this.tracked.has(window) || kind === 28 && packet[16] !== 0) continue
      if (this.events.length >= 1024) throw new Error("X11 event queue exceeds protocol limit")
      this.events.push(Buffer.from(packet))
    }
  }

  fail(error) {
    if (this.error) return
    this.error = error
    this.setup?.reject(error)
    for (const pending of this.pending.values()) pending.finish(error)
    for (const waiter of this.waiters) waiter.finish(error)
    this.pending.clear()
    this.waiters.clear()
    this.socket?.destroy()
  }

  send(opcode, bytes, detail = 0) {
    if (this.error) throw this.error
    if (bytes.length > this.maximumRequestBytes || bytes.length % 4) throw new Error("Invalid X11 request length")
    const sequence = (this.sequence + 1) & 65535
    if (this.pending.has(sequence)) throw new Error("X11 pending request sequence exhausted")
    this.sequence = sequence
    bytes[0] = opcode
    bytes[1] = detail
    bytes.writeUInt16LE(bytes.length / 4, 2)
    if (this.socket.writableLength + bytes.length > 2 * 1024 * 1024) throw new Error("X11 output backpressure limit exceeded")
    this.socket.write(bytes)
    return sequence
  }

  request(opcode, bytes, detail = 0, signal) {
    signal ??= this.options.signal
    if (signal?.aborted) return Promise.reject(signal.reason)
    const deferred = Promise.withResolvers()
    const sequence = this.send(opcode, bytes, detail)
    const abort = () => finish(signal.reason ?? new Error("X11 request cancelled"))
    const finish = (error, reply) => {
      signal?.removeEventListener("abort", abort)
      this.pending.delete(sequence)
      if (error) deferred.reject(error)
      else deferred.resolve(reply)
    }
    this.pending.set(sequence, { finish })
    signal?.addEventListener("abort", abort, { once: true })
    return deferred.promise
  }

  waitEvent(predicate, signal) {
    if (this.error) return Promise.reject(this.error)
    if (signal?.aborted) return Promise.reject(signal.reason)
    const index = this.events.findIndex(predicate)
    if (index !== -1) return Promise.resolve(this.events.splice(index, 1)[0])
    const deferred = Promise.withResolvers()
    const abort = () => finish(signal.reason ?? new Error("X11 event wait cancelled"))
    const waiter = { predicate, finish }
    const waiters = this.waiters
    function finish(error, event) {
      signal?.removeEventListener("abort", abort)
      waiters.delete(waiter)
      if (error) deferred.reject(error)
      else deferred.resolve(event)
    }
    waiters.add(waiter)
    signal?.addEventListener("abort", abort, { once: true })
    return deferred.promise
  }

  trackWindow(window) { this.tracked.add(window) }
  discardEvents(window) { this.events = this.events.filter((event) => ((event[0] & 127) === 28 ? event.readUInt32LE(4) : event.readUInt32LE(8)) !== window) }
  createWindow() {
    this.resource++
    if (this.resource > this.resourceMask) throw new Error("X11 resource identifiers exhausted")
    const window = (this.resourceBase | this.resource) >>> 0
    const request = Buffer.alloc(36)
    request.writeUInt32LE(window, 4)
    request.writeUInt32LE(this.root, 8)
    request.writeUInt16LE(1, 16)
    request.writeUInt16LE(1, 18)
    request.writeUInt16LE(2, 22)
    request.writeUInt32LE(2048, 28)
    request.writeUInt32LE(propertyMask, 32)
    this.send(1, request)
    return window
  }
  destroyWindow(window) {
    this.tracked.delete(window)
    this.discardEvents(window)
    if (!this.error) this.send(4, Buffer.concat([Buffer.alloc(4), words([window])]))
  }
  selectEvents(window, mask) { if (!this.error) this.send(2, Buffer.concat([Buffer.alloc(4), words([window, 2048, mask])])) }
  changeProperty(window, property, type, format, bytes) {
    const request = Buffer.alloc(24 + ((bytes.length + 3) & ~3))
    request.writeUInt32LE(window, 4)
    request.writeUInt32LE(property, 8)
    request.writeUInt32LE(type, 12)
    request[16] = format
    request.writeUInt32LE(bytes.length / (format / 8), 20)
    bytes.copy(request, 24)
    this.send(18, request)
  }
  deleteProperty(window, property) { this.send(19, Buffer.concat([Buffer.alloc(4), words([window, property])])) }
  sendEvent(window, bytes) { this.send(25, Buffer.concat([Buffer.alloc(4), words([window, 0]), bytes])) }
  async getProperty(window, property, limit, remove, signal, offset = 0) {
    const reply = await this.request(20, Buffer.concat([Buffer.alloc(4), words([window, property, 0, offset, Math.ceil(limit / 4)])]), remove ? 1 : 0, signal)
    const format = reply[1]
    if (![0, 8, 16, 32].includes(format)) throw new Error("Invalid X11 property format")
    const length = reply.readUInt32LE(16) * (format / 8)
    if (length > reply.length - 32) throw new Error("Truncated X11 property")
    return { format, type: reply.readUInt32LE(8), bytesAfter: reply.readUInt32LE(12), bytes: Buffer.from(reply.subarray(32, 32 + length)) }
  }
  async atom(name, signal) {
    if (this.atoms.has(name)) return this.atoms.get(name)
    const encoded = Buffer.from(name)
    if (encoded.length > 65535) throw new Error("X11 atom name is too long")
    const request = Buffer.alloc(8 + ((encoded.length + 3) & ~3))
    request.writeUInt16LE(encoded.length, 4)
    encoded.copy(request, 8)
    const reply = await this.request(16, request, 0, signal)
    const atom = reply.readUInt32LE(8)
    this.atoms.set(name, atom)
    return atom
  }
  async selectionOwner(selection, signal) { return (await this.request(23, Buffer.concat([Buffer.alloc(4), words([selection])]), 0, signal)).readUInt32LE(8) }
  barrier() { return this.request(43, Buffer.alloc(4)) }
  dispose() { this.fail(new Error("X11 clipboard connection disposed")) }
}
