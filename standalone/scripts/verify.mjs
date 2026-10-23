import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { testFiles } from "./tests.mjs"
import { parseBuildProfile, distributionDirectory } from "./profiles.mjs"

const directory = fileURLToPath(new URL("../", import.meta.url))
const { profile, args } = parseBuildProfile(process.argv.slice(2))
const distribution = distributionDirectory(directory, profile)
const artifact = path.join(distribution, "opencode-standalone.js")
const report = JSON.parse(await readFile(path.join(distribution, "build-report.json"), "utf8"))
if ((report.profile === undefined ? "full" : report.profile) !== profile) throw new Error("Build-report profile does not match requested profile")
const artifactBytes = await readFile(artifact)
const hash = createHash("sha256").update(artifactBytes).digest("hex")
if (hash !== report.sha256) throw new Error("Artifact hash does not match build-report.json; rebuild before verification")
if (artifactBytes.length !== report.bytes) throw new Error("Artifact size does not match build-report.json; rebuild before verification")
const tests = await testFiles(directory)
if (!tests.length) throw new Error("No standalone verification tests found")
const concurrency = args.includes("--serial") ? 1 : 2
const started = new Date().toISOString()
// Integration files start real CLI/server/PTY processes and bundle the actual
// published renderer. Bound concurrent files instead of scaling to host CPUs.
const child = spawn(process.execPath, ["--experimental-ffi", "--test", `--test-concurrency=${concurrency}`, "--test-reporter=tap", ...tests], {
  cwd: directory,
  env: { ...process.env, OPENCODE_STANDALONE_ARTIFACT: artifact },
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  process.stdout.write(chunk)
  output = (output + chunk).slice(-50_000)
})
const result = await new Promise((resolve, reject) => {
  child.once("error", reject)
  child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }))
})
const counts = Object.fromEntries(["tests", "pass", "fail", "skipped"].map((name) => [name, Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? 0)]))
await writeFile(path.join(distribution, "verification.json"), JSON.stringify({
  profile,
  started, finished: new Date().toISOString(), node: process.version, platform: process.platform,
  arch: process.arch, artifact: path.basename(artifact), bytes: artifactBytes.length, sha256: hash, ...result, counts, tests,
  concurrency, fullParity: false,
}, null, 2) + "\n")
process.exitCode = result.exitCode ?? 1
