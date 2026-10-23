import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseBuildProfile } from "./profiles.mjs"

const { profile, args } = parseBuildProfile(process.argv.slice(2))
if (args.length) throw new Error("Usage: node scripts/build-all.mjs [--profile full|lite]")
const directory = fileURLToPath(new URL("../", import.meta.url))
for (const args of [
  ["scripts/prepare.mjs"],
  ...(profile === "full" ? [["--max-old-space-size=4096", "web/build.mjs"]] : []),
  ["--max-old-space-size=4096", "scripts/build.mjs", "--profile", profile],
]) {
  const child = spawn(process.execPath, args, { cwd: directory, stdio: "inherit" })
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  if (result.code !== 0) throw new Error(`Build step ${args.find((argument) => argument.endsWith(".mjs"))} failed (${result.signal ?? result.code})`)
}
