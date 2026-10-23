import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { parseBuildProfile, distributionDirectory } from "../scripts/profiles.mjs"

test("standalone profiles preserve other arguments and select separate distributions", () => {
  assert.deepEqual(parseBuildProfile([]), { profile: "full", args: [] })
  assert.deepEqual(parseBuildProfile(["--repack", "--profile", "full"]), { profile: "full", args: ["--repack"] })
  assert.deepEqual(parseBuildProfile(["--profile", "lite", "--repack"]), { profile: "lite", args: ["--repack"] })
  assert.deepEqual(parseBuildProfile(["--serial", "--profile=lite"]), { profile: "lite", args: ["--serial"] })
  assert.deepEqual(parseBuildProfile(["--profile=lite", "--profile", "lite"]), { profile: "lite", args: [] })
  assert.deepEqual(parseBuildProfile(["--", "--profile=lite"]), { profile: "full", args: ["--", "--profile=lite"] })
  const args = ["--profile=lite", "--test-name-pattern=selected artifact"]
  assert.deepEqual(parseBuildProfile(args), { profile: "lite", args: ["--test-name-pattern=selected artifact"] })
  assert.deepEqual(args, ["--profile=lite", "--test-name-pattern=selected artifact"])
  const root = path.join(tmpdir(), "standalone-profile-paths")
  assert.equal(distributionDirectory(root), path.join(root, "dist"))
  assert.equal(distributionDirectory(root, "full"), path.join(root, "dist"))
  assert.equal(distributionDirectory(root, "lite"), path.join(root, "dist", "lite"))
})

test("standalone profiles reject missing, unknown, and conflicting values", () => {
  for (const args of [["--profile"], ["--profile="], ["--profile", "--repack"]]) assert.throws(() => parseBuildProfile(args), /Missing.*profile/)
  for (const value of ["default", "small", "LITE", "../lite", "=lite"]) {
    assert.throws(() => parseBuildProfile(["--profile=" + value]), /Unknown.*profile/)
    assert.throws(() => distributionDirectory(".", value), /Unknown.*profile/)
  }
  assert.throws(() => parseBuildProfile(["--profile=full", "--profile", "lite"]), /Conflicting.*profiles/)
  assert.throws(() => parseBuildProfile(["--profile", "lite", "--profile=full"]), /Conflicting.*profiles/)
})

test("test and verify runners use the selected artifact and preserve the other profile receipt", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-profiles-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all(["scripts", "test", "filesystem", "git", "pty", "persistent-pty", "tui", "web", "dist/lite"].map(folder => mkdir(path.join(directory, folder), { recursive: true })))
  await Promise.all(["profiles.mjs", "tests.mjs", "test.mjs", "verify.mjs"].map(file => copyFile(new URL("../scripts/" + file, import.meta.url), path.join(directory, "scripts", file))))
  await writeFile(path.join(directory, "test", "selected.test.mjs"), `
    import assert from "node:assert/strict"
    import { readFile } from "node:fs/promises"
    import path from "node:path"
    import { test } from "node:test"
    test("selected artifact", async () => {
      const profile = process.env.EXPECTED_PROFILE
      const artifact = process.env.OPENCODE_STANDALONE_ARTIFACT
      assert.equal(await readFile(artifact, "utf8"), profile)
      assert.equal(path.basename(path.dirname(artifact)), profile === "lite" ? "lite" : "dist")
    })
  `)
  for (const profile of ["full", "lite"]) {
    const distribution = distributionDirectory(directory, profile)
    const bytes = Buffer.from(profile)
    const report = { artifact: "opencode-standalone.js", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
    // Existing full artifacts predate profiles and remain valid unchanged.
    if (profile === "lite") report.profile = "lite"
    await writeFile(path.join(distribution, "opencode-standalone.js"), bytes)
    await writeFile(path.join(distribution, "build-report.json"), JSON.stringify(report))
  }
  let fullReceipt
  for (const profile of ["full", "lite"]) {
    const options = {
      cwd: directory,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, EXPECTED_PROFILE: profile, OPENCODE_STANDALONE_ARTIFACT: path.join(directory, "wrong-artifact.js") },
      timeout: 15_000,
      maxBuffer: 65_536,
    }
    const profileArgs = profile === "full" ? [] : ["--profile=lite"]
    const tested = await promisify(execFile)(process.execPath, ["scripts/test.mjs", ...profileArgs, "--test-name-pattern=selected artifact"], options)
    assert.match(tested.stdout, /selected artifact/)
    const verified = await promisify(execFile)(process.execPath, ["scripts/verify.mjs", ...profileArgs, "--serial"], options)
    assert.match(verified.stdout, /# pass 1/)
    const receiptPath = path.join(distributionDirectory(directory, profile), "verification.json")
    const receiptBytes = await readFile(receiptPath, "utf8")
    const receipt = JSON.parse(receiptBytes)
    assert.equal(receipt.profile, profile)
    assert.equal(receipt.exitCode, 0)
    assert.equal(receipt.concurrency, 1)
    assert.deepEqual(receipt.counts, { tests: 1, pass: 1, fail: 0, skipped: 0 })
    assert.deepEqual(receipt.tests, [path.join("test", "selected.test.mjs")])
    assert.equal(receipt.sha256, createHash("sha256").update(profile).digest("hex"))
    if (profile === "full") fullReceipt = receiptBytes
    if (profile === "lite") assert.equal(await readFile(path.join(directory, "dist", "verification.json"), "utf8"), fullReceipt)
  }
  const liteReportPath = path.join(directory, "dist", "lite", "build-report.json")
  const liteReceiptPath = path.join(directory, "dist", "lite", "verification.json")
  const verifiedReceipt = await readFile(liteReceiptPath, "utf8")
  const liteReport = JSON.parse(await readFile(liteReportPath, "utf8"))
  for (const [change, expected] of [[{ profile: "full" }, /profile/], [{ profile: undefined }, /profile/], [{ sha256: "0".repeat(64) }, /hash/], [{ bytes: 123 }, /size/]]) {
    await writeFile(liteReportPath, JSON.stringify({ ...liteReport, ...change }))
    await assert.rejects(promisify(execFile)(process.execPath, ["scripts/verify.mjs", "--profile", "lite"], { cwd: directory, timeout: 10_000 }), expected)
    assert.equal(await readFile(liteReceiptPath, "utf8"), verifiedReceipt)
    assert.equal(await readFile(path.join(directory, "dist", "verification.json"), "utf8"), fullReceipt)
  }
})
