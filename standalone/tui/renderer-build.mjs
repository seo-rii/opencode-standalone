import { createHash } from "node:crypto"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
const cache = join(directory, ".cache")
const upstream = join(cache, "upstream")
const manifest = JSON.parse(await readFile(join(directory, "sources.json"), "utf8"))
await mkdir(upstream, { recursive: true })
await download(manifest.renderer.url, join(upstream, "opentui.tar.gz"), manifest.renderer.sha256)
const source = join(cache, "renderer-source")
await rm(source, { recursive: true, force: true })
await mkdir(source, { recursive: true })
run("tar", ["-xzf", join(upstream, "opentui.tar.gz"), "-C", source, "--strip-components=3", `opentui-${manifest.opentuiCommit}/packages/native/src`, `opentui-${manifest.opentuiCommit}/packages/native/include`])
const deps = manifest.sources.find((source) => source.path === "zig-deps.tar.gz")
await download(deps.url, join(upstream, deps.path), deps.sha256)
await mkdir(join(upstream, "zig-deps"), { recursive: true })
run("tar", ["-xzf", join(upstream, deps.path), "-C", join(upstream, "zig-deps"), "uucode-opentui", "yoga"])

// Contexts and streams in this reactor have one synchronous owner. The original
// process-wide runtime starts native I/O and cannot be used by a WASM reactor.
await writeFile(join(source, "src/runtime.zig"), `const std = @import("std");
pub fn allocator() std.mem.Allocator { return if (@import("builtin").cpu.arch == .wasm32) std.heap.wasm_allocator else std.heap.page_allocator; }
pub fn io() std.Io { return std.Io.failing; }
`)
// Preserve the full 64-bit, non-wrapping identity space. wasm32 baseline has no
// atomic u64 operations. The native oracle uses this same single-owner branch.
await patch("context-handles.zig", "        var id = last_context_id.load(.monotonic);", `        var id = if (@import("builtin").single_threaded) last_context_id.raw else last_context_id.load(.monotonic);`)
await patch("context-handles.zig", "            if (last_context_id.cmpxchgWeak(id, id + 1, .monotonic, .monotonic)) |current| {", `            if (@import("builtin").single_threaded) {
                last_context_id.raw = id + 1;
                break;
            }
            if (last_context_id.cmpxchgWeak(id, id + 1, .monotonic, .monotonic)) |current| {`)
// The narrow bridge never creates audio/clipboard objects. Keep those native
// worker lifecycles out of this build, for both targets, rather than emulating
// workers or returning successful service results. Unsupported creation is not
// exported; encountering such an object internally is an invariant violation.
await patch("context.zig", 'const std = @import("std");', 'const std = @import("std");\nconst computational_only = @import("build_options").computational_only;')
await patch("context.zig", "        var clipboard_cursor: usize = 0;", "        if (!computational_only) {\n        var clipboard_cursor: usize = 0;")
await patch("context.zig", "        if (!clipboard_ready) return error.ContextBusy;", "        if (!clipboard_ready) return error.ContextBusy;\n        }")
await patch("context.zig", "            .audio_engine => audio.destroy(@ptrCast(@alignCast(token.ptr))),", "            .audio_engine => if (computational_only) unreachable else audio.destroy(@ptrCast(@alignCast(token.ptr))),")
await patch("context.zig", "            .clipboard_service => {", "            .clipboard_service => if (computational_only) unreachable else {", 2)
await patch("context.zig", "            .clipboard_operation => {", "            .clipboard_operation => if (computational_only) unreachable else {", 2)
// Recording is not exposed by this checkpoint. Widen command-size arithmetic so
// importing the real Scene type is valid on wasm32 as well as native. The
// existing record-length comparison remains in u64, including padding.
await patch("scene-record.zig", `comptime {
    std.debug.assert(@sizeOf(usize) >= 8); // commandSize adds up to four u32 lengths.
}

`, "")
await patch("scene-record.zig", "fn commandSize(operation: u32, body: []const u8) !usize", "fn commandSize(operation: u32, body: []const u8) !u64")
await patch("scene-record.zig", "@as(usize, draw.struct_size)", "@as(u64, draw.struct_size)")
await patch("scene-record.zig", "@as(usize, value.column_count)", "@as(u64, value.column_count)")
await patch("scene-record.zig", "@as(usize, value.byte_count)", "@as(u64, value.byte_count)", 2)
await patch("scene-record.zig", "@as(usize, value.sample_count)", "@as(u64, value.sample_count)")
await patch("scene-record.zig", "@as(usize, value.mask_count)", "@as(u64, value.mask_count)")
await patch("scene-record.zig", "std.mem.alignForward(usize, try commandSize", "std.mem.alignForward(u64, try commandSize")
await patch("scene-record.zig", "pub fn play(owner: *Context, target: *buffer.OptimizedBuffer, floor: usize, bytes: []const u8, segment: Segment) !void {", `pub fn play(owner: *Context, target: *buffer.OptimizedBuffer, floor: usize, bytes: []const u8, segment: Segment) !void {
    if (@import("build_options").computational_only) return error.UnsupportedResource;`)
await patch("scene.zig", "    fn paintImage(cli: *renderer.CliRenderer, state: ImageState, layout: Layout) !void {", `    fn paintImage(cli: *renderer.CliRenderer, state: ImageState, layout: Layout) !void {
        if (@import("build_options").computational_only) return error.UnsupportedResource;`)
// Do not publish the raw native-pointer Stream ABI as incidental WASM exports.
await patch("native-span-feed.zig", "pub export fn ", "pub fn ", 12)
await patch("yoga.zig", "export fn ", "fn ", 94)
// The reactor uses FeedBackend; BufferedBackend worker joins cannot run in
// this synchronous profile. Preserve teardown and assert the no-worker contract.
await patch("renderer-output.zig", "if (self.renderThread) |thread| {", `if (@import("build_options").computational_only) {
            std.debug.assert(self.renderThread == null);
        } else if (self.renderThread) |thread| {`, 2)
await writeFile(join(source, "src/entry.zig"), `pub const context = @import("context.zig");
pub const scene = @import("scene.zig");
pub const buffer = @import("buffer.zig");
`)
const zig = process.env.OPENCODE_ZIG ?? join(cache, "zig", "zig")
if (!(await access(zig).then(() => true, () => false))) {
  if (process.env.OPENCODE_ZIG || process.platform !== "linux" || process.arch !== "x64") throw new Error(`Set OPENCODE_ZIG to Zig ${manifest.zig.version}.`)
  await download(manifest.zig.url, join(cache, "zig.tar.xz"), manifest.zig.sha256)
  await mkdir(join(cache, "zig"), { recursive: true })
  run("tar", ["-xJf", join(cache, "zig.tar.xz"), "-C", join(cache, "zig"), "--strip-components=1"])
}
const version = spawnSync(zig, ["version"], { encoding: "utf8" })
if (version.status !== 0 || version.stdout.trim() !== manifest.zig.version) throw new Error(`Expected Zig ${manifest.zig.version}`)
run(zig, ["build", "-Drenderer=true", "renderer", "-j2", "--prefix", join(cache, "renderer-build"), "--cache-dir", join(cache, "renderer-zig-build"), "--global-cache-dir", join(cache, "zig-global")])
const wasm = await readFile(join(cache, "renderer-build/bin/opentui-renderer.wasm"))
const module = new WebAssembly.Module(wasm)
const exports = WebAssembly.Module.exports(module).map((entry) => entry.name)
for (const name of ["memory", "_initialize", "rendererInputPointer", "rendererInputCapacity", "rendererOutputPointer", "rendererOutputLength", "rendererCall"]) {
  if (!exports.includes(name)) throw new Error(`Missing computational reactor export: ${name}`)
}
const licenses = await readFile(join(directory, "LICENSES.txt"), "utf8")
const yogaLicense = await readFile(join(upstream, "zig-deps/yoga/LICENSE"), "utf8")
const runtimeLicenses = await readFile(join(directory, "renderer-runtime-LICENSES.txt"), "utf8")
await writeFile(join(directory, "renderer-wasm.mjs"), `/*!\n${(licenses + "\n\nYoga\n====\n" + yogaLicense + "\n\n" + runtimeLicenses).replaceAll("*/", "* /")}\n*/\n// Generated by standalone/tui/renderer-build.mjs; do not edit.\n// OpenTUI ${manifest.opentuiVersion} ${manifest.opentuiCommit}\n// WASM SHA-256: ${createHash("sha256").update(wasm).digest("hex")}\nexport const rendererWasmBase64 = ${JSON.stringify(wasm.toString("base64"))}\n`)
console.log(JSON.stringify({ wasmBytes: wasm.length, imports: WebAssembly.Module.imports(module) }))

async function patch(path, before, after, count = 1) {
  const filename = join(source, "src", path)
  const contents = await readFile(filename, "utf8")
  if (contents.split(before).length !== count + 1) throw new Error(`Pinned source patch did not match exactly once: ${path}`)
  await writeFile(filename, contents.replaceAll(before, after))
}

async function download(url, destination, sha256) {
  const existing = await readFile(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error
  })
  const bytes = existing ?? Buffer.from(await fetch(url).then((response) => {
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
    return response.arrayBuffer()
  }))
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`Source checksum mismatch: ${destination}`)
  if (!existing) await writeFile(destination, bytes)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: directory, stdio: "inherit" })
  if (result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status ?? result.signal})`)
}
