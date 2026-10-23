import assert from "node:assert/strict"
import { build } from "esbuild"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { standalonePackagePlugin } from "./backend/package.mjs"
import { adaptPublishedClipboardSource } from "./clipboard.mjs"

const execute = promisify(execFile)
const directory = dirname(fileURLToPath(import.meta.url))

test("published clipboard factory seam rejects drift and leaves upstream policies intact", async () => {
  const filename = join(dirname(fileURLToPath(import.meta.resolve("@opentui/core"))), "chunk-node-2rg7pskw.js")
  const source = await readFile(filename, "utf8")
  const adapted = adaptPublishedClipboardSource(filename, source)
  assert.ok(adapted.includes("createStandaloneHostClipboardBackend(options)"))
  assert.ok(adapted.includes("createHostClipboardWithBackend(options, createNativeHostClipboardBackend)"))
  assert.throws(() => adaptPublishedClipboardSource(filename, adapted), /Pinned OpenTUI clipboard factory/)
  assert.throws(() => adaptPublishedClipboardSource(filename, ""), /Pinned OpenTUI clipboard factory/)
  assert.equal(adaptPublishedClipboardSource("other.js", source), source)
})

test("headless host provider keeps disposal and cancellation explicit", async () => {
  const result = await execute(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { createStandaloneHostClipboardBackend } from ${JSON.stringify(new URL("./clipboard.mjs", import.meta.url).href)}
    const backend = createStandaloneHostClipboardBackend()
    assert.deepEqual(await backend.read({}), { status: "unsupported" })
    assert.deepEqual(await backend.writeText("not stored", {}), { status: "unsupported" })
    assert.deepEqual(await backend.read({}), { status: "unsupported" })
    assert.deepEqual(await backend.clear({}), { status: "unsupported" })
    assert.deepEqual(await backend.read({ signal: AbortSignal.abort() }), { status: "cancelled" })
    const disposal = backend.dispose()
    assert.equal(backend.dispose(), disposal)
    await disposal
    await assert.rejects(backend.read({}), /disposed/)
    await assert.rejects(backend.writeText("a", {}), /disposed/)
    await assert.rejects(backend.clear({}), /disposed/)
  `], { env: headlessEnvironment(), timeout: 5000 })
  assert.equal(result.stderr, "")
})

// This child executes the published clipboard policies, real renderer and WASM feed together.
test("copied one-JS clipboard keeps validation, cancellation, deadlines and real terminal OSC 52 fallback", { timeout: 30_000 }, async () => {
  const cache = join(directory, ".cache/clipboard")
  const root = await mkdtemp(join(tmpdir(), "opencode-clipboard-"))
  try {
    await mkdir(cache, { recursive: true })
    const artifact = join(cache, "proof.mjs")
    const result = await build({
      entryPoints: [join(directory, "clipboard-proof.mjs")], outfile: artifact,
      bundle: true, platform: "node", format: "esm", target: "node26", keepNames: true,
      legalComments: "inline", metafile: true, logLevel: "warning", external: ["bun:*"],
      plugins: [
        { name: "clipboard-host-seams", setup(bundle) {
          bundle.onResolve({ filter: /^virtual:standalone-tui-factory-wasm$/ }, () => ({ path: join(directory, "factory-wasm.mjs") }))
          bundle.onResolve({ filter: /^opencode:tui-clipboard$/ }, () => ({ path: join(directory, "clipboard.mjs") }))
        } },
        await standalonePackagePlugin({ transform: adaptPublishedClipboardSource }),
      ],
    })
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) assert.ok(isBuiltin(dependency.path), `Unexpected runtime dependency: ${dependency.path}`)
    }
    const copied = join(root, "opencode-clipboard.mjs")
    await copyFile(artifact, copied)
    const env = { ...headlessEnvironment(), PATH: "", HOME: root, USERPROFILE: root, XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), TMPDIR: root, TMP: root, TEMP: root }
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "OTUI_ASSET_ROOT", "OTUI_TREE_SITTER_WORKER_PATH"]) delete env[name]
    const proof = await execute(process.execPath, ["--no-addons", "--disable-warning=ExperimentalWarning", copied], { cwd: root, env, maxBuffer: 1024 * 1024, timeout: 20_000 })
    assert.equal(proof.stderr, "")
    assert.deepEqual(JSON.parse(proof.stdout), { validation: true, unsupported: true, cancelled: true, timedOut: true, disposed: true, actualRenderer: true, nativeOsc52: true })
    const files = await readdir(root, { recursive: true, withFileTypes: true })
    assert.deepEqual(files.filter((entry) => entry.isFile()).map((entry) => entry.name), ["opencode-clipboard.mjs"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function headlessEnvironment() {
  const env = { ...process.env }
  for (const name of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_RUNTIME_DIR"]) delete env[name]
  return env
}
