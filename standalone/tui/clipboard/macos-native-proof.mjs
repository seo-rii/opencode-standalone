import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { getClipboardWorkerSource } from "../../scripts/clipboard-workers.mjs"
import { createNativeClipboardWorker } from "./native-worker.mjs"

// This is an explicit native-machine check, never a skipped Linux test or a
// substitute for actual AppKit/ImageIO validation.
if (process.platform !== "darwin") throw new Error("Run this proof on macOS with Node >=26.4 and --experimental-ffi")
const ffi = createRequire(import.meta.url)("node:ffi")
const root = await mkdtemp(join(tmpdir(), "standalone-macos-native-"))
const pasteboardName = `opencode-standalone-proof-${randomUUID()}`
const library = join(root, "native-peer.dylib")
let peer
let clipboard
try {
  await promisify(execFile)(process.env.CC ?? "cc", [
    "-dynamiclib", "-fobjc-arc", "-O2", "-framework", "AppKit", "-framework", "Foundation", "-framework", "CoreFoundation",
    "-framework", "ImageIO", "-framework", "CoreGraphics",
    "-include", fileURLToPath(new URL("../.cache/factory-source/src/clipboard/macos-shim.m", import.meta.url)),
    fileURLToPath(new URL("macos-native-peer.m", import.meta.url)), "-o", library,
  ])
  peer = ffi.dlopen(library, {
    NativeSet: { arguments: ["string", "u32", "pointer", "u64"], return: "i32" },
    NativeMakeTIFF: { arguments: ["string"], return: "i32" },
    NativeText: { arguments: ["string", "pointer", "pointer"], return: "i32" },
    NativeOriginalPNG: { arguments: ["string", "u32", "u32", "u32", "pointer", "pointer"], return: "i32" },
    NativeFree: { arguments: ["pointer"], return: "void" },
    NativeRelease: { arguments: ["string"], return: "void" },
  })
  const source = await getClipboardWorkerSource("macos")
  clipboard = await createNativeClipboardWorker(source, { pasteboardName, timeoutMs: 10_000 })
  const text = "Native NSPasteboard 한글 👩🏽‍💻\n"
  const bytes = Buffer.from(text)
  assert.equal(peer.functions.NativeSet(pasteboardName, 1, bytes, BigInt(bytes.length)), 0)
  const read = await clipboard.read({ preferredTypes: ["text/plain"] })
  assert.equal(read.status, "read")
  assert.equal(read.representation.bytes.toString(), text)
  assert.equal((await clipboard.writeText(`${text}worker`, {})).status, "written")
  const pointer = Buffer.alloc(8)
  const length = Buffer.alloc(4)
  assert.equal(peer.functions.NativeText(pasteboardName, pointer, length), 0)
  try { assert.equal(ffi.toBuffer(pointer.readBigUInt64LE(), length.readUInt32LE()).toString(), `${text}worker`) }
  finally { peer.functions.NativeFree(pointer.readBigUInt64LE()) }
  assert.equal(peer.functions.NativeMakeTIFF(pasteboardName), 0)
  assert.equal(peer.functions.NativeOriginalPNG(pasteboardName, 8 * 1024 * 1024, 64 * 1024 * 1024, 512 * 1024 * 1024, pointer, length), 0)
  const expectedPNG = ffi.toBuffer(pointer.readBigUInt64LE(), length.readUInt32LE())
  peer.functions.NativeFree(pointer.readBigUInt64LE())
  const converted = await clipboard.read({ preferredTypes: ["image/png", "text/plain"] })
  assert.equal(converted.status, "read")
  assert.equal(converted.representation.mimeType, "image/png")
  assert.deepEqual(converted.representation.bytes, expectedPNG)
  assert.equal((await clipboard.read({ preferredTypes: ["image/png"], maxBytes: 4 })).status, "limit-exceeded")
  await clipboard.dispose()
  clipboard = await createNativeClipboardWorker(source, { pasteboardName, maxImagePixels: 0, maxConversionBytes: 0, timeoutMs: 10_000 })
  assert.equal((await clipboard.read({ preferredTypes: ["image/png"] })).status, "limit-exceeded")
  assert.equal(peer.functions.NativeSet(pasteboardName, 2, expectedPNG, BigInt(expectedPNG.length)), 0)
  const rawPNG = await clipboard.read({ preferredTypes: ["image/png"] })
  assert.equal(rawPNG.status, "read")
  assert.deepEqual(rawPNG.representation.bytes, expectedPNG)
  assert.equal((await clipboard.read({ selection: "primary", preferredTypes: ["text/plain"] })).status, "unsupported")
  assert.equal((await clipboard.clear({})).status, "cleared")
  assert.equal((await clipboard.read({ preferredTypes: ["text/plain", "image/png"] })).status, "empty")
  process.stdout.write(`${JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, nativeVerified: true, upstreamTIFFBytesEqual: true, privatePasteboard: true })}\n`)
} finally {
  await clipboard?.dispose()
  peer?.functions.NativeRelease(pasteboardName)
  peer?.lib.close()
  await rm(root, { recursive: true, force: true })
}
