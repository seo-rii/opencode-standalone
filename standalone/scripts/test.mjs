import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { testFiles } from "./tests.mjs"

const directory = fileURLToPath(new URL("../", import.meta.url))
const child = spawn(process.execPath, ["--experimental-ffi", "--test", "--test-concurrency=2", ...process.argv.slice(2), ...await testFiles(directory)], {
  cwd: directory, stdio: "inherit",
})
child.once("error", (error) => { console.error(error.message); process.exitCode = 1 })
child.once("exit", (code) => { process.exitCode = code ?? 1 })
