import { Worker } from "node:worker_threads"

/** Native calls can wait for another application without blocking terminal input. */
export async function createNativeClipboardWorker(source, configuration = {}) {
  const { signal, ...settings } = configuration
  if (signal?.aborted) throw signal.reason ?? new Error("Clipboard initialization cancelled")
  const worker = new Worker(source, {
    eval: true, workerData: { configuration: settings },
  })
  const pending = new Map()
  let next = 1
  let disposed = false
  let disposePromise
  let failure
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  let shutdownResolve
  const shutdown = new Promise((resolve) => { shutdownResolve = resolve })
  const fail = (error) => {
    failure ??= error
    readyReject(error)
    for (const entry of pending.values()) entry.finish({ status: "failed", error })
    pending.clear()
    shutdownResolve()
    if (!disposed) worker.unref()
  }
  worker.on("error", fail)
  worker.on("exit", (code) => {
    if (!disposed || pending.size) fail(new Error(`Clipboard worker exited (${code})`))
    shutdownResolve()
  })
  worker.on("message", (message) => {
    if (message.kind === "ready") { readyResolve(); worker.unref(); return }
    if (message.kind === "initialization-error") { fail(nativeError(message.error)); return }
    if (message.kind === "disposed") {
      if (message.error) failure ??= nativeError(message.error)
      shutdownResolve()
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    const result = message.result
    if (result.error) result.error = nativeError(result.error)
    if (result.representation) result.representation.bytes = Buffer.from(result.representation.bytes)
    const committed = Atomics.load(entry.state, 0) === 2
    if (committed) entry.request.mutationCommitted = true
    const phase = Atomics.load(entry.state, 0)
    entry.finish(phase === 1 || phase === 3 ? { status: phase === 3 ? "timed-out" : "cancelled" } : result)
    pending.delete(message.id)
    if (!disposed && ![...pending.values()].some((item) => !item.settled)) worker.unref()
  })
  const abortInitialization = () => fail(signal.reason ?? new Error("Clipboard initialization cancelled"))
  signal?.addEventListener("abort", abortInitialization, { once: true })
  const stopInitialization = deadline(configuration.timeoutMs ?? 1000, () => fail(Object.assign(new Error("Clipboard initialization timed out"), { code: "NATIVE_CLIPBOARD_TIMEOUT" })))
  try { await ready } catch (error) {
    disposed = true
    worker.unref()
    void worker.terminate()
    throw error
  } finally {
    stopInitialization()
    signal?.removeEventListener("abort", abortInitialization)
  }

  function run(kind, text, request = {}) {
    if (disposed) return Promise.reject(new Error("Clipboard worker is disposed"))
    if (failure) return Promise.resolve({ status: "failed", error: failure })
    if (request.signal?.aborted) return Promise.resolve({ status: "cancelled" })
    const timeoutMs = request.timeoutMs ?? configuration.timeoutMs ?? 1000
    if (timeoutMs === 0) return Promise.resolve({ status: "timed-out" })
    // Cancelled native calls may still be returning from an OS function. Keep
    // them in this bound until their reply arrives instead of spawning workers.
    if (pending.size >= (configuration.maxConcurrentOperations ?? 16)) {
      return Promise.resolve({ status: "failed", error: Object.assign(new Error("Native clipboard operation limit exceeded"), { code: "CLIPBOARD_OPERATION_LIMIT" }) })
    }
    // One atomic word carries the complete transition: pending, cancelled,
    // mutating, or timed out. No reader can see a status without its reason.
    const state = new Int32Array(new SharedArrayBuffer(4))
    const id = next++
    return new Promise((resolve) => {
      const entry = {
        state, request, settled: false,
        finish(result) {
          if (entry.settled) return
          entry.settled = true
          stopTimer()
          request.signal?.removeEventListener("abort", abort)
          resolve(result)
        },
      }
      const cancel = (reason) => {
        // This CAS is paired with beginMutation in the worker. A committed
        // clipboard write keeps its actual result over a later cancellation.
        const previous = Atomics.compareExchange(state, 0, 0, reason === 2 ? 3 : 1)
        if (previous === 2) return
        const phase = Atomics.load(state, 0)
        entry.finish({ status: phase === 3 ? "timed-out" : "cancelled" })
        if (!disposed && ![...pending.values()].some((item) => !item.settled)) worker.unref()
      }
      const abort = () => cancel(1)
      const stopTimer = deadline(timeoutMs, () => cancel(2))
      request.signal?.addEventListener("abort", abort, { once: true })
      pending.set(id, entry)
      worker.ref()
      const operation = { ...request }
      delete operation.signal
      delete operation.mutationCommitted
      try {
        worker.postMessage({ id, kind, text, state: state.buffer, operation: {
          selection: "clipboard", preferredTypes: ["text/plain"], maxBytes: configuration.maxReadBytes ?? 8 * 1024 * 1024,
          ...operation, timeoutMs, deadline: performance.now() + timeoutMs,
        } })
      } catch (error) {
        pending.delete(id)
        entry.finish({ status: "failed", error })
        if (!disposed && !pending.size) worker.unref()
      }
    })
  }

  return {
    read(request) { return run("read", undefined, request) },
    writeText(text, request) { return run("writeText", text, request) },
    clear(request) { return run("clear", undefined, request) },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      for (const entry of pending.values()) {
        const previous = Atomics.compareExchange(entry.state, 0, 0, 1)
        if (previous !== 2) entry.finish({ status: previous === 3 ? "timed-out" : "cancelled" })
      }
      disposePromise = (async () => {
        if (!failure) {
          worker.ref()
          worker.postMessage({ kind: "dispose" })
          await shutdown
        }
        await worker.terminate()
        if (failure) throw failure
      })()
      return disposePromise
    },
  }
}

function nativeError(value) {
  return Object.assign(new Error(value.message), { name: value.name ?? "Error", ...(value.code === undefined ? {} : { code: value.code }), ...(value.win32Code === undefined ? {} : { win32Code: value.win32Code }) })
}

function deadline(milliseconds, callback) {
  const end = performance.now() + milliseconds
  let timer
  const schedule = () => {
    const remaining = end - performance.now()
    if (remaining <= 0) { callback(); return }
    timer = setTimeout(schedule, Math.min(remaining, 2147483647))
  }
  // Scheduling first also makes zero-timeout initialization fail asynchronously.
  timer = setTimeout(schedule, Math.min(milliseconds, 2147483647))
  return () => clearTimeout(timer)
}
