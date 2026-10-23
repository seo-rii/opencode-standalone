import { spawn } from "node:child_process"
import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.argv[2] === "--worker") {
  const [, , , status, command, ...args] = process.argv
  const child = spawn(command, args, { stdio: "inherit" })
  child.once("error", (error) => {
    console.error(error.message)
    writeFileSync(status, JSON.stringify({ exitCode: 1, error: error.message }) + "\n", { mode: 0o600 })
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    writeFileSync(status, JSON.stringify({ exitCode: code, signal }) + "\n", { mode: 0o600 })
    process.exitCode = code ?? 1
  })
} else {
  const [, , label, command, ...args] = process.argv
  if (!label || !command) throw new Error("Usage: node scripts/run-logged.mjs <label> <command> [args...]")
  const directory = path.join(homedir(), "logs")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
  const base = path.join(directory, `opencode-standalone-${label.replaceAll(/[^a-z0-9-]/gi, "-")}-${stamp}`)
  const log = base + ".log"
  const status = base + ".status.json"
  const descriptor = openSync(log, "wx", 0o600)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", status, command, ...args], {
    stdio: ["ignore", descriptor, descriptor],
    detached: true,
  })
  closeSync(descriptor)
  child.unref()
  console.log(JSON.stringify({ pid: child.pid, log, status }))
}
