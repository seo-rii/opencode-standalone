import { closeSync } from "node:fs"
import { failure, waylandIO } from "./wayland-io.mjs"

/** Direct ext/wlr data-control client; no libwayland or clipboard subprocess. */
export async function createWaylandClipboard(options = {}) {
  const clipboard = new WaylandClipboard(options)
  try {
    await clipboard.initialize(options.signal, options.timeoutMs ?? 2000)
    return clipboard
  } catch (error) {
    await clipboard.dispose()
    throw error
  }
}

class WaylandClipboard {
  constructor(options) {
    this.options = options
    this.io = waylandIO(options.env ?? process.env)
    this.objects = new Map([[1, { kind: "display" }]])
    this.globals = new Map()
    this.seats = []
    this.seatsOverflowed = false
    this.offers = new Map()
    this.sources = new Set()
    this.selections = { clipboard: undefined, primary: undefined }
    this.providers = { clipboard: undefined, primary: undefined }
    this.primarySupported = false
    this.active = new Set()
    this.pending = Buffer.alloc(0)
    this.descriptors = []
    this.free = []
    this.next = 2
    this.disposed = false
    this.closed = false
    this.error = undefined
    this.transferBuffer = Buffer.alloc(65536)
    this.tick = () => {
      if (this.closed) return
      try { this.drive() } catch (error) { this.fail(error) }
      if (!this.closed) this.timer = setTimeout(this.tick, 4).unref()
    }
    this.timer = setTimeout(this.tick, 0).unref()
  }

  async initialize(signal, timeoutMs) {
    const operation = this.operation({ signal, timeoutMs })
    try {
      this.registry = this.object({ kind: "registry" })
      this.request(1, 1, [this.registry])
      await this.roundtrip(operation)
      // wl_seat bindings are emitted while handling registry globals.
      await this.roundtrip(operation)
      const environment = this.options.env ?? process.env
      const seat = this.options.waylandSeat
        ? this.seats.find((item) => item.name === this.options.waylandSeat)
        : this.seatsOverflowed ? undefined
          : this.seats.find((item) => item.name === environment.XDG_SEAT) ?? (this.seats.length === 1 ? this.seats[0] : undefined)
      const manager = [...this.globals.values()].find((item) => item.name === "ext_data_control_manager_v1")
        ?? [...this.globals.values()].find((item) => item.name === "zwlr_data_control_manager_v1")
      if (!seat || !manager) throw failure("WAYLAND_UNSUPPORTED", !seat ? "Wayland clipboard seat is absent or ambiguous" : "Wayland compositor has no supported data-control protocol")
      this.managerGlobal = manager.id
      this.seatGlobal = seat.global
      this.version = manager.name === "ext_data_control_manager_v1" ? 1 : Math.min(manager.version, 2)
      this.manager = this.bind(manager.id, manager.name, this.version, { kind: "manager" })
      this.device = this.object({ kind: "device" })
      this.request(this.manager, 1, [this.device, seat.id])
      await this.roundtrip(operation)
      this.ensure(operation)
    } finally { operation.dispose() }
  }

  async read(options) {
    return this.run(options, async (operation) => {
      await this.roundtrip(operation)
      this.ensure(operation)
      const selection = options.selection ?? "clipboard"
      if (selection === "primary" && !this.primarySupported) return { status: "unsupported" }
      const preferred = options.preferredTypes ?? ["text/plain"]
      let retries = 0
      let implemented = false
      let failed
      for (let index = 0; index < preferred.length; index++) {
        this.ensure(operation)
        const offer = this.selections[selection]
        if (!offer) return { status: "empty" }
        const mimeType = canonicalMime(preferred[index])
        // BMP is recognized by the protocol but native host.zig only reads it
        // through the separate WSL PNG conversion path, not data-control.
        if (!mimeType || mimeType === "image/bmp") continue
        implemented = true
        const offered = offer.mimes.find((item) => canonicalMime(item) === mimeType)
        if (!offered) continue
        const result = await this.readOffer(offer, { offered, mimeType }, operation, options.maxBytes ?? 16 * 1024 * 1024).catch((error) => {
          this.ensure(operation)
          failed = error
          return undefined
        })
        if (!result) continue
        if (result.status !== "read" || mimeType === "text/plain" || result.representation.bytes.length) return result
        // A vanished image source closes the transfer without bytes. Order a
        // fresh selection snapshot before retrying, as in the native backend.
        if (retries++ < 2) { await this.roundtrip(operation); index = -1 }
      }
      return failed ? { status: "failed", error: failed } : { status: implemented ? "empty" : "unsupported" }
    })
  }

  async readOffer(offer, match, operation, maximum) {
    const [read, write] = this.io.pipe()
    offer.readers++
    const transfer = { kind: "read", fd: read, chunks: [], size: 0, maximum, offer, operation, match }
    try { this.request(offer.id, 0, [match.offered], [write]) } catch (error) { closeSync(read); offer.readers--; throw error } finally { closeSync(write) }
    return new Promise((resolve, reject) => {
      transfer.resolve = resolve
      transfer.reject = reject
      transfer.abort = () => this.finishRead(transfer, undefined, operation.error())
      this.active.add(transfer)
      operation.signal.addEventListener("abort", transfer.abort, { once: true })
      if (operation.signal.aborted) transfer.abort()
    })
  }

  async writeText(text, options = {}) {
    return this.run(options, async (operation) => {
      this.ensure(operation)
      const selection = options.selection ?? "clipboard"
      if (selection === "primary" && !this.primarySupported) return { status: "unsupported" }
      if (this.sources.size >= 4) return { status: "failed", error: failure("WAYLAND_FAILED", "Wayland clipboard provider limit exceeded") }
      const provider = { kind: "source", bytes: Buffer.from(text), transfers: new Set(), cancelled: false, selection }
      provider.id = this.object(provider)
      this.sources.add(provider)
      try {
        this.request(this.manager, 0, [provider.id])
        this.request(provider.id, 0, ["text/plain"])
        this.request(provider.id, 0, ["text/plain;charset=utf-8"])
        this.request(this.device, selection === "primary" ? 2 : 0, [provider.id])
        const previous = this.providers[selection]
        this.providers[selection] = provider
        if (previous) this.retire(previous)
        await this.roundtrip(operation)
        this.ensure(operation)
        return { status: "written" }
      } catch (error) {
        if (this.providers[selection] !== provider) this.retire(provider)
        throw error
      }
    })
  }

  async clear(options = {}) {
    return this.run(options, async (operation) => {
      this.ensure(operation)
      const selection = options.selection ?? "clipboard"
      if (selection === "primary" && !this.primarySupported) return { status: "unsupported" }
      this.request(this.device, selection === "primary" ? 2 : 0, [0])
      const previous = this.providers[selection]
      this.providers[selection] = undefined
      if (previous) this.retire(previous)
      await this.roundtrip(operation)
      this.ensure(operation)
      return { status: "cleared" }
    })
  }

  async run(options, callback) {
    if (this.disposed) throw new Error("Wayland clipboard backend is disposed")
    const operation = this.operation(options)
    try {
      this.ensure(operation)
      return await callback(operation)
    } catch (error) {
      if (error.code === "WAYLAND_CANCELLED") return { status: "cancelled" }
      if (error.code === "WAYLAND_TIMEOUT") return { status: "timed-out" }
      if (error.code === "WAYLAND_UNSUPPORTED") return { status: "unsupported" }
      return { status: "failed", error }
    } finally { operation.dispose() }
  }

  operation(options) {
    const controller = new AbortController()
    const abort = () => controller.abort(failure("WAYLAND_CANCELLED", "Wayland clipboard operation was cancelled"))
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
    if (options.timeoutMs === 0 && !controller.signal.aborted) controller.abort(failure("WAYLAND_TIMEOUT", "Wayland clipboard operation timed out"))
    const deadline = performance.now() + (options.timeoutMs ?? 2000)
    let timeout
    const schedule = () => {
      const remaining = deadline - performance.now()
      if (remaining <= 0) return controller.abort(failure("WAYLAND_TIMEOUT", "Wayland clipboard operation timed out"))
      timeout = setTimeout(schedule, Math.min(remaining, 2147483647))
    }
    if (!controller.signal.aborted) schedule()
    const lifetime = () => controller.abort(this.error ?? failure("WAYLAND_CANCELLED", "Wayland clipboard backend was disposed"))
    this.lifetimes ??= new Set()
    this.lifetimes.add(lifetime)
    return {
      signal: controller.signal,
      error: () => controller.signal.reason,
      dispose: () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); this.lifetimes.delete(lifetime) },
    }
  }

  ensure(operation) {
    if (operation.signal.aborted) throw operation.error()
    if (this.error) throw this.error
    if (this.closed) throw failure("WAYLAND_CANCELLED", "Wayland clipboard backend was disposed")
  }

  object(value) {
    // Timed-out sync callbacks remain reserved until wl_display.delete_id.
    // A stopped compositor must not let repeated deadlines grow this map.
    if (this.objects.size >= 1024) throw failure("WAYLAND_FAILED", "Wayland clipboard object limit exceeded")
    const id = this.free.pop() ?? this.next++
    if (id >= 0xff000000) throw failure("WAYLAND_FAILED", "Wayland client object limit exceeded")
    this.objects.set(id, value)
    return id
  }

  bind(global, name, version, object) {
    const id = this.object(object)
    this.request(this.registry, 0, [global, name, version, id])
    return id
  }

  request(id, opcode, arguments_, descriptors) {
    const parts = arguments_.map((value) => {
      if (typeof value === "number") { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
      const encoded = Buffer.from(value)
      const bytes = Buffer.alloc(4 + ((encoded.length + 4) & ~3))
      bytes.writeUInt32LE(encoded.length + 1)
      encoded.copy(bytes, 4)
      return bytes
    })
    const length = 8 + parts.reduce((total, part) => total + part.length, 0)
    if (length > 65532) throw failure("WAYLAND_FAILED", "Wayland request size limit exceeded")
    const header = Buffer.alloc(8)
    header.writeUInt32LE(id)
    header.writeUInt32LE(length * 65536 + opcode, 4)
    this.io.send(Buffer.concat([header, ...parts]), descriptors)
  }

  roundtrip(operation) {
    this.ensure(operation)
    return new Promise((resolve, reject) => {
      const callback = { kind: "callback", done: false }
      const id = this.object(callback)
      const abort = () => { callback.done = true; reject(operation.error()) }
      callback.complete = () => { if (!callback.done) { callback.done = true; operation.signal.removeEventListener("abort", abort); resolve() } }
      operation.signal.addEventListener("abort", abort, { once: true })
      try { this.request(1, 0, [id]) } catch (error) { operation.signal.removeEventListener("abort", abort); callback.done = true; reject(error) }
      if (operation.signal.aborted) abort()
    })
  }

  drive() {
    this.io.flush()
    for (let count = 0; count < 16; count++) {
      const message = this.io.receive()
      if (!message) break
      this.pending = this.pending.length ? Buffer.concat([this.pending, message.bytes]) : message.bytes
      this.descriptors.push(...message.descriptors)
      if (this.pending.length > 1024 * 1024 || this.descriptors.length > 64) throw failure("WAYLAND_FAILED", "Wayland incoming buffer limit exceeded")
      this.dispatch()
    }
    this.dispatch()
    for (const transfer of [...this.active]) {
      if (transfer.kind === "read") {
        for (let count = 0; count < 4; count++) {
          let length
          try { length = this.io.read(transfer.fd, this.transferBuffer) } catch (error) { this.finishRead(transfer, undefined, error); break }
          if (length === undefined) break
          if (length === 0) { this.finishRead(transfer, { status: "read", representation: { mimeType: transfer.match.mimeType, bytes: Buffer.concat(transfer.chunks, transfer.size) } }); break }
          transfer.size += length
          if (transfer.size > transfer.maximum) { this.finishRead(transfer, { status: "limit-exceeded" }); break }
          transfer.chunks.push(Buffer.from(this.transferBuffer.subarray(0, length)))
        }
        continue
      }
      if (performance.now() - transfer.progress >= 30_000) { this.finishWrite(transfer); continue }
      try {
        const written = this.io.write(transfer.fd, transfer.provider.bytes.subarray(transfer.offset, transfer.offset + 65536))
        if (written === undefined) continue
        transfer.offset += written
        if (written > 0) transfer.progress = performance.now()
        if (written === 0 || transfer.offset === transfer.provider.bytes.length) this.finishWrite(transfer)
      } catch { this.finishWrite(transfer) }
    }
  }

  dispatch() {
    for (let count = 0; this.pending.length >= 8 && count < 128; count++) {
      const id = this.pending.readUInt32LE()
      const opcode = this.pending.readUInt16LE(4)
      const length = this.pending.readUInt16LE(6)
      if (length < 8 || length % 4) throw failure("WAYLAND_FAILED", `Invalid Wayland message size ${length} for ${id}/${opcode}`)
      if (this.pending.length < length) return
      const object = this.objects.get(id)
      if (!object) throw failure("WAYLAND_FAILED", `Unknown Wayland event object ${id}`)
      if (object.kind === "source" && opcode === 0 && this.descriptors.length === 0) return
      const payload = this.pending.subarray(8, length)
      this.pending = this.pending.subarray(length)
      this.event(id, object, opcode, payload)
    }
  }

  event(id, object, opcode, bytes) {
    let offset = 0
    const uint = () => { if (offset + 4 > bytes.length) throw failure("WAYLAND_FAILED", "Truncated Wayland event"); const value = bytes.readUInt32LE(offset); offset += 4; return value }
    const string = () => {
      const size = uint()
      if (!size || offset + ((size + 3) & ~3) > bytes.length || bytes[offset + size - 1] !== 0 || bytes.subarray(offset, offset + size - 1).includes(0)) throw failure("WAYLAND_FAILED", "Invalid Wayland event string")
      const value = bytes.toString("utf8", offset, offset + size - 1)
      offset += (size + 3) & ~3
      return value
    }
    if (object.kind === "display") {
      if (opcode === 0) { const source = uint(); const code = uint(); throw failure("WAYLAND_FAILED", `Wayland protocol error ${source}/${code}: ${string()}`) }
      if (opcode === 1) { const released = uint(); if (released >= 2 && released < 0xff000000 && this.objects.delete(released)) this.free.push(released); return }
    }
    if (object.kind === "callback" && opcode === 0) { uint(); object.complete(); return }
    if (object.kind === "registry") {
      if (opcode === 0) {
        const global = uint(); const name = string(); const version = uint()
        if (name === "ext_data_control_manager_v1" || name === "zwlr_data_control_manager_v1") this.globals.set(global, { id: global, name, version })
        if (name === "wl_seat") {
          if (this.seats.length >= 16) { this.seatsOverflowed = true; return }
          const seat = { kind: "seat", global, name: "", capabilities: 0 }
          seat.id = this.bind(global, name, Math.min(version, 2), seat)
          this.seats.push(seat)
        }
        return
      }
      if (opcode === 1) {
        const global = uint()
        if (global === this.managerGlobal || global === this.seatGlobal) throw failure("WAYLAND_FAILED", "Wayland clipboard manager or seat was removed")
        this.globals.delete(global)
        this.seats = this.seats.filter((seat) => seat.global !== global)
        return
      }
    }
    if (object.kind === "seat") {
      if (opcode === 0) { object.capabilities = uint(); return }
      if (opcode === 1) { const name = string(); if (Buffer.byteLength(name) <= 255) object.name = name; return }
    }
    if (object.kind === "device") {
      if (opcode === 0) {
        const offer = { kind: "offer", id: uint(), mimes: [], readers: 0, selection: false, destroyed: false }
        if (this.offers.size >= 8) {
          const unused = [...this.offers.values()].find((item) => !item.selection && !item.readers)
          if (unused) this.destroyOffer(unused)
          else throw failure("WAYLAND_FAILED", "Wayland clipboard offer limit exceeded")
        }
        this.objects.set(offer.id, offer)
        this.offers.set(offer.id, offer)
        return
      }
      if (opcode === 1 || opcode === 3) {
        const offered = uint()
        const selection = opcode === 3 ? "primary" : "clipboard"
        if (selection === "primary") this.primarySupported = true
        const next = offered ? this.offers.get(offered) : undefined
        if (offered && !next) throw failure("WAYLAND_FAILED", "Wayland selection references an unknown offer")
        const previous = this.selections[selection]
        this.selections[selection] = next
        if (next) next.selection = true
        if (previous && previous !== next) {
          previous.selection = Object.values(this.selections).includes(previous)
          if (!previous.selection && !previous.readers) this.destroyOffer(previous)
        }
        return
      }
      if (opcode === 2) throw failure("WAYLAND_FAILED", "Wayland data-control device finished")
    }
    if (object.kind === "offer" && opcode === 0) {
      const mime = string()
      const essence = canonicalMime(mime)
      if (object.mimes.length < 6 && Buffer.byteLength(mime) <= 255 && essence && !object.mimes.some((item) => canonicalMime(item) === essence)) object.mimes.push(mime)
      return
    }
    if (object.kind === "source") {
      if (opcode === 1) { this.retire(object); return }
      if (opcode === 0) {
        const mime = string()
        const fd = this.descriptors.shift()
        if (object.cancelled || !["text/plain", "text/plain;charset=utf-8"].includes(mime) || object.transfers.size >= (this.options.maxProviderTransfers ?? 16)) { closeSync(fd); return }
        try {
          this.io.nonblocking(fd)
          const transfer = { kind: "write", fd, offset: 0, progress: performance.now(), provider: object }
          object.transfers.add(transfer)
          this.active.add(transfer)
        } catch { closeSync(fd) }
        return
      }
    }
    throw failure("WAYLAND_FAILED", `Unexpected Wayland ${object.kind} event ${opcode}`)
  }

  finishRead(transfer, result, error) {
    if (!this.active.delete(transfer)) return
    closeSync(transfer.fd)
    transfer.operation.signal.removeEventListener("abort", transfer.abort)
    transfer.offer.readers--
    try { if (!transfer.offer.selection && !transfer.offer.readers) this.destroyOffer(transfer.offer) } catch (cleanup) { error ??= cleanup; this.fail(cleanup) }
    if (error) transfer.reject(error)
    else transfer.resolve(result)
  }

  finishWrite(transfer) {
    if (!this.active.delete(transfer)) return
    closeSync(transfer.fd)
    transfer.provider.transfers.delete(transfer)
    if (transfer.provider.cancelled && !transfer.provider.transfers.size) this.retire(transfer.provider)
  }

  retire(provider) {
    provider.cancelled = true
    if (this.providers[provider.selection] === provider) this.providers[provider.selection] = undefined
    if (provider.transfers.size || !this.sources.delete(provider)) return
    if (!this.closed) this.request(provider.id, 1, [])
    provider.bytes = Buffer.alloc(0)
  }

  destroyOffer(offer) {
    if (offer.destroyed) return
    offer.destroyed = true
    this.offers.delete(offer.id)
    if (!this.closed) this.request(offer.id, 1, [])
    // Server-allocated IDs have no wl_display.delete_id event.
    this.objects.delete(offer.id)
  }

  fail(error) {
    if (this.closed) return
    this.error = error
    this.close()
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    for (const abort of this.lifetimes ?? []) abort()
    for (const transfer of [...this.active]) {
      if (transfer.kind === "read") this.finishRead(transfer, undefined, this.error ?? failure("WAYLAND_CANCELLED", "Wayland clipboard backend was disposed"))
      else this.finishWrite(transfer)
    }
    for (const descriptor of this.descriptors) closeSync(descriptor)
    this.descriptors.length = 0
    this.io.close()
    this.io = undefined
    for (const provider of this.sources) { provider.bytes = Buffer.alloc(0); provider.transfers.clear() }
    this.providers = { clipboard: undefined, primary: undefined }
    this.selections = { clipboard: undefined, primary: undefined }
    this.transferBuffer = Buffer.alloc(0)
    this.pending = Buffer.alloc(0)
    this.objects.clear()
    this.offers.clear()
    this.sources.clear()
    this.globals.clear()
    this.seats.length = 0
    this.free.length = 0
  }

  dispose() {
    if (this.disposed) return this.disposing
    this.disposed = true
    this.close()
    return this.disposing = Promise.resolve()
  }
}

function canonicalMime(value) {
  const parts = value.split(";")
  const essence = trimAscii(parts.shift()).toLowerCase()
  if (!["text/plain", "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].includes(essence)) return undefined
  for (const parameter of parts) {
    const separator = parameter.indexOf("=")
    if (separator < 0 || essence !== "text/plain") continue
    if (trimAscii(parameter.slice(0, separator)).toLowerCase() !== "charset") continue
    const charset = trimAscii(trimAscii(parameter.slice(separator + 1)).replace(/^"(.*)"$/, "$1")).toLowerCase()
    if (charset !== "utf-8") return undefined
  }
  return essence
}

function trimAscii(value) { return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") }
