import assert from "node:assert/strict"
import ffi from "node:ffi"
import { join } from "node:path"
import source from "opencode:clipboard-windows-worker"
import { createNativeClipboardWorker } from "./native-worker.mjs"

if (process.platform !== "win32") throw new Error("This proof requires the actual Windows operating system")
const directory = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32")
const kernel32Path = join(directory, "kernel32.dll")
const user32Path = join(directory, "user32.dll")
const kernel = ffi.dlopen(kernel32Path, {
  GetCurrentThreadId: { arguments: [], return: "u32" },
  GetLastError: { arguments: [], return: "u32" },
  GlobalAlloc: { arguments: ["u32", "u64"], return: "pointer" },
  GlobalLock: { arguments: ["pointer"], return: "pointer" },
  GlobalUnlock: { arguments: ["pointer"], return: "i32" },
  GlobalFree: { arguments: ["pointer"], return: "pointer" },
  GlobalSize: { arguments: ["pointer"], return: "u64" },
})
const gui = ffi.dlopen(user32Path, {
  GetProcessWindowStation: { arguments: [], return: "pointer" },
  CreateWindowStationW: { arguments: ["pointer", "u32", "u32", "pointer"], return: "pointer" },
  SetProcessWindowStation: { arguments: ["pointer"], return: "i32" },
  CloseWindowStation: { arguments: ["pointer"], return: "i32" },
  GetThreadDesktop: { arguments: ["u32"], return: "pointer" },
  CreateDesktopW: { arguments: ["pointer", "pointer", "pointer", "u32", "u32", "pointer"], return: "pointer" },
  SetThreadDesktop: { arguments: ["pointer"], return: "i32" },
  CloseDesktop: { arguments: ["pointer"], return: "i32" },
  OpenClipboard: { arguments: ["pointer"], return: "i32" },
  CloseClipboard: { arguments: [], return: "i32" },
  EmptyClipboard: { arguments: [], return: "i32" },
  SetClipboardData: { arguments: ["u32", "pointer"], return: "pointer" },
  GetClipboardData: { arguments: ["u32"], return: "pointer" },
  RegisterClipboardFormatW: { arguments: ["pointer"], return: "u32" },
  CreateWindowExW: { arguments: ["u32", "pointer", "pointer", "u32", "i32", "i32", "i32", "i32", "pointer", "pointer", "pointer", "pointer"], return: "pointer" },
  DestroyWindow: { arguments: ["pointer"], return: "i32" },
})
const originalStation = checked(gui.functions.GetProcessWindowStation(), "get original window station")
const originalDesktop = checked(gui.functions.GetThreadDesktop(kernel.functions.GetCurrentThreadId()), "get original desktop")
// CREATE_ONLY prevents accidentally using an existing station's clipboard.
const station = checked(gui.functions.CreateWindowStationW(0n, 1, 0x000f037f, 0n), "create private window station")
let desktop = 0n
let owner = 0n
let clipboard
try {
  checked(gui.functions.SetProcessWindowStation(station), "select private window station")
  desktop = checked(gui.functions.CreateDesktopW(Buffer.from("Default\0", "utf16le"), 0n, 0n, 0, 0x000f01ff, 0n), "create private desktop")
  checked(gui.functions.SetThreadDesktop(desktop), "select private desktop")
  owner = checked(gui.functions.CreateWindowExW(0, Buffer.from("STATIC\0", "utf16le"), Buffer.from("OpenTUI Native Clipboard Proof\0", "utf16le"), 0, 0, 0, 0, 0, 0n, 0n, 0n, 0n), "create independent owner")
  const setup = `(function(){const ffi=require('node:ffi');const gui=ffi.dlopen(${JSON.stringify(user32Path)},{SetThreadDesktop:{arguments:['pointer'],return:'i32'}});if(!gui.functions.SetThreadDesktop(${desktop}n))throw new Error('Cannot select private proof desktop');gui.lib.close()})();\n`
  clipboard = await createNativeClipboardWorker(setup + source, { user32Path, kernel32Path })
  assert.equal((await clipboard.clear()).status, "cleared")
  const text = "Windows 실제 API 한국어 😀\na\r\nb\rc"
  assert.equal((await clipboard.writeText(text)).status, "written")
  assert.equal(readNative(13).toString("utf16le").split("\0")[0], "Windows 실제 API 한국어 😀\r\na\r\nb\r\nc")
  const copied = await clipboard.read({ preferredTypes: ["text/plain"] })
  assert.equal(copied.status, "read")
  assert.equal(Buffer.from(copied.representation.bytes).toString(), "Windows 실제 API 한국어 😀\r\na\r\nb\r\nc")
  assert.equal((await clipboard.read({ selection: "primary" })).status, "unsupported")
  assert.equal((await clipboard.read({ preferredTypes: ["text/plain"], maxBytes: 1 })).status, "limit-exceeded")
  const pngFormat = checked(gui.functions.RegisterClipboardFormatW(Buffer.from("PNG\0", "utf16le")), "register PNG")
  const png = Buffer.from("89504e470d0a1a0a00fe12345678", "hex")
  publish(pngFormat, png)
  const image = await clipboard.read({ preferredTypes: ["image/png"] })
  assert.equal(image.status, "read")
  // GlobalSize may include allocator padding, as in the upstream provider.
  assert.deepEqual(Buffer.from(image.representation.bytes).subarray(0, png.length), png)
  const dib = Buffer.alloc(44)
  dib.writeUInt32LE(40)
  dib.writeInt32LE(1, 4)
  dib.writeInt32LE(1, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(24, 14)
  dib.set([0x33, 0x22, 0x11, 0], 40)
  publish(8, dib)
  const converted = await clipboard.read({ preferredTypes: ["image/png"] })
  assert.equal(converted.status, "read")
  assert.deepEqual(Buffer.from(converted.representation.bytes).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"))
  assert.equal((await clipboard.clear()).status, "cleared")
  assert.equal((await clipboard.read({ preferredTypes: ["text/plain", "image/png"] })).status, "empty")
} finally {
  await clipboard?.dispose()
  if (owner) checked(gui.functions.DestroyWindow(owner), "destroy proof owner")
  checked(gui.functions.SetProcessWindowStation(originalStation), "restore original station")
  checked(gui.functions.SetThreadDesktop(originalDesktop), "restore original desktop")
  if (desktop) checked(gui.functions.CloseDesktop(desktop), "close private desktop")
  checked(gui.functions.CloseWindowStation(station), "close private station")
  gui.lib.close()
  kernel.lib.close()
}
console.log(JSON.stringify({ platform: "win32", actualWindows: true, privateWindowStation: true }))

function checked(result, operation) {
  if (!result) throw new Error(`${operation}: Win32 ${kernel.functions.GetLastError()}`)
  return result
}
function readNative(format) {
  checked(gui.functions.OpenClipboard(owner), "open independent clipboard reader")
  try {
    const memory = checked(gui.functions.GetClipboardData(format), "get independent clipboard data")
    const pointer = checked(kernel.functions.GlobalLock(memory), "lock independent clipboard data")
    try { return ffi.toBuffer(pointer, Number(kernel.functions.GlobalSize(memory)), true) }
    finally { kernel.functions.GlobalUnlock(memory) }
  } finally { gui.functions.CloseClipboard() }
}
function publish(format, bytes) {
  let memory = checked(kernel.functions.GlobalAlloc(2, BigInt(bytes.length)), "allocate independent clipboard bytes")
  try {
    const pointer = checked(kernel.functions.GlobalLock(memory), "lock independent clipboard bytes")
    try { ffi.exportBuffer(bytes, pointer, bytes.length) }
    finally { kernel.functions.GlobalUnlock(memory) }
    checked(gui.functions.OpenClipboard(owner), "open independent clipboard writer")
    try {
      checked(gui.functions.EmptyClipboard(), "empty independent clipboard")
      checked(gui.functions.SetClipboardData(format, memory), "publish independent clipboard bytes")
      memory = 0n
    } finally { gui.functions.CloseClipboard() }
  } finally { if (memory) kernel.functions.GlobalFree(memory) }
}
