import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bundleBackend } from "./build.mjs"
import { checkPublishedTerminalResources, checkPublishedTerminalScene } from "./terminal-proof.mjs"

const temporary = await mkdtemp(join(tmpdir(), "opencode-public-terminals-"))
const artifact = await bundleBackend(join(temporary, "core.mjs"), { entry: fileURLToPath(new URL("./terminal-entry.mjs", import.meta.url)) })
const api = await import(pathToFileURL(artifact))
after(() => rm(temporary, { recursive: true, force: true }))

test("published terminal controller preserves real Ghostty VT, modes, owned IO and checked lifetimes", { timeout: 30_000 }, () => {
  checkResources(checkPublishedTerminalResources(api))
})

for (const width of [44, 100]) {
  test(`published EmbeddedTerminalRenderable paints, forwards input and resizes at ${width} columns`, { timeout: 30_000 }, async () => {
    checkScene(await checkPublishedTerminalScene(api, width), width)
  })
}

test("copied one-JS embedded terminal renders real VT without PATH, addons or external files", { timeout: 30_000 }, async () => {
  const directory = join(temporary, "isolated")
  await mkdir(directory)
  const artifact = await bundleBackend(join(directory, "opentui-terminals.mjs"), { entry: fileURLToPath(new URL("./terminal-demo.mjs", import.meta.url)) })
  const result = spawnSync(process.execPath, ["--no-addons", artifact], {
    cwd: directory, env: { PATH: "", HOME: directory, USERPROFILE: directory, NODE_NO_WARNINGS: "1" },
    encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || `Terminal proof exited with ${result.signal}`)
  assert.match(result.stderr, /^(?:"WASI is an experimental feature and might change at any time"\r?\n)?$/)
  const output = JSON.parse(result.stdout)
  checkResources(output.resources)
  assert.equal(output.scenes.length, 2)
  checkScene(output.scenes[0], 44)
  checkScene(output.scenes[1], 100)
})

function checkResources(result) {
  assert.deepEqual(result, { realGhostty: true, ownedBytes: true, parserChunks: true, selection: true, palette: true, inputModes: true, scrollback: true, checkedLifetime: true })
}

function checkScene(result, width) {
  assert.deepEqual(result, { width, nativeScene: true, unicode: true, selection: true, parsedInput: true, mouse: true, scrollback: true, resized: true, clipped: true, destroyed: true })
}
