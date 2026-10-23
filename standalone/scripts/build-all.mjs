import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("../", import.meta.url))
for (const args of [
  ["scripts/prepare.mjs"],
  ["--max-old-space-size=4096", "web/build.mjs"],
  ["--max-old-space-size=4096", "scripts/build.mjs"],
]) {
  const child = spawn(process.execPath, args, { cwd: directory, stdio: "inherit" })
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  if (result.code !== 0) throw new Error(`Build step ${args.at(-1)} failed (${result.signal ?? result.code})`)
}
