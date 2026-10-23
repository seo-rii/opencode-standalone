import ffi from "node:ffi"
import { clearInterval, setInterval } from "node:timers"
import { setTimeout } from "node:timers/promises"
import { convertDibToPng } from "./image.mjs"

const textFormat = 13
const dibFormats = [17, 8]

/** The same Win64 declarations are used by the OS worker and the native ABI fixture. */
export async function createWindowsNativeClipboard(configuration = {}) {
  if (!["x64", "arm64"].includes(process.arch)) throw Object.assign(new Error("Unsupported Windows pointer ABI"), { code: "WINDOWS_UNSUPPORTED" })
  const kernel32 = ffi.dlopen(configuration.kernel32Path, {
    GetLastError: { arguments: [], return: "u32" },
    GlobalAlloc: { arguments: ["u32", "u64"], return: "pointer" },
    GlobalFree: { arguments: ["pointer"], return: "pointer" },
    GlobalLock: { arguments: ["pointer"], return: "pointer" },
    GlobalSize: { arguments: ["pointer"], return: "u64" },
    GlobalUnlock: { arguments: ["pointer"], return: "i32" },
  })
  let user32
  let window = 0n
  let pumpTimer
  try {
    user32 = ffi.dlopen(configuration.user32Path, {
      OpenClipboard: { arguments: ["pointer"], return: "i32" },
      CloseClipboard: { arguments: [], return: "i32" },
      EmptyClipboard: { arguments: [], return: "i32" },
      GetClipboardData: { arguments: ["u32"], return: "pointer" },
      IsClipboardFormatAvailable: { arguments: ["u32"], return: "i32" },
      RegisterClipboardFormatW: { arguments: ["pointer"], return: "u32" },
      SetClipboardData: { arguments: ["u32", "pointer"], return: "pointer" },
      PeekMessageW: { arguments: ["pointer", "pointer", "u32", "u32", "u32"], return: "i32" },
      TranslateMessage: { arguments: ["pointer"], return: "i32" },
      DispatchMessageW: { arguments: ["pointer"], return: "i64" },
      CreateWindowExW: {
        arguments: ["u32", "pointer", "pointer", "u32", "i32", "i32", "i32", "i32", "pointer", "pointer", "pointer", "pointer"],
        return: "pointer",
      },
      DestroyWindow: { arguments: ["pointer"], return: "i32" },
    })
    const pngFormat = user32.functions.RegisterClipboardFormatW(Buffer.from("PNG\0", "utf16le"))
    if (!pngFormat) throw nativeError("register PNG clipboard format")
    window = user32.functions.CreateWindowExW(0, Buffer.from("STATIC\0", "utf16le"), Buffer.from("OpenTUI Clipboard\0", "utf16le"), 0, 0, 0, 0, 0, 0n, 0n, 0n, 0n)
    if (!window) throw nativeError("create clipboard owner window")
    const message = Buffer.alloc(48)
    let disposed = false
    pumpTimer = setInterval(pumpMessages, 10)
    pumpTimer.unref()
    return {
      read(operation = {}) { return execute("read", undefined, operation) },
      writeText(text, operation = {}) { return execute("writeText", text, operation) },
      clear(operation = {}) { return execute("clear", undefined, operation) },
      dispose() {
        if (disposed) return
        disposed = true
        clearInterval(pumpTimer)
        const destroyed = user32.functions.DestroyWindow(window)
        const failure = destroyed ? undefined : nativeError("destroy clipboard owner window")
        window = 0n
        user32.lib.close()
        kernel32.lib.close()
        if (failure) throw failure
      },
    }

    function pumpMessages() {
      for (let count = 0; count < 64 && user32.functions.PeekMessageW(message, 0n, 0, 0, 1); count++) {
        user32.functions.TranslateMessage(message)
        user32.functions.DispatchMessageW(message)
      }
    }

    async function execute(kind, text, request) {
      if (disposed) throw new Error("Windows clipboard is disposed")
      const operation = {
        ...request,
        deadline: request.deadline ?? performance.now() + (request.timeoutMs ?? configuration.timeoutMs ?? 1000),
        maxBytes: request.maxBytes ?? configuration.maxReadBytes ?? 8 * 1024 * 1024,
      }
      const stopped = checkStop(operation)
      if (stopped) return stopped
      if (operation.selection === "primary") return { status: "unsupported" }
      if (kind === "read" && !(operation.preferredTypes ?? ["text/plain"]).some((mime) => mime === "text/plain" || mime === "image/png")) return { status: "unsupported" }
      let memory = 0n
      let open = false
      try {
        if (kind === "writeText") {
          // CF_UNICODETEXT stores CRLF and a terminating UTF-16 NUL.
          if (text.includes("\0") || !text.isWellFormed()) return invalidData()
          const bytes = Buffer.from(text.replace(/\r\n|\r|\n/g, "\r\n") + "\0", "utf16le")
          const status = checkStop(operation)
          if (status) return status
          memory = kernel32.functions.GlobalAlloc(2, BigInt(bytes.length))
          if (!memory) return outOfMemory()
          const pointer = kernel32.functions.GlobalLock(memory)
          if (!pointer) return outOfMemory()
          try {
            for (let offset = 0; offset < bytes.length; offset += 4096) {
              const status = checkStop(operation)
              if (status) return status
              const chunk = bytes.subarray(offset, offset + 4096)
              ffi.exportBuffer(chunk, pointer + BigInt(offset), chunk.length)
            }
          } finally { kernel32.functions.GlobalUnlock(memory) }
        }
        const ready = await ensureOpen()
        if (ready) return ready
        const stopped = checkStop(operation)
        if (stopped) return stopped
        if (kind !== "read") {
          const denied = operation.beginMutation?.()
          if (denied === false) return checkStop(operation) ?? { status: "cancelled" }
          if (denied && typeof denied === "object") return denied
          if (!user32.functions.EmptyClipboard()) return failed("empty clipboard")
          if (kind === "clear") return { status: "cleared" }
          if (!user32.functions.SetClipboardData(textFormat, memory)) return failed("publish Unicode clipboard text")
          // Only a successful SetClipboardData transfers HGLOBAL ownership.
          memory = 0n
          return { status: "written" }
        }
        let firstFailure
        for (const mimeType of operation.preferredTypes ?? ["text/plain"]) {
          const stopped = checkStop(operation)
          if (stopped) return stopped
          if (mimeType !== "text/plain" && mimeType !== "image/png") continue
          const ready = await ensureOpen()
          if (ready) return ready
          const candidate = mimeType === "text/plain" ? readText() : await readImage()
          if (["empty", "unsupported"].includes(candidate.status)) continue
          if (candidate.status === "failed" && candidate.error.win32Code !== 14) { firstFailure ??= candidate; continue }
          return candidate
        }
        return firstFailure ?? { status: "empty" }
      } catch (error) {
        const stopped = checkStop(operation)
        if (stopped) return stopped
        if (error instanceof RangeError) return outOfMemory()
        return { status: "failed", error: error instanceof Error ? error : new Error(String(error)) }
      } finally {
        closeClipboard()
        if (memory) kernel32.functions.GlobalFree(memory)
        pumpMessages()
      }

      async function ensureOpen() {
        while (!open) {
          const stopped = checkStop(operation)
          if (stopped) return stopped
          if (user32.functions.OpenClipboard(window)) { open = true; break }
          pumpMessages()
          const stoppedAfterPump = checkStop(operation)
          if (stoppedAfterPump) return stoppedAfterPump
          await setTimeout(Math.min(5, Math.max(1, operation.deadline - performance.now())))
        }
      }

      function closeClipboard() {
        if (!open) return
        open = false
        user32.functions.CloseClipboard()
      }

      function readText() {
        if (!user32.functions.IsClipboardFormatAvailable(textFormat)) return { status: "empty" }
        const memory = user32.functions.GetClipboardData(textFormat)
        if (!memory) return failed("retrieve Unicode clipboard text")
        const size = kernel32.functions.GlobalSize(memory)
        if (size < 2n || size % 2n) return invalidData()
        const pointer = kernel32.functions.GlobalLock(memory)
        if (!pointer) return failed("lock Unicode clipboard text")
        try {
          // At least one output UTF-8 byte is needed per non-NUL UTF-16 unit.
          const units = Number(size / 2n > BigInt(operation.maxBytes + 1) ? BigInt(operation.maxBytes + 1) : size / 2n)
          const source = ffi.toBuffer(pointer, units * 2, false)
          let end = -1
          for (let index = 0; index < units; index++) {
            if (index % 4096 === 0) { const stopped = checkStop(operation); if (stopped) return stopped }
            if (source.readUInt16LE(index * 2) === 0) { end = index * 2; break }
          }
          if (end === -1) return size / 2n > BigInt(operation.maxBytes) ? { status: "limit-exceeded" } : invalidData()
          let bytes = 0
          for (let index = 0; index < end / 2; index++) {
            if (index % 4096 === 0) { const stopped = checkStop(operation); if (stopped) return stopped }
            const unit = source.readUInt16LE(index * 2)
            if (unit >= 0xd800 && unit <= 0xdbff) {
              if (++index >= end / 2) return invalidData()
              const low = source.readUInt16LE(index * 2)
              if (low < 0xdc00 || low > 0xdfff) return invalidData()
              bytes += 4
            } else {
              if (unit >= 0xdc00 && unit <= 0xdfff) return invalidData()
              bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3
            }
            if (bytes > operation.maxBytes) return { status: "limit-exceeded" }
          }
          const data = Buffer.from(source.subarray(0, end).toString("utf16le"))
          return checkStop(operation) ?? { status: "read", representation: { mimeType: "text/plain", bytes: data } }
        } finally { kernel32.functions.GlobalUnlock(memory) }
      }

      async function readImage() {
        let firstFailure
        for (const format of [pngFormat, ...dibFormats]) {
          const stopped = checkStop(operation)
          if (stopped) return stopped
          const ready = await ensureOpen()
          if (ready) return ready
          if (!user32.functions.IsClipboardFormatAvailable(format)) continue
          const candidate = copyData(format, format === pngFormat ? operation.maxBytes : configuration.maxConversionBytes ?? 512 * 1024 * 1024)
          if (candidate.status !== "read") {
            if (candidate.status === "empty") continue
            if (candidate.status === "failed" && candidate.error.win32Code !== 14) { firstFailure ??= candidate; continue }
            return candidate
          }
          if (format === pngFormat) return candidate
          // A large conversion must not keep the desktop clipboard locked.
          closeClipboard()
          try {
            const bytes = await convertDibToPng(candidate.representation.bytes, {
              maxBytes: operation.maxBytes,
              maxImagePixels: configuration.maxImagePixels ?? 64 * 1024 * 1024,
              maxConversionBytes: configuration.maxConversionBytes ?? 512 * 1024 * 1024,
              signal: operation.signal,
              deadline: operation.deadline,
            })
            return checkStop(operation) ?? { status: "read", representation: { mimeType: "image/png", bytes } }
          } catch (error) {
            if (error.code === "Unsupported") continue
            if (error.code === "LimitExceeded") return { status: "limit-exceeded" }
            if (error.code === "Cancelled") return { status: "cancelled" }
            if (error.code === "TimedOut") return { status: "timed-out" }
            if (error.code === "OutOfMemory") return outOfMemory()
            firstFailure ??= invalidData()
          }
        }
        return firstFailure ?? { status: "empty" }
      }

      function copyData(format, maximum) {
        const memory = user32.functions.GetClipboardData(format)
        if (!memory) return failed("retrieve clipboard image")
        const size = kernel32.functions.GlobalSize(memory)
        if (!size) return { status: "empty" }
        if (size > BigInt(maximum)) return { status: "limit-exceeded" }
        const pointer = kernel32.functions.GlobalLock(memory)
        if (!pointer) return failed("lock clipboard image")
        try {
          const bytes = Buffer.allocUnsafe(Number(size))
          for (let offset = 0; offset < bytes.length; offset += 4096) {
            const stopped = checkStop(operation)
            if (stopped) return stopped
            ffi.toBuffer(pointer + BigInt(offset), Math.min(4096, bytes.length - offset), false).copy(bytes, offset)
          }
          return checkStop(operation) ?? { status: "read", representation: { mimeType: "image/png", bytes } }
        } finally { kernel32.functions.GlobalUnlock(memory) }
      }
    }
  } catch (error) {
    if (pumpTimer) clearInterval(pumpTimer)
    if (window) user32.functions.DestroyWindow(window)
    user32?.lib.close()
    kernel32.lib.close()
    throw error
  }

  function nativeError(operation, win32Code = kernel32.functions.GetLastError()) {
    return Object.assign(new Error(`Windows clipboard: ${operation} (Win32 ${win32Code})`), { code: "WINDOWS_FAILED", win32Code })
  }
  function failed(operation) { return { status: "failed", error: nativeError(operation) } }
  function invalidData() { return { status: "failed", error: nativeError("invalid clipboard data", 13) } }
  function outOfMemory() { return { status: "failed", error: nativeError("allocate clipboard memory", 14) } }
}

function checkStop(operation) {
  if (operation.signal?.aborted) return { status: "cancelled" }
  if (performance.now() >= operation.deadline) return { status: "timed-out" }
}
