import { join } from "node:path"
import { createNativeClipboardWorker } from "./native-worker.mjs"

/** Win32 owns the Unicode text/PNG clipboard; native calls stay off the TUI thread. */
export async function createWindowsClipboard(options = {}) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    throw Object.assign(new Error("Windows clipboard requires Windows x64 or arm64"), { code: "WINDOWS_UNSUPPORTED" })
  }
  const { default: source } = await import("opencode:clipboard-windows-worker")
  const systemDirectory = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32")
  return createNativeClipboardWorker(source, {
    ...options,
    user32Path: join(systemDirectory, "user32.dll"),
    kernel32Path: join(systemDirectory, "kernel32.dll"),
  })
}
