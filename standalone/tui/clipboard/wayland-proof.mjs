import assert from "node:assert/strict"
import { createInterface } from "node:readline"
import { createWaylandClipboard } from "./wayland.mjs"

const backend = await createWaylandClipboard({ timeoutMs: 10_000 })
const lines = createInterface({ input: process.stdin })
const text = "copied Wayland 한글 👩🏽‍💻"
try {
  for (const selection of ["clipboard", "primary"]) assert.deepEqual(await backend.writeText(text, { selection }), { status: "written" })
  console.log(JSON.stringify({ ready: true }))
  for await (const command of lines) {
    assert.equal(command, "inspect")
    for (const selection of ["clipboard", "primary"]) {
      const result = await backend.read({ preferredTypes: ["text/plain"], selection })
      assert.equal(result.status, "read")
      assert.equal(result.representation.bytes.toString(), text)
      assert.deepEqual(await backend.clear({ selection }), { status: "cleared" })
      assert.deepEqual(await backend.read({ preferredTypes: ["text/plain"], selection }), { status: "empty" })
    }
    const disposal = backend.dispose()
    assert.equal(backend.dispose(), disposal)
    await disposal
    console.log(JSON.stringify({ copied: true, clipboard: true, primary: true, read: true, written: true, cleared: true, disposed: true }))
    break
  }
} finally { lines.close(); await backend.dispose() }
