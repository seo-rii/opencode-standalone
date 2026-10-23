import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { once } from "node:events"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Worker } from "node:worker_threads"
import { alphabet, encodePayload, decodePayload } from "../scripts/encoding.mjs"
import { decodePackedPayload, packArtifact } from "../scripts/pack.mjs"

test("compact payload encoding preserves all bytes and never closes its JS comment", () => {
  assert.equal(alphabet.length, 95)
  assert.equal(new Set(alphabet).size, 95)
  assert.equal(alphabet[0], " ")
  assert.ok(alphabet.includes("*") && alphabet.includes("/") && alphabet.includes("\\"))
  const cases = [Buffer.alloc(0), Buffer.from(Array.from({ length: 256 }, (_, index) => index)), randomBytes(65_536)]
  for (let size = 1; size <= 100; size++) cases.push(randomBytes(size))
  for (const input of cases) {
    const encoded = encodePayload(input)
    assert.match(encoded, /^[\x20-\x7e\n]*$/u)
    assert.doesNotMatch(encoded, /\*\//u)
    assert.deepEqual(decodePayload(Buffer.from(encoded, "ascii"), input.length, alphabet), input)
  }
  for (const invalid of [0, 9, 10, 13, 31, 127, 255]) assert.throws(() => decodePayload(Buffer.from([invalid]), 1, alphabet), /Invalid/)
  assert.throws(() => decodePayload(Buffer.from(encodePayload(Buffer.from("data"))), 5, alphabet), /Truncated/)
  assert.throws(() => decodePayload(Buffer.from(encodePayload(Buffer.from("data"))), 3, alphabet), /exceeds/)
})

test("comment escapes preserve every two-byte input and reject malformed stuffing", () => {
  const bytes = Buffer.alloc(2)
  for (let value = 0; value < 65_536; value++) {
    bytes.writeUInt16LE(value)
    const encoded = encodePayload(bytes)
    assert.doesNotMatch(encoded, /\*\//u)
    assert.deepEqual(decodePayload(Buffer.from(encoded, "ascii"), bytes.length, alphabet), bytes)
  }
  const escaped = encodePayload(Buffer.from("9b65b36c96cdb25936cb66d92c", "hex"))
  assert.equal(escaped, "*\n/".repeat(8))
  // Independent vectors cross a pair boundary and the final short tail.
  for (const [hex, expected] of [["b6e301", " *\n/ "], ["e863b3", "R**\n/"]]) {
    const input = Buffer.from(hex, "hex")
    assert.equal(encodePayload(input), expected)
    assert.deepEqual(decodePayload(Buffer.from(expected, "ascii"), input.length, alphabet), input)
  }
  for (const malformed of ["\n", "*\n", "\n/", "*\n?", "*\n\n/", "*\r\n/", "*\n /", " \n ", "*/"]) {
    assert.throws(() => decodePayload(Buffer.from(malformed, "ascii"), 1, alphabet), /Invalid|Unescaped/)
  }
})

for (const encoding of ["base95", "utf8-words", "utf8-ans"]) for (const compressed of [false, true]) test(`${encoding} artifact reads ${compressed ? "Brotli" : "raw"} payloads from copied CommonJS and ESM files`, { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-pack-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = randomBytes(65_536)
  const metadata = { name: "한글 metadata", symbol: "🙂" }
  const inputs = {
    app: { bytes: `import { expose } from "opencode-standalone:tui"; const bytes = globalThis[Symbol.for("opencode.standalone.web-archive")](); const loaded = await import("opencode-standalone:tui"); if (loaded.expose !== expose) throw new Error("Embedded module identity changed"); console.log(expose(bytes).toString("hex"))` },
    pty: { bytes: 'console.log("pty-helper")' },
    daemon: { bytes: 'console.log("persistent-pty-daemon")' },
    tui: { bytes: "export const expose = (bytes) => bytes" },
    web: { bytes, compressed },
    licenses: { bytes: "embedded license 한글" },
  }
  const packed = packArtifact(metadata, inputs, encoding === "base95" ? {} : { encoding })
  assert.equal(Buffer.from(packed.bytes.toString("utf8")).equals(packed.bytes), true)
  const base = Number(packed.bytes.subarray(0, 20_000).toString("utf8").match(/const base = Number\("(\d+)"\)/)[1])
  for (const [name, entry] of Object.entries(packed.records)) {
    assert.equal(entry.encoding, encoding)
    const stored = packed.bytes.subarray(base + entry.offset, base + entry.offset + entry.length)
    assert.deepEqual(decodePackedPayload(stored, entry), Buffer.from(inputs[name].bytes))
  }
  for (const extension of ["cjs", "mjs"]) {
    const executable = path.join(directory, `standalone.${extension}`)
    await writeFile(executable, packed.bytes)
    const checked = spawnSync(process.execPath, ["--check", executable], { encoding: "utf8", timeout: 10_000 })
    assert.equal(checked.status, 0, checked.stderr)
    for (const [args, expected] of [[[], bytes.toString("hex")], [["--standalone-pty-exec"], "pty-helper"], [["--standalone-persistent-pty-daemon"], "persistent-pty-daemon"], [["--standalone-licenses"], "embedded license 한글"]]) {
      const result = spawnSync(process.execPath, ["--no-addons", "--experimental-ffi", executable, ...args], {
        cwd: directory, env: { PATH: "", HOME: directory }, encoding: "utf8", timeout: 10_000,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), expected)
    }
    const info = spawnSync(process.execPath, [executable, "--standalone-info"], { encoding: "utf8", timeout: 10_000 })
    assert.equal(info.status, 0, info.stderr)
    assert.deepEqual(JSON.parse(info.stdout), metadata)
    const worker = new Worker(executable, {
      argv: ["--standalone-licenses"], execArgv: ["--no-addons", "--experimental-ffi"], stdout: true, stderr: true,
    })
    t.after(() => worker.terminate())
    let output = "", errors = ""
    worker.stdout.setEncoding("utf8").on("data", (data) => { output += data })
    worker.stderr.setEncoding("utf8").on("data", (data) => { errors += data })
    const [code] = await once(worker, "exit")
    assert.equal(code, 0, errors)
    assert.equal(output.trim(), "embedded license 한글")
  }
})

test("packed-payload tooling rejects unknown codecs and inconsistent records", () => {
  assert.throws(() => packArtifact({}, {}, { encoding: "unknown" }), /encoding/)
  assert.throws(() => decodePackedPayload(Buffer.alloc(0), { encoding: "unknown", length: 0 }), /encoding/)
  for (const encoding of ["base95", "utf8-words", "utf8-ans"]) {
    const packed = packArtifact({}, { app: { bytes: "payload", compressed: false } }, { encoding })
    const base = Number(packed.bytes.subarray(0, 20_000).toString("utf8").match(/const base = Number\("(\d+)"\)/)[1])
    const entry = packed.records.app
    const stored = packed.bytes.subarray(base + entry.offset, base + entry.offset + entry.length)
    assert.throws(() => decodePackedPayload(stored.subarray(1), entry), /Truncated/)
    assert.throws(() => decodePackedPayload(stored, { ...entry, bytes: entry.bytes + 1 }), /size/)
  }
})
