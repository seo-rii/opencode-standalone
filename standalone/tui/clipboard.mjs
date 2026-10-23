import { basename } from "node:path"
import { release } from "node:os"

/** Keep the published clipboard policy and validation around the standalone providers. */
export function adaptPublishedClipboardSource(filename, source) {
  if (basename(filename) !== "chunk-node-2rg7pskw.js") return source
  const before = "var createNativeHostClipboardBackend = (options) => new NativeClipboardBackend(options.maxImagePixels, options.maxConversionBytes, options.maxConcurrentOperations, options.maxProviderTransfers, options.waylandSeat);"
  if (source.split(before).length !== 2) throw new Error("Pinned OpenTUI clipboard factory seam did not match exactly once")
  return 'import { createStandaloneHostClipboardBackend } from "opencode:tui-clipboard";\n' + source.replace(before, "var createNativeHostClipboardBackend = (options) => createStandaloneHostClipboardBackend(options);")
}

/** X11/Wayland own the actual desktop selections; headless callers retain OSC 52. */
export function createStandaloneHostClipboardBackend(options = {}) {
  const mechanisms = process.platform !== "linux" ? [] : [
    ...(process.env.WAYLAND_DISPLAY || process.env.WAYLAND_SOCKET ? ["wayland"] : []),
    ...(process.env.DISPLAY ? ["x11"] : []),
  ]
  const wsl = process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined || /microsoft|wsl/i.test(release())
  const providers = new Map()
  const active = new Set()
  const mutations = new Map()
  let disposed = false
  let disposePromise

  function provider(mechanism, signal) {
    let entry = providers.get(mechanism)
    if (!entry) {
      const controller = new AbortController()
      entry = { controller, promise: openProvider(mechanism, { ...options, signal: controller.signal }) }
      providers.set(mechanism, entry)
    }
    // A cancelled caller must not tear down initialization used by other callers.
    return waitForSignal(entry.promise, signal)
  }

  async function dispatch(kind, text, operation) {
    if (!mechanisms.length || wsl && (operation.selection === "primary" || kind === "clear")) return { status: "unsupported" }
    if (kind === "read" && !operation.preferredTypes.some((mime) => nativeReadTypes.has(mime))) return { status: "unsupported" }
    for (const mechanism of mechanisms) {
      if (operation.signal.aborted) return { status: "cancelled" }
      try {
        const service = await provider(mechanism, operation.signal)
        if (operation.signal.aborted) return { status: "cancelled" }
        const result = kind === "writeText" ? await service.writeText(text, operation) : await service[kind](operation)
        if (result.status !== "unsupported") return result
      } catch (error) {
        if (operation.signal.aborted) return { status: "cancelled" }
        const failure = error instanceof Error ? error : new Error(String(error))
        if (String(failure.code).endsWith("_UNSUPPORTED")) continue
        if (String(failure.code).endsWith("_TIMEOUT")) return { status: "timed-out" }
        return { status: "failed", error: failure }
      }
    }
    return { status: "unsupported" }
  }

  async function run(kind, text, request) {
    if (disposed) throw new Error("Host clipboard backend is disposed")
    if (request.signal?.aborted) return { status: "cancelled" }
    const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? 1000
    if (timeoutMs === 0) return { status: "timed-out" }
    if (active.size >= (options.maxConcurrentOperations ?? 16)) {
      return { status: "failed", error: Object.assign(new Error("Host clipboard operation limit exceeded"), { code: "CLIPBOARD_OPERATION_LIMIT" }) }
    }
    const controller = new AbortController()
    const operation = {
      ...request, selection: request.selection ?? "clipboard", preferredTypes: request.preferredTypes ?? ["text/plain"],
      maxBytes: request.maxBytes ?? options.maxReadBytes ?? 8 * 1024 * 1024, timeoutMs, signal: controller.signal,
    }
    const callerAbort = () => controller.abort(request.signal.reason)
    request.signal?.addEventListener("abort", callerAbort, { once: true })
    let timedOut = false
    const stopTimer = deadlineTimer(timeoutMs, () => {
      timedOut = true
      controller.abort(new Error("Host clipboard operation timed out"))
    })
    const previous = kind === "read" ? Promise.resolve() : mutations.get(operation.selection) ?? Promise.resolve()
    const task = (async () => {
      try {
        await waitForSignal(previous, controller.signal)
        return await dispatch(kind, text, operation)
      } catch (error) {
        if (controller.signal.aborted) return { status: "cancelled" }
        return { status: "failed", error: error instanceof Error ? error : new Error(String(error)) }
      }
    })()
    const state = { controller, settled: task }
    active.add(state)
    if (kind !== "read") mutations.set(operation.selection, task.then(() => undefined))
    try {
      const result = await task
      return timedOut ? { status: "timed-out" } : result
    } finally {
      stopTimer()
      request.signal?.removeEventListener("abort", callerAbort)
      active.delete(state)
    }
  }

  return {
    read(request) { return run("read", undefined, request) },
    writeText(text, request) { return run("writeText", text, request) },
    clear(request) { return run("clear", undefined, request) },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      for (const state of active) state.controller.abort()
      for (const entry of providers.values()) entry.controller.abort()
      return disposePromise = (async () => {
        await Promise.allSettled([...active].map((state) => state.settled))
        // An unavailable provider can reject initialization without owning a
        // service; cleanup failures from an established service still propagate.
        const services = await Promise.all([...providers.values()].map((entry) => entry.promise.catch(() => undefined)))
        await Promise.all(services.filter(Boolean).map((service) => service.dispose()))
        providers.clear()
        mutations.clear()
      })()
    },
  }
}

const nativeReadTypes = new Set(["text/plain", "image/png", "image/jpeg", "image/webp", "image/gif"])

async function openProvider(mechanism, options) {
  if (mechanism === "wayland") {
    const { createWaylandClipboard } = await import("./clipboard/wayland.mjs")
    return createWaylandClipboard(options)
  }
  const { createX11Clipboard } = await import("./clipboard/x11.mjs")
  return createX11Clipboard(options)
}

function waitForSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then((value) => {
      signal.removeEventListener("abort", abort)
      resolve(value)
    }, (error) => {
      signal.removeEventListener("abort", abort)
      reject(error)
    })
  })
}

function deadlineTimer(milliseconds, callback) {
  const deadline = performance.now() + milliseconds
  let timer
  const schedule = () => {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return callback()
    timer = setTimeout(schedule, Math.min(remaining, 2147483647))
  }
  schedule()
  return () => clearTimeout(timer)
}
