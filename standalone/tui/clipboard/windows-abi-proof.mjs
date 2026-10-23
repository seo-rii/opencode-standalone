import assert from "node:assert/strict"
import ffi from "node:ffi"
import { setImmediate } from "node:timers/promises"
import source from "opencode:clipboard-windows-worker"
import { createNativeClipboardWorker } from "./native-worker.mjs"

const filename = process.argv[2]
const fixture = ffi.dlopen(filename, {
  FixtureReset: { arguments: [], return: "void" },
  FixtureFail: { arguments: ["u32"], return: "void" },
  FixtureHold: { arguments: ["u32"], return: "void" },
  FixtureBlock: { arguments: ["u32"], return: "void" },
  FixtureBlockMutation: { arguments: ["u32"], return: "void" },
  FixtureStat: { arguments: ["u32"], return: "u64" },
  FixtureOffer: { arguments: ["u32", "pointer", "u64"], return: "void" },
  FixtureCopy: { arguments: ["u32", "pointer", "u64"], return: "u64" },
})
const control = fixture.functions
control.FixtureReset()
const clipboard = await createNativeClipboardWorker(source, { user32Path: filename, kernel32Path: filename })
try {
  assert.equal(control.FixtureStat(2), 1n)
  assert.equal(control.FixtureStat(14), 1n)
  assert.equal((await clipboard.read({ preferredTypes: ["text/plain"] })).status, "empty")
  assert.equal((await clipboard.read({ preferredTypes: ["image/jpeg"] })).status, "unsupported")
  assert.equal((await clipboard.writeText("ignored", { selection: "primary" })).status, "unsupported")
  assert.equal((await clipboard.clear({ selection: "primary" })).status, "unsupported")
  const text = "Windows 한국어 😀\na\r\nb\rc"
  assert.equal((await clipboard.writeText(text)).status, "written")
  const stored = copy(13)
  assert.equal(stored.toString("utf16le"), "Windows 한국어 😀\r\na\r\nb\r\nc\0")
  assert.equal(control.FixtureStat(8), 1n)
  const read = await clipboard.read({ preferredTypes: ["text/plain"], timeoutMs: 0xffffffff })
  assert.equal(read.status, "read")
  assert.equal(Buffer.from(read.representation.bytes).toString(), "Windows 한국어 😀\r\na\r\nb\r\nc")
  assert.equal((await clipboard.read({ preferredTypes: ["text/plain"], maxBytes: 3 })).status, "limit-exceeded")
  assert.equal((await clipboard.clear()).status, "cleared")
  assert.equal(control.FixtureStat(7), 0n)
  assert.equal(control.FixtureStat(5), 0n)
  assert.equal(control.FixtureStat(6), 0n)

  for (const invalid of [Buffer.from([0, 0xd8, 0, 0]), Buffer.from([0, 0xdc, 0, 0]), Buffer.from([0x61]), Buffer.from("ab", "utf16le")]) {
    offer(13, invalid)
    const read = await clipboard.read({ preferredTypes: ["text/plain"], maxBytes: 8 })
    assert.equal(read.status, "failed")
    assert.equal(read.error.win32Code, 13)
  }
  offer(13, Buffer.from("ab", "utf16le"))
  assert.equal((await clipboard.read({ preferredTypes: ["text/plain"], maxBytes: 1 })).status, "limit-exceeded")
  offer(13, Buffer.from("\0", "utf16le"))
  const empty = await clipboard.read({ preferredTypes: ["text/plain"], maxBytes: 0 })
  assert.equal(empty.status, "read")
  assert.equal(empty.representation.bytes.length, 0)

  const png = Buffer.from("89504e470d0a1a0a00ff102030", "hex")
  offer(0xc000, png)
  const image = await clipboard.read({ preferredTypes: ["image/png", "text/plain"] })
  assert.equal(image.status, "read")
  assert.equal(image.representation.mimeType, "image/png")
  assert.deepEqual(Buffer.from(image.representation.bytes), png)
  assert.equal((await clipboard.read({ preferredTypes: ["image/png"], maxBytes: png.length - 1 })).status, "limit-exceeded")
  await clipboard.clear()
  offer(17, Buffer.from([1, 2, 3]))
  offer(13, Buffer.from("fallback 한글\0", "utf16le"))
  const fallback = await clipboard.read({ preferredTypes: ["image/png", "text/plain"] })
  assert.equal(fallback.status, "read")
  assert.equal(fallback.representation.mimeType, "text/plain")
  assert.equal(Buffer.from(fallback.representation.bytes).toString(), "fallback 한글")
  assert.equal((await clipboard.read({ preferredTypes: ["image/png"] })).status, "failed")
  // A bottom-up 24-bit DIB must be encoded as PNG after releasing the lock.
  await clipboard.clear()
  const dib = Buffer.alloc(44)
  dib.writeUInt32LE(40)
  dib.writeInt32LE(1, 4)
  dib.writeInt32LE(1, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(24, 14)
  dib.set([0x33, 0x22, 0x11, 0], 40)
  offer(8, dib)
  const converted = await clipboard.read({ preferredTypes: ["image/png"] })
  assert.equal(converted.status, "read")
  assert.deepEqual(Buffer.from(converted.representation.bytes).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"))
  assert.equal(control.FixtureStat(6), 0n)
  assert.equal(control.FixtureStat(5), 0n)

  const constrained = await createNativeClipboardWorker(source, { user32Path: filename, kernel32Path: filename, maxImagePixels: 0, maxConversionBytes: 0 })
  try {
    assert.equal((await constrained.read({ preferredTypes: ["image/png"] })).status, "limit-exceeded")
    offer(0xc000, png)
    const raw = await constrained.read({ preferredTypes: ["image/png"] })
    assert.equal(raw.status, "read")
    assert.deepEqual(Buffer.from(raw.representation.bytes), png)
  } finally { await constrained.dispose() }

  for (const stage of [1, 2, 3, 4]) {
    await clipboard.clear()
    control.FixtureFail(stage)
    assert.equal((await clipboard.writeText("failure 한국어")).status, "failed")
    assert.equal(control.FixtureStat(7), 0n)
    assert.equal(control.FixtureStat(5), 0n)
    assert.equal(control.FixtureStat(6), 0n)
    control.FixtureFail(0)
  }

  control.FixtureHold(1)
  const cancel = new AbortController()
  const before = control.FixtureStat(3)
  const pending = clipboard.writeText("must not mutate", { signal: cancel.signal, timeoutMs: 10_000 })
  await until(() => control.FixtureStat(3) > before)
  cancel.abort()
  assert.equal((await pending).status, "cancelled")
  await until(() => control.FixtureStat(7) === 0n)
  assert.equal(control.FixtureStat(7), 0n)
  assert.equal((await clipboard.clear({ timeoutMs: 30 })).status, "timed-out")
  control.FixtureHold(0)

  const committedAbort = new AbortController()
  const mutation = { signal: committedAbort.signal, timeoutMs: 10_000 }
  const mutationsBefore = control.FixtureStat(10)
  control.FixtureBlockMutation(1)
  const committed = clipboard.writeText("committed before abort", mutation)
  await until(() => control.FixtureStat(10) > mutationsBefore)
  committedAbort.abort()
  control.FixtureBlockMutation(0)
  assert.equal((await committed).status, "written")
  assert.equal(mutation.mutationCommitted, true)

  // The ABI oracle blocks inside GetClipboardData, beyond the JS event loop.
  offer(13, Buffer.from("blocked native call\0", "utf16le"))
  const controller = new AbortController()
  const readsBefore = control.FixtureStat(12)
  control.FixtureBlock(1)
  const blocked = clipboard.read({ preferredTypes: ["text/plain"], signal: controller.signal, timeoutMs: 10_000 })
  await until(() => control.FixtureStat(12) > readsBefore)
  controller.abort()
  control.FixtureBlock(0)
  control.FixtureBlockMutation(0)
  assert.equal((await blocked).status, "cancelled")
  assert.equal((await clipboard.clear()).status, "cleared")
  assert.equal(control.FixtureStat(9), 0n)
} finally {
  control.FixtureBlock(0)
  control.FixtureHold(0)
  control.FixtureFail(0)
  await clipboard.dispose()
}
assert.equal(control.FixtureStat(2), 0n)
assert.equal(control.FixtureStat(5), 0n)
assert.equal(control.FixtureStat(6), 0n)
assert.equal(control.FixtureStat(7), 0n)
assert.equal(control.FixtureStat(9), 0n)
for (const stage of [5, 6]) {
  control.FixtureFail(stage)
  await assert.rejects(createNativeClipboardWorker(source, { user32Path: filename, kernel32Path: filename }), { code: "WINDOWS_FAILED", win32Code: 13 })
  assert.equal(control.FixtureStat(2), 0n)
  assert.equal(control.FixtureStat(7), 0n)
  control.FixtureFail(0)
}
control.FixtureReset()
fixture.lib.close()
console.log(JSON.stringify({ platform: process.platform, nativeAbiFixture: true, actualWindows: false }))

function offer(format, bytes) { control.FixtureOffer(format, bytes, BigInt(bytes.length)) }
function copy(format) {
  const length = Number(control.FixtureCopy(format, 0n, 0n))
  const bytes = Buffer.alloc(length)
  assert.equal(control.FixtureCopy(format, bytes, BigInt(length)), BigInt(length))
  return bytes
}
async function until(condition) {
  const deadline = performance.now() + 10_000
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Native ABI fixture did not reach the requested operation")
    await setImmediate()
  }
}
