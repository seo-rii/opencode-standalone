/** An actual blocking worker exercises transport ownership without OS clipboard state. */
export function createClipboardWorkerFixture(configuration) {
  const gate = configuration.gate ? new Int32Array(configuration.gate) : undefined
  let text = "worker 한국어"
  let disposed = false
  function block() {
    if (!gate) return
    Atomics.store(gate, 1, 1)
    Atomics.notify(gate, 1)
    Atomics.wait(gate, 0, 0)
  }
  return {
    read(operation) {
      if (disposed) throw new Error("Disposed native fixture")
      if (!configuration.mutation) block()
      if (operation.signal.aborted) return { status: "cancelled" }
      return { status: "read", representation: { mimeType: "text/plain", bytes: Buffer.from(text) } }
    },
    writeText(value, operation) {
      if (!operation.beginMutation()) return { status: "cancelled" }
      if (configuration.mutation) block()
      text = value
      return { status: "written" }
    },
    clear(operation) {
      if (!operation.beginMutation()) return { status: "cancelled" }
      text = ""
      return { status: "cleared" }
    },
    async dispose() {
      disposed = true
      // Model a native cleanup that yields after a cancelled reply. The
      // parent must keep this worker referenced until that cleanup finishes.
      if (configuration.cleanupDelay) await setTimeout(configuration.cleanupDelay)
    },
  }
}
import { setTimeout } from "node:timers/promises"

