import { createRequire } from "node:module"

let native

/** These are host operations; they must not act on the reactor's WASI stdin. */
export const hostMethods = {
  terminalFlushInput(fd = 0) {
    if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) throw new RangeError("Terminal input descriptor must be a nonnegative i32")
    if (process.platform !== "linux") throw new Error(`Standalone terminal input flushing is not implemented for ${process.platform}`)
    if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`Standalone terminal input flushing is not implemented for ${process.arch}`)
    if (!native) {
      const ffi = createRequire(import.meta.url)("node:ffi")
      native = ffi.dlopen(null, { tcflush: { arguments: ["i32", "i32"], return: "i32" } })
    }
    // Linux TCIFLUSH is zero. Match upstream's best-effort syscall: ENOTTY,
    // a closing descriptor, and other errors never prevent terminal restoration.
    native.functions.tcflush(fd, 0)
  },
}
