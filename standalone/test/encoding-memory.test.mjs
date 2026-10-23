import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { promisify } from "node:util"
import { encodePayload } from "../scripts/encoding.mjs"

test("printable base95 agrees with the independent stuffed pair-coder wire bytes", () => {
  const encoded = encodePayload(Buffer.from(Array.from({ length: 65_536 }, (_, index) => index & 255)))
  assert.equal(encoded.length, 80_044)
  assert.equal(createHash("sha256").update(encoded).digest("hex"), "d8c0090a9ce037429adf1b97f674f6a3129d40d2798e1dac06188f86bfef0d4a")
})

test("printable base95 round-trips a browser-archive-sized binary with a 96 MiB Node heap", { timeout: 30_000 }, async () => {
  const result = await promisify(execFile)(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { randomBytes } from "node:crypto"
    import { alphabet, encodePayload, decodePayload } from ${JSON.stringify(new URL("../scripts/encoding.mjs", import.meta.url).href)}
    const bytes = randomBytes(24 * 1024 * 1024)
    const encoded = encodePayload(bytes)
    assert.ok(encoded.length > bytes.length)
    assert.ok(decodePayload(Buffer.from(encoded, "ascii"), bytes.length, alphabet).equals(bytes))
    console.log("large-binary-round-trip-ok")
  `], { env: { PATH: "" }, timeout: 25_000, maxBuffer: 65_536 })
  assert.equal(result.stdout.trim(), "large-binary-round-trip-ok")
})

test("printable base95 bounds worst-case comment escapes with a 96 MiB Node heap", { timeout: 30_000 }, async () => {
  const result = await promisify(execFile)(process.execPath, ["--no-addons", "--max-old-space-size=96", "--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { alphabet, encodePayload, decodePayload } from ${JSON.stringify(new URL("../scripts/encoding.mjs", import.meta.url).href)}
    // Independent prototype vector: these thirteen bytes produce eight raw
    // star/slash pairs, each requiring exactly one stuffed newline.
    const bytes = Buffer.alloc(13 * 512 * 1024, Buffer.from("9b65b36c96cdb25936cb66d92c", "hex"))
    const encoded = encodePayload(bytes)
    assert.equal(encoded, "*\\n/".repeat(4 * 1024 * 1024))
    assert.ok(decodePayload(Buffer.from(encoded, "ascii"), bytes.length, alphabet).equals(bytes))
    console.log("worst-case-escape-round-trip-ok")
  `], { env: { PATH: "" }, timeout: 25_000, maxBuffer: 65_536 })
  assert.equal(result.stdout.trim(), "worst-case-escape-round-trip-ok")
})
