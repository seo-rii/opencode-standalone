import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { testFiles } from "./tests.mjs"
import { parseBuildProfile, distributionDirectory } from "./profiles.mjs"

const directory = fileURLToPath(new URL("../", import.meta.url))
const { profile, args } = parseBuildProfile(process.argv.slice(2))
const artifact = path.join(distributionDirectory(directory, profile), "opencode-standalone.js")
const child = spawn(process.execPath, ["--experimental-ffi", "--test", "--test-concurrency=2", ...args, ...await testFiles(directory)], {
  cwd: directory, env: { ...process.env, OPENCODE_STANDALONE_ARTIFACT: artifact }, stdio: "inherit",
})
child.once("error", (error) => { console.error(error.message); process.exitCode = 1 })
child.once("exit", (code) => { process.exitCode = code ?? 1 })
