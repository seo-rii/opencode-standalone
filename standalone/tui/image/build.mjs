import { createHash } from "node:crypto"
import { access, cp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, constants } from "node:zlib"
import { adaptImageSources } from "./source.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const tui = dirname(directory)
const cache = join(tui, ".cache")
const prepared = join(cache, "renderer-source")
const source = join(cache, "image-source")
const manifest = JSON.parse(await readFile(join(tui, "sources.json"), "utf8"))
await access(join(prepared, "src/entry.zig")).catch(() => {
  throw new Error("Prepare the pinned renderer overlay first with node tui/renderer-build.mjs; do not prepare that overlay concurrently with this build.")
})
const archive = join(cache, "upstream/opentui.tar.gz")
if (createHash("sha256").update(await readFile(archive)).digest("hex") !== manifest.renderer.sha256) throw new Error("Pinned OpenTUI source archive checksum mismatch")
await rm(source, { recursive: true, force: true })
await cp(prepared, source, { recursive: true })
// Cached computation overlays carry deliberate platform adapters. Re-extract
// every image implementation and vendor directory from the verified archive
// so no previous proof/factory codec guard or edited cache can replace them.
const prefix = `opentui-${manifest.opentuiCommit}/packages/native/src/`
const codecs = spawnSync("tar", ["-xzf", archive, "-C", source, "--strip-components=3", ...[
  "image.zig", "context-image-abi.zig", "image-shim.c", "image-resize-shim.c", "image-webp-config.c", "image-webp-sse41.c", "image-webp-avx2.c", "vendor/wuffs", "vendor/stb", "vendor/lcms2", "vendor/libwebp",
].map((path) => prefix + path)], { stdio: "inherit" })
if (codecs.status !== 0) throw new Error("Cannot extract pinned image implementations")
await adaptImageSources(source)
async function guards(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) { await guards(file); continue }
    if (!entry.name.endsWith(".zig")) continue
    const contents = await readFile(file, "utf8")
    if (contents.includes("std.Thread.getCurrentId()")) await writeFile(file, contents.replaceAll("std.Thread.getCurrentId()", '(if (@import("builtin").single_threaded) 0 else std.Thread.getCurrentId())'))
  }
}
await guards(join(source, "src"))
const checked = join(source, "src/context-abi.zig")
const contents = await readFile(checked, "utf8")
const guard = 'if (@sizeOf(usize) != 8) @compileError("The OpenTUI C ABI requires a 64-bit target");'
if (contents.split(guard).length !== 2) throw new Error("Pinned checked ABI width guard no longer matches")
await writeFile(checked, contents.replace(guard, 'if (@sizeOf(usize) != 8 and builtin.cpu.arch != .wasm32) @compileError("The OpenTUI C ABI requires a 64-bit target");'))
await writeFile(join(source, "src/entry.zig"), `pub const context = @import("context.zig");
pub const scene = @import("scene.zig");
pub const buffer = @import("buffer.zig");
pub const checked = @import("context-abi.zig");
pub const image_checked = @import("context-image-abi.zig");
pub const image = @import("image.zig");
pub const abi = @import("context_abi_c");
`)
const licenseFiles = ["wuffs/LICENSE", "stb/LICENSE", "lcms2/LICENSE", "libwebp/COPYING", "libwebp/PATENTS"]
const licenseParts = await Promise.all(licenseFiles.map(async (file) => `${file}\n${"=".repeat(file.length)}\n${await readFile(join(source, "src/vendor", file), "utf8")}`))
const licenses = licenseParts.join("\n\n")
await writeFile(join(directory, "LICENSES.txt"), licenses)
const fixtures = {}
for (const name of ["rgba.png", "baseline.jpg", "halves.jpg", "progressive.jpg", "orientation.jpg", "lossless.webp", "lossy.webp", "alpha.webp", "first-frame.gif", "transparent.gif"]) {
  const file = `opentui-${manifest.opentuiCommit}/packages/core/src/tests/fixtures/images/${name}`
  const extracted = spawnSync("tar", ["-xOzf", archive, file], { maxBuffer: 8 * 1024 * 1024 })
  if (extracted.status !== 0) throw new Error(`Cannot extract pinned image fixture ${name}`)
  fixtures[name] = extracted.stdout.toString("base64")
}
for (const name of ["display-p3", "display-p3-rgba", "display-p3-palette", "display-p3-palette-alpha", "gray-profile", "gray-alpha-profile", "srgb-profile"]) {
  fixtures[`${name}.png`] = (await readFile(join(source, `src/tests/fixtures/${name}.png.base64`), "utf8")).trim()
}
await writeFile(join(directory, "fixtures.json"), JSON.stringify(fixtures, null, 2) + "\n")
const zig = process.env.OPENCODE_ZIG ?? join(cache, "zig/zig")
const version = spawnSync(zig, ["version"], { encoding: "utf8" })
if (version.status !== 0 || version.stdout.trim() !== manifest.zig.version) throw new Error(`Expected Zig ${manifest.zig.version}`)
const built = spawnSync(zig, ["build", "-Dimages=true", "images", "-j2", "--prefix", join(cache, "image-build"), "--cache-dir", join(cache, "image-zig-build"), "--global-cache-dir", join(cache, "zig-global")], { cwd: tui, stdio: "inherit" })
if (built.status !== 0) throw new Error(`Image reactor build failed (${built.status ?? built.signal})`)
const wasm = await readFile(join(cache, "image-build/bin/opentui-images.wasm"))
const module = new WebAssembly.Module(wasm)
if (WebAssembly.Module.imports(module).some((entry) => entry.module !== "wasi_snapshot_preview1")) throw new Error("Image reactor unexpectedly requires a codec or native host import")
for (const name of ["memory", "_initialize", "imageInputPointer", "imageInputCapacity", "imageOutputPointer", "imageOutputLength", "imageCall"]) {
  if (!WebAssembly.Module.exports(module).some((entry) => entry.name === name)) throw new Error(`Missing image reactor export ${name}`)
}
const compressed = brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
const mainLicense = await readFile(join(tui, "LICENSES.txt"), "utf8")
const yogaLicense = await readFile(join(cache, "upstream/zig-deps/yoga/LICENSE"), "utf8")
const runtimeLicense = await readFile(join(tui, "renderer-runtime-LICENSES.txt"), "utf8")
await writeFile(join(directory, "wasm.mjs"), `/*!\n${(mainLicense + "\n\nYoga\n====\n" + yogaLicense + "\n\n" + runtimeLicense + "\n\n" + licenses).replaceAll("*/", "* /")}\n*/\n// Generated by tui/image/build.mjs; OpenTUI ${manifest.opentuiVersion} ${manifest.opentuiCommit}.\n// WASM SHA-256: ${createHash("sha256").update(wasm).digest("hex")}\nexport const imageWasmBrotliBase64 = ${JSON.stringify(compressed.toString("base64"))}\n`)
console.log(JSON.stringify({ wasmBytes: wasm.length, brotliBytes: compressed.length, imports: WebAssembly.Module.imports(module), fixtures: Object.keys(fixtures).length }))
