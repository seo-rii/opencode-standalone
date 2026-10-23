import { closeSync } from "node:fs"
import { createRequire } from "node:module"
import { isAbsolute, join } from "node:path"
import { getSystemErrorName } from "node:util"

let binding

/** Linux's Unix socket / SCM_RIGHTS ABI, using only the runtime's libc symbols. */
export function waylandIO(environment = process.env) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw failure("WAYLAND_UNSUPPORTED", "Wayland clipboard requires Linux x64 or arm64")
  const inherited = environment.WAYLAND_SOCKET
  const display = environment.WAYLAND_DISPLAY
  if (!inherited && !display) throw failure("WAYLAND_UNSUPPORTED", "No Wayland display is configured")
  if (!binding) {
    const ffi = createRequire(import.meta.url)("node:ffi")
    const library = ffi.dlopen(null, {
      socket: { arguments: ["i32", "i32", "i32"], return: "i32" },
      connect: { arguments: ["i32", "pointer", "u32"], return: "i32" },
      fcntl: { arguments: ["i32", "i32", "i32"], return: "i32" },
      sendmsg: { arguments: ["i32", "pointer", "i32"], return: "i64" },
      recvmsg: { arguments: ["i32", "pointer", "i32"], return: "i64" },
      pipe2: { arguments: ["pointer", "i32"], return: "i32" },
      read: { arguments: ["i32", "pointer", "u64"], return: "i64" },
      write: { arguments: ["i32", "pointer", "u64"], return: "i64" },
      __errno_location: { arguments: [], return: "pointer" },
    })
    binding = { ffi, library, functions: library.functions, errno: () => ffi.getInt32(library.functions.__errno_location()) }
  }
  const native = binding
  const descriptor = (() => {
    if (inherited) {
      if (!/^\d+$/.test(inherited) || Number(inherited) > 0x7fffffff) throw failure("WAYLAND_FAILED", "Invalid WAYLAND_SOCKET descriptor")
      const fd = Number(inherited)
      const flags = native.functions.fcntl(fd, 1, 0)
      if (flags < 0) throw syscall("inspect inherited Wayland socket")
      if (native.functions.fcntl(fd, 2, flags | 1) < 0) { const error = syscall("protect inherited Wayland socket"); closeSync(fd); throw error }
      // WAYLAND_SOCKET transfers ownership, as wl_display_connect does. A
      // retained duplicate would keep selections alive after backend disposal.
      if (environment === process.env) delete process.env.WAYLAND_SOCKET
      return fd
    }
    const filename = isAbsolute(display) ? display : environment.XDG_RUNTIME_DIR ? join(environment.XDG_RUNTIME_DIR, display) : undefined
    if (!filename) throw failure("WAYLAND_UNSUPPORTED", "A relative WAYLAND_DISPLAY requires XDG_RUNTIME_DIR")
    const pathname = Buffer.from(filename)
    if (pathname.length > 107 || pathname.includes(0)) throw failure("WAYLAND_FAILED", "Wayland socket path is invalid")
    const fd = native.functions.socket(1, 1 | 0x800 | 0x80000, 0)
    if (fd < 0) throw syscall("create Wayland socket")
    const address = Buffer.alloc(110)
    address.writeUInt16LE(1)
    pathname.copy(address, 2)
    const connected = native.functions.connect(fd, address, pathname.length + 3)
    if (connected < 0 && ![115, 11].includes(native.errno())) {
      const error = syscall("connect Wayland socket")
      closeSync(fd)
      throw error
    }
    return fd
  })()
  let closed = false
  const outgoing = []
  const receiveBytes = Buffer.alloc(65536)
  const receiveControl = Buffer.alloc(272)
  const receiveVector = Buffer.alloc(16)
  const receiveMessage = Buffer.alloc(56)
  receiveVector.writeBigUInt64LE(native.ffi.getRawPointer(receiveBytes), 0)
  receiveVector.writeBigUInt64LE(BigInt(receiveBytes.length), 8)
  receiveMessage.writeBigUInt64LE(native.ffi.getRawPointer(receiveVector), 16)
  receiveMessage.writeBigUInt64LE(1n, 24)
  receiveMessage.writeBigUInt64LE(native.ffi.getRawPointer(receiveControl), 32)
  const flags = native.functions.fcntl(descriptor, 3, 0)
  if (flags < 0 || native.functions.fcntl(descriptor, 4, flags | 0x800) < 0) {
    const error = syscall("set Wayland socket nonblocking")
    closeSync(descriptor)
    throw error
  }
  return {
    descriptor,
    send(bytes, fds = []) {
      if (closed) throw failure("WAYLAND_FAILED", "Wayland connection is closed")
      const copies = []
      let queued = false
      try {
        for (const fd of fds) {
          const copy = native.functions.fcntl(fd, 1030, 0)
          if (copy < 0) throw syscall("duplicate transfer descriptor")
          copies.push(copy)
        }
        if (outgoing.reduce((total, item) => total + item.bytes.length - item.offset, bytes.length) > 1024 * 1024) throw failure("WAYLAND_FAILED", "Wayland outgoing buffer limit exceeded")
        outgoing.push({ bytes, offset: 0, fds: copies })
        queued = true
        this.flush()
      } catch (error) {
        if (!queued) for (const copy of copies) closeSync(copy)
        throw error
      }
    },
    flush() {
      if (closed) return
      for (let count = 0; outgoing.length && count < 64; count++) {
        const item = outgoing[0]
        const bytes = item.bytes.subarray(item.offset)
        const vector = Buffer.alloc(16)
        vector.writeBigUInt64LE(native.ffi.getRawPointer(bytes))
        vector.writeBigUInt64LE(BigInt(bytes.length), 8)
        const message = Buffer.alloc(56)
        message.writeBigUInt64LE(native.ffi.getRawPointer(vector), 16)
        message.writeBigUInt64LE(1n, 24)
        const control = item.fds.length ? Buffer.alloc((16 + item.fds.length * 4 + 7) & ~7) : undefined
        if (control) {
          control.writeBigUInt64LE(BigInt(16 + item.fds.length * 4))
          control.writeInt32LE(1, 8)
          control.writeInt32LE(1, 12)
          item.fds.forEach((fd, index) => control.writeInt32LE(fd, 16 + index * 4))
          message.writeBigUInt64LE(native.ffi.getRawPointer(control), 32)
          message.writeBigUInt64LE(BigInt(control.length), 40)
        }
        // Embedded native pointers do not keep their JS owners alive.
        this.retained = [bytes, vector, message, control]
        const written = Number(native.functions.sendmsg(descriptor, message, 0x4000 | 0x40))
        this.retained = undefined
        if (written < 0) {
          if ([11, 4].includes(native.errno())) return
          throw syscall("send Wayland message")
        }
        if (written === 0) throw failure("WAYLAND_FAILED", "Wayland send made no progress")
        item.offset += written
        for (const fd of item.fds) closeSync(fd)
        item.fds = []
        if (item.offset === item.bytes.length) outgoing.shift()
      }
    },
    receive() {
      if (closed) return undefined
      // Refer to the iovec on every call so its backing store stays rooted.
      receiveMessage.writeBigUInt64LE(native.ffi.getRawPointer(receiveVector), 16)
      receiveMessage.writeBigUInt64LE(BigInt(receiveControl.length), 40)
      receiveMessage.writeInt32LE(0, 48)
      const received = Number(native.functions.recvmsg(descriptor, receiveMessage, 0x40000000 | 0x40))
      if (received < 0) {
        if ([11, 4].includes(native.errno())) return undefined
        throw syscall("receive Wayland message")
      }
      if (received === 0) throw failure("WAYLAND_FAILED", "Wayland compositor disconnected")
      const descriptors = []
      const length = Number(receiveMessage.readBigUInt64LE(40))
      try {
        for (let offset = 0; offset + 16 <= length;) {
          const size = Number(receiveControl.readBigUInt64LE(offset))
          if (size < 16 || offset + size > length) throw failure("WAYLAND_FAILED", "Invalid Wayland ancillary data")
          if (receiveControl.readInt32LE(offset + 8) === 1 && receiveControl.readInt32LE(offset + 12) === 1) {
            for (let index = offset + 16; index + 4 <= offset + size; index += 4) descriptors.push(receiveControl.readInt32LE(index))
          }
          offset += (size + 7) & ~7
        }
        if (receiveMessage.readInt32LE(48) & 8) throw failure("WAYLAND_FAILED", "Wayland ancillary descriptor limit exceeded")
        return { bytes: Buffer.from(receiveBytes.subarray(0, received)), descriptors }
      } catch (error) {
        for (const fd of descriptors) closeSync(fd)
        throw error
      }
    },
    pipe() {
      const descriptors = Buffer.alloc(8)
      if (native.functions.pipe2(descriptors, 0x80000) < 0) throw syscall("create clipboard transfer pipe")
      const pair = [descriptors.readInt32LE(), descriptors.readInt32LE(4)]
      try { this.nonblocking(pair[0]); return pair } catch (error) { pair.forEach(closeSync); throw error }
    },
    read(fd, bytes) {
      const count = Number(native.functions.read(fd, bytes, BigInt(bytes.length)))
      if (count >= 0) return count
      if ([11, 4].includes(native.errno())) return undefined
      throw syscall("read clipboard transfer")
    },
    write(fd, bytes) {
      const count = Number(native.functions.write(fd, bytes, BigInt(bytes.length)))
      if (count >= 0) return count
      if ([11, 4].includes(native.errno())) return undefined
      throw syscall("write clipboard transfer")
    },
    nonblocking(fd) {
      const current = native.functions.fcntl(fd, 3, 0)
      if (current < 0 || native.functions.fcntl(fd, 4, current | 0x800) < 0) throw syscall("set transfer descriptor nonblocking")
    },
    close() {
      if (closed) return
      closed = true
      closeSync(descriptor)
      for (const item of outgoing) for (const fd of item.fds) closeSync(fd)
      outgoing.length = 0
    },
  }
  function syscall(operation) {
    const errno = native.errno()
    const detail = getSystemErrorName(-errno)
    return failure("WAYLAND_FAILED", `${operation}: ${detail}`)
  }
}

export function failure(code, message) { return Object.assign(new Error(message), { code }) }
