import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bundleBackend } from "./build.mjs"
import { checkPublishedLargeImages } from "./image-large-proof.mjs"
import { checkPublishedImages, checkPublishedImageScene } from "./image-proof.mjs"

const temporary = await mkdtemp(join(tmpdir(), "opencode-public-images-"))
const artifact = await bundleBackend(join(temporary, "core.mjs"), { entry: fileURLToPath(new URL("./image-large-demo.mjs", import.meta.url)) })
const api = await import(pathToFileURL(artifact))
after(() => rm(temporary, { recursive: true, force: true }))

test("published NativeImage codecs, exact Context clones, write-through leases and pooled updates", { timeout: 30_000 }, () => {
  assert.deepEqual(checkPublishedImages(api), { formats: 17, zeroCopy: true, crossContextMetadata: true, pooledUpdates: true })
})

test("published ImageRenderable paints actual retained native images and resizes", { timeout: 30_000 }, async () => {
  assert.deepEqual(await checkPublishedImageScene(api), { nativeImageScene: true, retainedAfterSourceDisposal: true, resized: true })
})

// These cases transfer >64MiB several times and encode/decode a noisy PNG.
test("published large images preserve PNG bytes, Context clones, pixel leases and padded updates", { timeout: 60_000 }, () => {
  checkLargeResult(checkPublishedLargeImages(api))
})

test("copied one-JS public image classes render without PATH, addons or external files", { timeout: 30_000 }, async () => {
  const directory = join(temporary, "isolated")
  await mkdir(directory)
  const artifact = await bundleBackend(join(directory, "opentui-images.mjs"), { entry: fileURLToPath(new URL("./image-demo.mjs", import.meta.url)) })
  const result = spawnSync(process.execPath, ["--no-addons", artifact], {
    cwd: directory,
    env: { PATH: "", HOME: directory, USERPROFILE: directory, NODE_NO_WARNINGS: "1" },
    encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || `Image proof exited with ${result.signal}`)
  assert.match(result.stderr, /^(?:"WASI is an experimental feature and might change at any time"\r?\n)?$/)
  assert.deepEqual(JSON.parse(result.stdout), {
    images: { formats: 17, zeroCopy: true, crossContextMetadata: true, pooledUpdates: true },
    scene: { nativeImageScene: true, retainedAfterSourceDisposal: true, resized: true },
  })
})

test("copied one-JS public images transfer >64MiB without PATH, addons or external files", { timeout: 60_000 }, async () => {
  const directory = join(temporary, "large-isolated")
  await mkdir(directory)
  const artifact = await bundleBackend(join(directory, "opentui-large-images.mjs"), { entry: fileURLToPath(new URL("./image-large-demo.mjs", import.meta.url)) })
  const result = spawnSync(process.execPath, ["--no-addons", artifact], {
    cwd: directory,
    env: { PATH: "", HOME: directory, USERPROFILE: directory, NODE_NO_WARNINGS: "1" },
    encoding: "utf8", timeout: 55_000, maxBuffer: 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || `Large image proof exited with ${result.signal}`)
  assert.match(result.stderr, /^(?:"WASI is an experimental feature and might change at any time"\r?\n)?$/)
  checkLargeResult(JSON.parse(result.stdout).largeImages)
})

function checkLargeResult(result) {
  assert.ok(result.encodedBytes > 4 * 1024 * 1024)
  assert.deepEqual(result, { encodedBytes: result.encodedBytes, rawBytes: 67_125_248, originalPng: true, crossContextPixels: true, grewWithLease: true, paddedCopy: true, pooledUpdate: true, recovered: true })
}
