import { parentPort, workerData } from "node:worker_threads"

/** One OS clipboard owner, one native thread, and a bounded parent-side queue. */
export async function serveNativeClipboardWorker(createClipboard) {
  let clipboard
  try { clipboard = await createClipboard(workerData.configuration) } catch (error) {
    parentPort.postMessage({ kind: "initialization-error", error: describe(error) })
    parentPort.close()
    return
  }
  let queue = Promise.resolve()
  let disposed = false
  parentPort.on("message", (message) => {
    queue = queue.then(async () => {
      if (message.kind === "dispose") {
        if (disposed) return
        disposed = true
        let error
        try { await clipboard.dispose() } catch (failure) { error = describe(failure) }
        parentPort.postMessage({ kind: "disposed", error })
        parentPort.close()
        return
      }
      const state = new Int32Array(message.state)
      const stopped = () => {
        if (Atomics.load(state, 0) === 2) return false
        if (performance.now() >= message.operation.deadline) Atomics.compareExchange(state, 0, 0, 3)
        const phase = Atomics.load(state, 0)
        return phase === 1 || phase === 3
      }
      const operation = {
        ...message.operation,
        signal: { get aborted() { return stopped() } },
        beginMutation() { return !stopped() && Atomics.compareExchange(state, 0, 0, 2) === 0 },
      }
      let result
      try {
        result = disposed ? { status: "failed", error: new Error("Clipboard worker is disposed") }
          : stopped() ? { status: "cancelled" }
          : message.kind === "writeText" ? await clipboard.writeText(message.text, operation)
          : await clipboard[message.kind](operation)
      } catch (error) { result = { status: "failed", error } }
      if (stopped()) result = { status: Atomics.load(state, 0) === 3 ? "timed-out" : "cancelled" }
      parentPort.postMessage({ id: message.id, result: result.error ? { ...result, error: describe(result.error) } : result })
    }).catch((error) => {
      parentPort.postMessage({ kind: "initialization-error", error: describe(error) })
      parentPort.close()
    })
  })
  parentPort.postMessage({ kind: "ready" })
}

function describe(error) {
  return { name: error?.name ?? "Error", message: error instanceof Error ? error.message : String(error), code: error?.code, win32Code: error?.win32Code }
}
