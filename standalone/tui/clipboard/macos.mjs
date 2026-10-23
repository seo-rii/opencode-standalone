/** NSPasteboard and ImageIO run in the embedded worker, keeping native waits off the TUI thread. */
export async function createMacOSClipboard(options = {}) {
  if (process.platform !== "darwin" || !["x64", "arm64"].includes(process.arch)) {
    throw Object.assign(new Error("The macOS clipboard requires macOS x64 or arm64"), { code: "MACOS_UNSUPPORTED" })
  }
  const { default: source } = await import("opencode:clipboard-macos-worker")
  const { createNativeClipboardWorker } = await import("./native-worker.mjs")
  return createNativeClipboardWorker(source, {
    maxImagePixels: options.maxImagePixels ?? 64 * 1024 * 1024,
    maxConversionBytes: options.maxConversionBytes ?? 512 * 1024 * 1024,
    maxReadBytes: options.maxReadBytes,
    timeoutMs: options.timeoutMs,
    maxConcurrentOperations: options.maxConcurrentOperations,
    signal: options.signal,
  })
}
