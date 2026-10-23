import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createMacOSNativeClipboard } from "./macos-worker.mjs"
import { createMacOSClipboard } from "./macos.mjs"
import { createNativeClipboardWorker } from "./native-worker.mjs"
import { clipboardWorkers, getClipboardWorkerSource } from "../../scripts/clipboard-workers.mjs"
import { build } from "esbuild"

let root
let library
let fixture
const ffi = createRequire(import.meta.url)("node:ffi")
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex")

before(async () => {
  root = await mkdtemp(join(tmpdir(), "standalone-macos-abi-"))
  library = join(root, `macos-abi.${ffi.suffix}`)
  await promisify(execFile)(process.env.CC ?? "cc", [
    ...(process.platform === "darwin" ? ["-dynamiclib"] : ["-shared", "-fPIC"]),
    "-std=c11", "-D_POSIX_C_SOURCE=200809L", "-O2", "-Wall", "-Wextra", "-Werror",
    fileURLToPath(new URL("macos-abi-fixture.c", import.meta.url)), "-o", library,
  ])
  fixture = ffi.dlopen(library, {
    FixtureReset: { arguments: [], return: "void" },
    FixtureSetText: { arguments: ["pointer", "u64", "u32"], return: "void" },
    FixtureSetPNG: { arguments: ["pointer", "u64", "u32"], return: "void" },
    FixtureSetTIFF: { arguments: ["pointer", "u64", "u32"], return: "void" },
    FixtureSetOutput: { arguments: ["pointer", "u64"], return: "void" },
    FixtureSetImage: { arguments: ["u64", "u64", "u64", "u32", "u32", "u64"], return: "void" },
    FixtureSetDecodedSize: { arguments: ["u64", "u64"], return: "void" },
    FixtureSetOrientation: { arguments: ["u64"], return: "void" },
    FixtureSetFailure: { arguments: ["u32"], return: "void" },
    FixtureCounter: { arguments: ["u32"], return: "u64" },
    FixtureTextLength: { arguments: [], return: "u64" },
    FixtureTextBytes: { arguments: [], return: "pointer" },
  })
})

after(async () => {
  fixture?.functions.FixtureReset()
  fixture?.lib.close()
  if (root) await rm(root, { recursive: true, force: true })
})

function engine(options = {}) {
  return createMacOSNativeClipboard({
    libraries: Object.fromEntries(["objc", "appkit", "foundation", "imageio", "graphics"].map((name) => [name, library])),
    pasteboardName: "standalone-ABI-only",
    ...options,
  })
}

function data(type, value, state = 1) {
  const bytes = Buffer.from(value)
  fixture.functions[`FixtureSet${type}`](bytes, BigInt(bytes.length), state)
}

function operation(options = {}) {
  return { preferredTypes: ["image/png", "text/plain"], selection: "clipboard", maxBytes: 8 * 1024 * 1024, signal: { aborted: false }, ...options }
}

test("macOS ABI oracle exercises native text encoding, ownership, PRIMARY and mutation fencing", async () => {
  fixture.functions.FixtureReset()
  const clipboard = engine({ maxImagePixels: 0, maxConversionBytes: 0 })
  try {
    assert.equal(clipboard.read(operation()).status, "empty")
    assert.equal(clipboard.read(operation({ preferredTypes: ["image/jpeg"] })).status, "unsupported")
    assert.equal(clipboard.read(operation({ selection: "primary" })).status, "unsupported")
    assert.equal(clipboard.writeText("PRIMARY", operation({ selection: "primary" })).status, "unsupported")
    assert.equal(clipboard.clear(operation({ selection: "primary" })).status, "unsupported")
    const text = "Native macOS 한글 👩🏽‍💻\n"
    assert.equal(clipboard.writeText(text, operation({ beginMutation: () => false })).status, "cancelled")
    assert.equal(fixture.functions.FixtureCounter(1), 0n)
    let mutations = 0
    assert.equal(clipboard.writeText(text, operation({ beginMutation: () => { mutations++; return true } })).status, "written")
    assert.equal(mutations, 1)
    assert.equal(ffi.toBuffer(fixture.functions.FixtureTextBytes(), Number(fixture.functions.FixtureTextLength())).toString(), text)
    const read = clipboard.read(operation())
    assert.equal(read.status, "read")
    assert.equal(read.representation.mimeType, "text/plain")
    assert.equal(Buffer.from(read.representation.bytes).toString(), text)
    assert.equal(clipboard.read(operation({ maxBytes: Buffer.byteLength(text) - 1 })).status, "limit-exceeded")
    assert.equal(clipboard.read(operation({ signal: { aborted: true } })).status, "cancelled")
    assert.equal(clipboard.read(operation({ deadline: performance.now() - 1 })).status, "timed-out")
    assert.equal(clipboard.clear(operation({ beginMutation: () => false })).status, "cancelled")
    assert.equal(fixture.functions.FixtureCounter(1), 1n)
    assert.equal(clipboard.clear(operation({ beginMutation: () => true })).status, "cleared")
    assert.equal(clipboard.read(operation()).status, "empty")
    assert.equal(clipboard.writeText("", operation()).status, "written")
    const empty = clipboard.read(operation({ maxBytes: 0 }))
    assert.equal(empty.status, "read")
    assert.equal(empty.representation.bytes.length, 0)
    assert.equal(fixture.functions.FixtureCounter(6), 0n)
    assert.equal(fixture.functions.FixtureCounter(7), 0n)
    if (process.platform !== "darwin") await assert.rejects(createMacOSClipboard(), { code: "MACOS_UNSUPPORTED" })
  } finally { clipboard.dispose(); clipboard.dispose() }
  assert.throws(() => clipboard.read(operation()), /disposed/)
})

test("macOS ABI oracle preserves direct PNG bytes and original MIME failure fallback", () => {
  fixture.functions.FixtureReset()
  const clipboard = engine({ maxImagePixels: 0, maxConversionBytes: 0 })
  try {
    data("PNG", png)
    data("Text", "fallback 한글")
    const live = fixture.functions.FixtureCounter(5)
    const direct = clipboard.read(operation())
    assert.equal(direct.status, "read")
    assert.equal(direct.representation.mimeType, "image/png")
    assert.deepEqual(direct.representation.bytes, png)
    assert.equal(fixture.functions.FixtureCounter(3), 0n)
    assert.equal(clipboard.read(operation({ maxBytes: png.length - 1 })).status, "limit-exceeded")
    assert.equal(fixture.functions.FixtureCounter(5), live)
    data("PNG", "", 1)
    assert.equal(clipboard.read(operation()).representation.bytes.toString(), "fallback 한글")
    data("PNG", "", 2)
    assert.equal(clipboard.read(operation()).representation.bytes.toString(), "fallback 한글")
    assert.equal(clipboard.read(operation({ preferredTypes: ["image/png"] })).status, "failed")
    data("Text", "", 2)
    assert.equal(clipboard.read(operation({ preferredTypes: ["text/plain", "image/png"] })).status, "failed")
    assert.equal(fixture.functions.FixtureCounter(6), 0n)
  } finally { clipboard.dispose() }
})

test("macOS ABI oracle exercises TIFF ImageIO metadata, bounded output, orientation and native cleanup", () => {
  fixture.functions.FixtureReset()
  data("TIFF", "TIFF fixture source")
  fixture.functions.FixtureSetOutput(png, BigInt(png.length))
  fixture.functions.FixtureSetOrientation(6n)
  const clipboard = engine()
  try {
    const live = fixture.functions.FixtureCounter(5)
    const converted = clipboard.read(operation())
    assert.equal(converted.status, "read")
    assert.deepEqual(converted.representation.bytes, png)
    assert.equal(fixture.functions.FixtureCounter(3), 1n)
    assert.equal(fixture.functions.FixtureCounter(8), 6n)
    assert.equal(fixture.functions.FixtureCounter(9), 1n)
    assert.equal(fixture.functions.FixtureCounter(10), 2n)
    assert.equal(fixture.functions.FixtureCounter(11), 1n)
    assert.equal(fixture.functions.FixtureCounter(12), 1n)
    assert.equal(fixture.functions.FixtureCounter(5), live)
    assert.equal(clipboard.read(operation({ maxBytes: png.length - 1 })).status, "limit-exceeded")
    assert.equal(fixture.functions.FixtureCounter(5), live)
    assert.equal(clipboard.read(operation({ maxBytes: 0 })).status, "limit-exceeded")
    assert.equal(fixture.functions.FixtureCounter(5), live)
    const cancelled = clipboard.read(operation({ signal: { get aborted() { return fixture.functions.FixtureCounter(4) > 3n } } }))
    assert.equal(cancelled.status, "cancelled")
    assert.equal(fixture.functions.FixtureCounter(5), live)
    for (const failure of [1, 2, 4, 8, 16]) {
      fixture.functions.FixtureSetFailure(failure)
      assert.equal(clipboard.read(operation()).status, "failed", `native failure stage ${failure}`)
      assert.equal(fixture.functions.FixtureCounter(5), live)
      assert.equal(fixture.functions.FixtureCounter(6), 0n)
    }
    fixture.functions.FixtureSetFailure(0)
    fixture.functions.FixtureSetDecodedSize(2n, 1n)
    assert.equal(clipboard.read(operation()).status, "failed")
    assert.equal(fixture.functions.FixtureCounter(5), live)
  } finally { clipboard.dispose() }
})

test("macOS ABI oracle enforces clipboard conversion limits independently of renderer limits", () => {
  fixture.functions.FixtureReset()
  data("TIFF", "TIFF")
  fixture.functions.FixtureSetOutput(png, BigInt(png.length))
  for (const [options, shape, status] of [
    [{ maxConversionBytes: 3 }, [1n, 1n, 8n, 2, 1, 4n], "limit-exceeded"],
    [{ maxImagePixels: 0 }, [1n, 1n, 8n, 2, 1, 4n], "limit-exceeded"],
    [{ maxImagePixels: 2 }, [2n, 2n, 8n, 2, 1, 8n], "limit-exceeded"],
    [{ maxConversionBytes: 8 }, [2n, 2n, 8n, 2, 1, 8n], "limit-exceeded"],
    [{ maxConversionBytes: 4 }, [1n, 1n, 8n, 2, 1, 8n], "limit-exceeded"],
    [{ maxConversionBytes: 4 }, [1n, 1n, 8n, 2, 1, 4n], "read"],
    [{ maxConversionBytes: 4 }, [1n, 1n, 8n, 1, 0, 4n], "read"],
    [{}, [0n, 1n, 8n, 2, 1, 4n], "failed"],
    [{}, [1n, 1n, 65n, 2, 1, 4n], "failed"],
    [{ maxImagePixels: 64 * 1024 * 1024 }, [17000n, 1n, 8n, 2, 1, 68000n], "read"],
  ]) {
    fixture.functions.FixtureSetImage(...shape)
    const clipboard = engine(options)
    const live = fixture.functions.FixtureCounter(5)
    try {
      assert.equal(clipboard.read(operation()).status, status, JSON.stringify(options))
      assert.equal(fixture.functions.FixtureCounter(5), live)
      assert.equal(fixture.functions.FixtureCounter(6), 0n)
    } finally { clipboard.dispose() }
  }
})

test("macOS bundled native worker exchanges actual C ABI bytes and frees native resources", async () => {
  fixture.functions.FixtureReset()
  const source = await getClipboardWorkerSource("macos")
  const clipboard = await createNativeClipboardWorker(source, {
    libraries: Object.fromEntries(["objc", "appkit", "foundation", "imageio", "graphics"].map((name) => [name, library])),
    pasteboardName: "standalone-worker-ABI-only",
  })
  try {
    assert.equal((await clipboard.writeText("embedded native worker 한글 👩🏽‍💻", {})).status, "written")
    const text = await clipboard.read({ preferredTypes: ["text/plain"] })
    assert.equal(text.status, "read")
    assert.equal(text.representation.bytes.toString(), "embedded native worker 한글 👩🏽‍💻")
    assert.equal((await clipboard.read({ selection: "primary", preferredTypes: ["text/plain"] })).status, "unsupported")
    data("PNG", png)
    const direct = await clipboard.read({ preferredTypes: ["image/png", "text/plain"] })
    assert.equal(direct.status, "read")
    assert.deepEqual(direct.representation.bytes, png)
    data("PNG", "", 0)
    data("TIFF", "TIFF ABI payload")
    fixture.functions.FixtureSetOutput(png, BigInt(png.length))
    const live = fixture.functions.FixtureCounter(5)
    const converted = await clipboard.read({ preferredTypes: ["image/png"] })
    assert.equal(converted.status, "read")
    assert.deepEqual(converted.representation.bytes, png)
    assert.equal((await clipboard.read({ preferredTypes: ["image/png"], maxBytes: 4 })).status, "limit-exceeded")
    assert.equal(fixture.functions.FixtureCounter(5), live)
    assert.equal(fixture.functions.FixtureCounter(6), 0n)
    assert.equal((await clipboard.clear({})).status, "cleared")
  } finally { await clipboard.dispose() }
  await assert.rejects(clipboard.read({}), /disposed/)
})

test("copied one-JS macOS provider embeds its real FFI worker with an empty executable PATH", async () => {
  const proofDirectory = await mkdtemp(join(tmpdir(), "standalone-macos-copied-"))
  try {
    const built = await build({
      stdin: { contents: `
        import assert from "node:assert/strict"
        import { createNativeClipboardWorker } from ${JSON.stringify(fileURLToPath(new URL("native-worker.mjs", import.meta.url)))}
        import source from "opencode:clipboard-macos-worker"
        const clipboard = await createNativeClipboardWorker(source, {
          libraries: Object.fromEntries(["objc", "appkit", "foundation", "imageio", "graphics"].map(name => [name, process.argv[2]])),
          pasteboardName: "copied-native-ABI-only"
        })
        try {
          assert.equal((await clipboard.writeText("copied native macOS 한글 👩🏽‍💻", {})).status, "written")
          const read = await clipboard.read({ preferredTypes: ["text/plain"] })
          assert.equal(read.status, "read")
          assert.equal(read.representation.bytes.toString(), "copied native macOS 한글 👩🏽‍💻")
          assert.equal((await clipboard.clear({})).status, "cleared")
          assert.equal((await clipboard.read({ preferredTypes: ["text/plain"] })).status, "empty")
          process.stdout.write(JSON.stringify({ embeddedWorker: true, nativeFFI: true, emptyPath: process.env.PATH === "" }) + "\\n")
        } finally { await clipboard.dispose() }
      `, sourcefile: "copied-macos-proof.mjs", resolveDir: fileURLToPath(new URL("./", import.meta.url)) },
      bundle: true, platform: "node", target: "node26", format: "esm", write: false,
      plugins: [clipboardWorkers()], minify: true, legalComments: "none", logLevel: "silent",
    })
    const filename = join(proofDirectory, "only.mjs")
    await writeFile(filename, built.outputFiles[0].contents)
    const result = await promisify(execFile)(process.execPath, ["--experimental-ffi", "--no-addons", filename, library], {
      cwd: proofDirectory, env: { PATH: "", HOME: proofDirectory, TMPDIR: proofDirectory }, maxBuffer: 1024 * 1024,
    })
    assert.deepEqual(JSON.parse(result.stdout), { embeddedWorker: true, nativeFFI: true, emptyPath: true })
  } finally { await rm(proofDirectory, { recursive: true, force: true }) }
})
