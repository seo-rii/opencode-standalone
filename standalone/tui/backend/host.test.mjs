import assert from "node:assert/strict"
import { closeSync, openSync, readSync, writeSync } from "node:fs"
import { createRequire } from "node:module"
import { setImmediate } from "node:timers/promises"
import { test } from "node:test"
import { isatty } from "node:tty"
import { hostMethods } from "./host.mjs"

test("real terminal flush discards queued kernel input and retains input written afterward", async () => {
  const ffi = createRequire(import.meta.url)("node:ffi")
  const library = ffi.dlopen(null, {
    openpty: { arguments: ["pointer", "pointer", "pointer", "pointer", "pointer"], return: "i32" },
    ioctl: { arguments: ["i32", "u64", "pointer"], return: "i32" },
  })
  const master = Buffer.alloc(4)
  const slave = Buffer.alloc(4)
  assert.equal(library.functions.openpty(master, slave, null, null, null), 0)
  const masterFD = master.readInt32LE()
  const slaveFD = slave.readInt32LE()
  const queued = () => {
    const count = Buffer.alloc(4)
    // Linux FIONREAD reports bytes available in the slave's kernel input queue.
    assert.equal(library.functions.ioctl(slaveFD, 0x541bn, count), 0)
    return count.readInt32LE()
  }
  const ready = async () => {
    const deadline = Date.now() + 2_000
    while (queued() === 0) {
      assert.ok(Date.now() < deadline, "PTY input did not reach the kernel queue")
      await setImmediate()
    }
  }
  try {
    assert.equal(isatty(slaveFD), true)
    writeSync(masterFD, Buffer.from("discarded 한국어\n"))
    await ready()
    assert.ok(queued() > 0)
    hostMethods.terminalFlushInput(slaveFD)
    assert.equal(queued(), 0)
    writeSync(masterFD, Buffer.from("retained 한글\n"))
    await ready()
    const bytes = Buffer.alloc(256)
    const count = readSync(slaveFD, bytes)
    assert.equal(bytes.subarray(0, count).toString("utf8"), "retained 한글\n")
  } finally {
    closeSync(slaveFD)
    closeSync(masterFD)
    library.lib.close()
  }
})

test("terminal flush keeps upstream best-effort behavior for a nonterminal descriptor", () => {
  const fd = openSync("/dev/null", "r")
  try {
    assert.equal(isatty(fd), false)
    assert.doesNotThrow(() => hostMethods.terminalFlushInput(fd))
  } finally {
    closeSync(fd)
  }
  assert.throws(() => hostMethods.terminalFlushInput(-1), RangeError)
})
