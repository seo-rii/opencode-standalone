import assert from "node:assert/strict"
import { build } from "esbuild"
import { execFile } from "node:child_process"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createNativeClipboardWorker } from "./native-worker.mjs"

const directory = fileURLToPath(new URL("./", import.meta.url))
const runner = join(directory, "worker-entry.mjs")
const fixture = join(directory, "worker-fixture.mjs")
const source = (await build({
  stdin: { contents: `import { serveNativeClipboardWorker } from ${JSON.stringify(runner)}; import { createClipboardWorkerFixture } from ${JSON.stringify(fixture)}; serveNativeClipboardWorker(createClipboardWorkerFixture);`, resolveDir: directory },
  bundle: true, platform: "node", format: "cjs", target: "node26", write: false, minify: true, keepNames: true,
})).outputFiles[0].text

test("embedded native worker serializes mutations, keeps full u32 deadlines and cleans up idempotently", async () => {
  const service = await createNativeClipboardWorker(source)
  try {
    const writes = await Promise.all(["first", "second 한국어", "last"].map((text) => service.writeText(text, { timeoutMs: 0xffffffff })))
    assert.deepEqual(writes, [{ status: "written" }, { status: "written" }, { status: "written" }])
    const read = await service.read({ timeoutMs: 0xffffffff })
    assert.equal(read.representation.bytes.toString(), "last")
    assert.deepEqual(await service.read({ timeoutMs: 0 }), { status: "timed-out" })
    assert.deepEqual(await service.read({ signal: AbortSignal.abort() }), { status: "cancelled" })
    assert.deepEqual(await service.clear({}), { status: "cleared" })
  } finally {
    const disposal = service.dispose()
    assert.equal(disposal, service.dispose())
    await disposal
  }
  await assert.rejects(service.read({}), /disposed/)
})

test("blocked native worker cancels promptly and retains bounded admission until native reply", async () => {
  const gate = new Int32Array(new SharedArrayBuffer(8))
  const service = await createNativeClipboardWorker(source, { gate: gate.buffer, maxConcurrentOperations: 1 })
  const controller = new AbortController()
  try {
    const read = service.read({ signal: controller.signal, timeoutMs: 5000 })
    await started(gate)
    controller.abort()
    assert.deepEqual(await read, { status: "cancelled" })
    const rejected = await service.writeText("cannot bypass outstanding native call", {})
    assert.equal(rejected.status, "failed")
    assert.equal(rejected.error.code, "CLIPBOARD_OPERATION_LIMIT")
  } finally {
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0)
    await service.dispose()
  }
})

test("native mutation committed before abort preserves written result over cancellation", async () => {
  const gate = new Int32Array(new SharedArrayBuffer(8))
  const service = await createNativeClipboardWorker(source, { gate: gate.buffer, mutation: true })
  const controller = new AbortController()
  try {
    const operation = { signal: controller.signal, timeoutMs: 5000 }
    const write = service.writeText("committed 한국어", operation)
    await started(gate)
    controller.abort()
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0)
    assert.deepEqual(await write, { status: "written" })
    assert.equal(operation.mutationCommitted, true)
    assert.equal((await service.read({})).representation.bytes.toString(), "committed 한국어")
  } finally {
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0)
    await service.dispose()
  }
})

test("an expired queued mutation cannot change the clipboard when a blocked native read returns", async () => {
  const gate = new Int32Array(new SharedArrayBuffer(8))
  const service = await createNativeClipboardWorker(source, { gate: gate.buffer })
  try {
    const read = service.read({ timeoutMs: 5000 })
    await started(gate)
    assert.deepEqual(await service.writeText("expired queued write", { timeoutMs: 1 }), { status: "timed-out" })
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0)
    assert.equal((await read).representation.bytes.toString(), "worker 한국어")
    assert.equal((await service.read({})).representation.bytes.toString(), "worker 한국어")
  } finally {
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0)
    await service.dispose()
  }
})

test("copied single JS runs its embedded worker with an empty PATH and no adjacent files", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-native-clipboard-worker-"))
  try {
    const result = await build({
      stdin: { contents: `
        import assert from "node:assert/strict";
        import { setImmediate } from "node:timers/promises";
        import { createNativeClipboardWorker } from ${JSON.stringify(join(directory, "native-worker.mjs"))};
        const source = ${JSON.stringify(source)};
        const service = await createNativeClipboardWorker(source);
        try { const read = await service.read({}); process.stdout.write(read.representation.bytes); }
        finally { await service.dispose(); }
        const gate = new Int32Array(new SharedArrayBuffer(8));
        const blocked = await createNativeClipboardWorker(source, { gate: gate.buffer, cleanupDelay: 50 });
        const read = blocked.read({ timeoutMs: 5000 });
        while (!Atomics.load(gate, 1)) await setImmediate();
        const disposal = blocked.dispose();
        assert.equal((await read).status, "cancelled");
        Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
        await disposal;
        process.stdout.write("; disposed");
      `, resolveDir: directory },
      bundle: true, platform: "node", format: "esm", target: "node26", write: false, minify: true, keepNames: true,
    })
    const artifact = join(root, "clipboard.mjs")
    await writeFile(artifact, result.outputFiles[0].text)
    const env = { ...process.env, PATH: "", HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root }
    for (const key of ["NODE_OPTIONS", "NODE_PATH"]) delete env[key]
    const child = await promisify(execFile)(process.execPath, ["--no-addons", artifact], { cwd: root, env, timeout: 10_000 })
    assert.equal(child.stdout, "worker 한국어; disposed")
    assert.equal(child.stderr, "")
    assert.deepEqual(await readdir(root), ["clipboard.mjs"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function started(gate) {
  const deadline = performance.now() + 5000
  while (Atomics.load(gate, 1) !== 1) {
    assert.ok(performance.now() < deadline, "Worker must enter its blocking call")
    await setImmediate()
  }
}
