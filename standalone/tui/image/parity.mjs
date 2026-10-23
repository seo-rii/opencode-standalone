import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { createImageTransport } from "./runtime.mjs"
import { runImageScenarios } from "./scenarios.mjs"

const directory = dirname(fileURLToPath(import.meta.url))

/** Replay the exact live WASM calls through the pinned native codec executable. */
export function verifyNativeImageTrace(trace) {
  const result = spawnSync(join(directory, "../.cache/image-build/bin/opentui-images-reference"), [], {
    input: trace.map((entry) => JSON.stringify(entry.request)).join("\n") + "\n",
    encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || `Native image oracle exited with ${result.signal}`)
  const actual = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(actual.length, trace.length)
  for (let index = 0; index < actual.length; index++) {
    const expected = { status: trace[index].status, response: trace[index].response }
    assert.deepEqual(normalize(actual[index]), normalize(expected), `Native image request ${index}: ${JSON.stringify(trace[index].request).slice(0, 200)}`)
  }
  return { requests: trace.length }
}

function normalize(result) {
  if (!result.response?.lease || !Number.isInteger(result.response.pixels)) return result
  return { ...result, response: { ...result.response, pixels: "<owned-pixel-pointer>" } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtures = JSON.parse(await readFile(join(directory, "fixtures.json"), "utf8"))
  const result = runImageScenarios(createImageTransport(), fixtures)
  console.log(JSON.stringify({ ...verifyNativeImageTrace(result.trace), captures: result.captures.length, icc: result.stats }))
}
