import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { alphabet, encodePayload, decodePayload } from "../scripts/encoding.mjs"
import { packArtifact } from "../scripts/pack.mjs"

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

for (const compressed of [false, true]) test(`packed artifact reads ${compressed ? "Brotli" : "raw"} binary payloads and dispatches from a copied UTF-8 JS file`, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-pack-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = randomBytes(65_536)
  const packed = packArtifact({ name: "한글 metadata" }, {
    app: { bytes: `import { expose } from "opencode-standalone:tui"; const bytes = globalThis[Symbol.for("opencode.standalone.web-archive")](); const loaded = await import("opencode-standalone:tui"); if (loaded.expose !== expose) throw new Error("Embedded module identity changed"); console.log(expose(bytes).toString("hex"))` },
    pty: { bytes: 'console.log("pty-helper")' },
    daemon: { bytes: 'console.log("persistent-pty-daemon")' },
    tui: { bytes: "export const expose = (bytes) => bytes" },
    web: { bytes, compressed },
    licenses: { bytes: "embedded license 한글" },
  })
  const executable = path.join(directory, "standalone.js")
  await writeFile(executable, packed.bytes)
  assert.equal(Buffer.from(packed.bytes.toString("utf8")).equals(packed.bytes), true)
  for (const [args, expected] of [[[], bytes.toString("hex")], [["--standalone-pty-exec"], "pty-helper"], [["--standalone-persistent-pty-daemon"], "persistent-pty-daemon"], [["--standalone-licenses"], "embedded license 한글"]]) {
    const result = spawnSync(process.execPath, ["--no-addons", "--experimental-ffi", executable, ...args], {
      cwd: directory, env: { PATH: "", HOME: directory }, encoding: "utf8", timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), expected)
  }
})
