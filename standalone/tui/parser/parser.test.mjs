import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { bundleParserProof } from "./build.mjs"
import { bundleParserClientProof } from "./client-build.mjs"
import { adaptPublishedParserSource, adaptPublishedParserWorker } from "./adapt.mjs"

const execute = promisify(execFile)
const directory = dirname(fileURLToPath(import.meta.url))
const artifact = bundleParserProof(join(directory, ".cache/parser-test.mjs"))
const clientArtifact = await bundleParserClientProof(join(directory, ".cache/parser-client-test.mjs"))

// Each child compiles real Tree-sitter WASM, parses six grammars, and restarts its worker.
test("copied one-JS parser runs real highlights, Markdown injections and edits without runtime files", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-parser-single-"))
  try {
    const copied = join(root, "opencode-parser.mjs")
    await copyFile(await artifact, copied)
    const result = await execute(process.execPath, ["--no-addons", copied, join(root, "data")], { cwd: root, env: isolatedEnv(root), maxBuffer: 1024 * 1024 })
    assert.equal(result.stderr, "")
    const proof = JSON.parse(result.stdout)
    assert.equal(proof.workerTerminated, true)
    assert.equal(proof.results.length, 2)
    for (const result of proof.results) {
      assert.ok(result.javascriptCaptures > 0)
      assert.ok(result.markdownCaptures > result.javascriptCaptures)
      assert.ok(result.injectedCaptures > 0)
      assert.ok(result.incrementalLines > 0)
    }
    const files = await readdir(root, { recursive: true, withFileTypes: true })
    assert.deepEqual(files.filter((entry) => entry.isFile()).map((entry) => entry.name), ["opencode-parser.mjs"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("published TreeSitterClient runs from one copied JS with real highlights, edits and worker restart", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-parser-client-"))
  try {
    const copied = join(root, "opencode-parser.mjs")
    await copyFile(await clientArtifact, copied)
    const result = await execute(process.execPath, ["--no-addons", copied, join(root, "data")], { cwd: root, env: isolatedEnv(root), maxBuffer: 1024 * 1024 })
    assert.equal(result.stderr, "")
    const proof = JSON.parse(result.stdout)
    assert.equal(proof.actualClient, true)
    assert.equal(proof.workerRestarted, true)
    assert.ok(proof.javascriptCaptures > 0)
    assert.ok(proof.markdownCaptures > proof.javascriptCaptures)
    assert.ok(proof.incrementalLines > 0)
    const files = await readdir(root, { recursive: true, withFileTypes: true })
    assert.deepEqual(files.filter((entry) => entry.isFile()).map((entry) => entry.name), ["opencode-parser.mjs"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("published parser client keeps custom local and HTTP grammars and queries", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-parser-custom-"))
  const wasm = await readFile(join(dirname(fileURLToPath(import.meta.resolve("@opentui/core"))), "assets/javascript/tree-sitter-javascript.wasm"))
  const query = "(identifier) @standalone.custom\n"
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.end(request.url === "/parser.wasm" ? wasm : query)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const copied = join(root, "opencode-parser.mjs")
    const parser = join(root, "custom.wasm")
    const highlights = join(root, "custom.scm")
    await Promise.all([copyFile(await clientArtifact, copied), writeFile(parser, wasm), writeFile(highlights, query)])
    const url = `http://127.0.0.1:${server.address().port}`
    const result = await execute(process.execPath, ["--no-addons", copied, join(root, "data"), parser, highlights, url], { cwd: root, env: isolatedEnv(root), maxBuffer: 1024 * 1024 })
    assert.equal(result.stderr, "")
    assert.equal(JSON.parse(result.stdout).custom, true)
    assert.deepEqual(requests.sort(), ["/highlights.scm", "/parser.wasm"])
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test("published adapters patch the pinned seams and reject drift", async () => {
  const root = dirname(fileURLToPath(import.meta.resolve("@opentui/core")))
  for (const filename of ["chunk-node-p43t2gam.js", "chunk-node-2rg7pskw.js"]) {
    const source = await readFile(join(root, filename), "utf8")
    const adapted = adaptPublishedParserSource(filename, source)
    assert.notEqual(adapted, source)
    assert.throws(() => adaptPublishedParserSource(filename, adapted), /Pinned OpenTUI parser seam/)
  }
  const source = await readFile(join(root, "parser.worker.js"), "utf8")
  assert.ok(adaptPublishedParserWorker(source).includes("wasmBinary: embeddedParserBytes(treeWasm)"))
  assert.throws(() => adaptPublishedParserWorker(""), /Pinned OpenTUI parser seam/)
})

function isolatedEnv(root) {
  const env = { ...process.env, PATH: "", HOME: root, USERPROFILE: root, XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_CONFIG_HOME: join(root, "xdg-config"), TMPDIR: root, TMP: root, TEMP: root }
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "OTUI_ASSET_ROOT", "OTUI_TREE_SITTER_WORKER_PATH"]) delete env[name]
  return env
}

