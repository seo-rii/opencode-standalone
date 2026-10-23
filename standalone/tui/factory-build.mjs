import { createHash } from "node:crypto"
import { access, cp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, constants } from "node:zlib"
import { adaptImageSources } from "./image/source.mjs"
import { prepareTerminalSources } from "./terminal/source.mjs"

const directory = path.dirname(fileURLToPath(import.meta.url))
const cache = path.join(directory, ".cache")
const source = path.join(cache, "factory-source")
const prepared = path.join(cache, "renderer-source")
const manifest = JSON.parse(await readFile(path.join(directory, "sources.json"), "utf8"))
const terminalLicenses = await prepareTerminalSources(directory, manifest)
await access(path.join(prepared, "src/entry.zig")).catch(() => {
  throw new Error("Prepare the pinned upstream overlay first: run node renderer-build.mjs from standalone/tui; do not run overlay preparation concurrently with this build.")
})
await rm(source, { recursive: true, force: true })
await cp(prepared, source, { recursive: true })
// The separate synchronous owner has no OS thread identity. Guard the real
// checked ABI admission instead of calling unsupported WASI thread functions.
let guarded = 0
async function guards(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) { await guards(file); continue }
    if (!entry.name.endsWith(".zig")) continue
    const before = await readFile(file, "utf8")
    const count = before.split("std.Thread.getCurrentId()").length - 1
    if (!count) continue
    guarded += count
    await writeFile(file, before.replaceAll("std.Thread.getCurrentId()", '(if (@import("builtin").single_threaded) 0 else std.Thread.getCurrentId())'))
  }
}
await guards(path.join(source, "src"))
if (guarded === 0) throw new Error("Pinned checked-ABI thread guards no longer match")
// The private JSON reactor never exposes a native C pointer record to JS. Its
// checked wrappers compile their header records for WASM32; pointer-free scene
// staging still uses the original checked record parser and layout assertions.
const checkedFile = path.join(source, "src/context-abi.zig")
const checkedSource = await readFile(checkedFile, "utf8")
const nativePointerGuard = 'if (@sizeOf(usize) != 8) @compileError("The OpenTUI C ABI requires a 64-bit target");'
if (checkedSource.split(nativePointerGuard).length !== 2) throw new Error("Pinned checked-ABI pointer-width guard no longer matches")
const frameEncoder = "fn frameRequestToC(result: scene.FrameRequest) c.ot_scene_frame_request {"
if (checkedSource.split(frameEncoder).length !== 2) throw new Error("Pinned checked-ABI frame encoder no longer matches")
await writeFile(checkedFile, checkedSource.replace(nativePointerGuard, 'if (@sizeOf(usize) != 8 and builtin.cpu.arch != .wasm32) @compileError("The OpenTUI C ABI requires a 64-bit target");').replace(frameEncoder, "pub " + frameEncoder))
// This factory accepts the original host-paint recording format. The narrower
// computation proof deliberately excludes playback; enable the real decoder and
// player only in this separate overlay. Codec boundaries remain explicit below.
const recordingFile = path.join(source, "src/scene-record.zig")
const recordingSource = await readFile(recordingFile, "utf8")
const recordingGuard = 'pub fn play(owner: *Context, target: *buffer.OptimizedBuffer, floor: usize, bytes: []const u8, segment: Segment) !void {\n    if (@import("build_options").computational_only) return error.UnsupportedResource;'
if (recordingSource.split(recordingGuard).length !== 2) throw new Error("Pinned paint recording boundary no longer matches")
await writeFile(recordingFile, recordingSource.replace(recordingGuard, 'pub fn play(owner: *Context, target: *buffer.OptimizedBuffer, floor: usize, bytes: []const u8, segment: Segment) !void {'))
// Images use the actual vendored PNG/JPEG/GIF/WebP, ICC and resize C sources.
// Keep other computational-profile OS guards, and enable actual image scene
// paint only in this factory overlay after registering its portable codecs.
await adaptImageSources(source)
const sceneFile = path.join(source, "src/scene.zig")
const sceneSource = await readFile(sceneFile, "utf8")
const imagePaintGuard = 'fn paintImage(cli: *renderer.CliRenderer, state: ImageState, layout: Layout) !void {\n        if (@import("build_options").computational_only) return error.UnsupportedResource;'
if (sceneSource.split(imagePaintGuard).length !== 2) throw new Error("Pinned image scene paint boundary no longer matches")
await writeFile(sceneFile, sceneSource.replace(imagePaintGuard, 'fn paintImage(cli: *renderer.CliRenderer, state: ImageState, layout: Layout) !void {'))
await writeFile(path.join(source, "src/entry.zig"), `pub const context = @import("context.zig");
pub const scene = @import("scene.zig");
pub const buffer = @import("buffer.zig");
pub const session = @import("session.zig");
pub const checked = @import("context-abi.zig");
pub const output_checked = @import("context-output-abi.zig");
pub const editor_checked = @import("context-editor-abi.zig");
pub const text_checked = @import("context-text-abi.zig");
pub const unicode_checked = @import("context-unicode-abi.zig");
pub const image_checked = @import("context-image-abi.zig");
pub const terminal_checked = @import("context-terminal-abi.zig");
pub const image = @import("image.zig");
pub const abi = @import("context_abi_c");
`)
const zig = process.env.OPENCODE_ZIG ?? path.join(cache, "zig/zig")
const version = spawnSync(zig, ["version"], { encoding: "utf8" })
if (version.status !== 0 || version.stdout.trim() !== manifest.zig.version) throw new Error(`Expected Zig ${manifest.zig.version}; prepare with node renderer-build.mjs or set OPENCODE_ZIG`)
const built = spawnSync(zig, ["build", "-Dfactory=true", "factory", "-j2", "--prefix", path.join(cache, "factory-build"), "--cache-dir", path.join(cache, "factory-zig-build"), "--global-cache-dir", path.join(cache, "zig-global")], { cwd: directory, stdio: "inherit" })
if (built.status !== 0) throw new Error(`Factory reactor build failed (${built.status ?? built.signal})`)
const wasm = await readFile(path.join(cache, "factory-build/bin/opentui-factory.wasm"))
if (wasm.includes(Buffer.from(directory))) throw new Error("Factory reactor retained its private build root; check C/C++ source-prefix mapping")
const compressed = brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
const module = new WebAssembly.Module(wasm)
if (WebAssembly.Module.imports(module).some((entry) => entry.module !== "wasi_snapshot_preview1" && !(entry.module === "opentui_standalone" && entry.name === "scene_measure" && entry.kind === "function"))) throw new Error("Factory reactor unexpectedly requires an unknown host import")
if (!WebAssembly.Module.imports(module).some((entry) => entry.module === "opentui_standalone" && entry.name === "scene_measure" && entry.kind === "function")) throw new Error("Factory reactor is missing its synchronous Yoga measure boundary")
for (const name of ["memory", "_initialize", "factoryInputPointer", "factoryInputCapacity", "factoryOutputPointer", "factoryOutputLength", "factoryCall", "factoryBinaryReserve", "factoryBinaryPointer", "factoryBinaryLength", "factoryBinaryGeneration", "factoryBinaryOutputGeneration", "factoryBinaryRelease"]) {
  if (!WebAssembly.Module.exports(module).some((entry) => entry.name === name)) throw new Error(`Missing factory reactor export: ${name}`)
}
const licenses = await readFile(path.join(directory, "LICENSES.txt"), "utf8")
const yoga = await readFile(path.join(cache, "upstream/zig-deps/yoga/LICENSE"), "utf8")
const runtime = await readFile(path.join(directory, "renderer-runtime-LICENSES.txt"), "utf8")
const imageLicenses = await readFile(path.join(directory, "image/LICENSES.txt"), "utf8")
const generated = path.join(cache, `factory-wasm-${process.pid}.mjs`)
await writeFile(generated, `/*!\n${(licenses + "\n\nYoga\n====\n" + yoga + "\n\n" + runtime + "\n\n" + imageLicenses + "\n\n" + terminalLicenses).replaceAll("*/", "* /")}\n*/\n// Generated by standalone/tui/factory-build.mjs; do not edit.\n// OpenTUI ${manifest.opentuiVersion} ${manifest.opentuiCommit}\n// WASM SHA-256: ${createHash("sha256").update(wasm).digest("hex")}\nexport const factoryWasmBrotliBase64 = ${JSON.stringify(compressed.toString("base64"))}\n`)
await rename(generated, path.join(directory, "factory-wasm.mjs"))
console.log(JSON.stringify({ wasmBytes: wasm.length, brotliBytes: compressed.length, guardedThreadCalls: guarded, imports: WebAssembly.Module.imports(module) }))
