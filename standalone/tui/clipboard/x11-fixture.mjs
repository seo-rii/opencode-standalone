import { randomBytes } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const directory = dirname(fileURLToPath(import.meta.url))
const execute = promisify(execFile)

/** Dev-only isolated server and independent Xlib peer; production only imports x11.mjs. */
export async function startX11Fixture(root, options = {}) {
  await mkdir(root, { recursive: true })
  const authority = join(root, "Xauthority")
  const cookie = randomBytes(16)
  const auth = (number) => Buffer.concat([Buffer.from([255, 255]), ...["", String(number), "MIT-MAGIC-COOKIE-1", cookie].flatMap((value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    const length = Buffer.alloc(2); length.writeUInt16BE(bytes.length)
    return [length, bytes]
  })])
  await writeFile(authority, auth(""), { mode: 0o600 })
  const binary = join(root, "x11-native-peer")
  await execute(process.env.CC ?? "cc", ["-O2", "-Wall", "-Wextra", join(directory, "x11-peer.c"), "-lX11", "-o", binary], { timeout: 20_000 })
  const server = spawn(process.env.OPENCODE_TEST_XVFB ?? "Xvfb", ["-displayfd", "1", "-screen", "0", "128x128x24", "-auth", authority, options.tcp ? "-listen" : "-nolisten", "tcp", "-noreset"], { stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  server.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-4096) })
  const ready = Promise.withResolvers()
  const displayLines = createInterface({ input: server.stdout })
  displayLines.once("line", (line) => ready.resolve(line))
  server.once("error", ready.reject)
  server.once("exit", (code) => ready.reject(new Error(`Isolated Xvfb exited ${code}: ${stderr}`)))
  const number = await deadline(ready.promise, "Xvfb startup")
  await writeFile(authority, auth(number), { mode: 0o600 })
  const env = { ...process.env, DISPLAY: `:${number}`, XAUTHORITY: authority }
  delete env.WAYLAND_DISPLAY
  delete env.WAYLAND_SOCKET
  const peers = new Set()
  async function peer() {
    const child = spawn(binary, [], { env, stdio: ["pipe", "pipe", "pipe"] })
    const lines = []
    const waiters = []
    const requested = Promise.withResolvers()
    let error = ""
    const reader = createInterface({ input: child.stdout })
    reader.on("line", (line) => waiters.length ? waiters.shift().resolve(line) : lines.push(line))
    child.stderr.on("data", (bytes) => {
      error = (error + bytes).slice(-4096)
      if (error.includes("REQUEST\n")) requested.resolve()
    })
    const exited = Promise.withResolvers()
    child.once("error", (failure) => { for (const waiter of waiters) waiter.reject(failure); exited.resolve() })
    child.once("exit", (code, signal) => {
      for (const waiter of waiters) waiter.reject(new Error(`Xlib peer exited ${code}/${signal}: ${error}`))
      exited.resolve()
    })
    const next = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    const result = {
      requested: requested.promise,
      command(line) { child.stdin.write(line + "\n"); return deadline(next(), "Xlib command") },
      async dispose() {
        peers.delete(result)
        if (child.exitCode === null && child.signalCode === null) { child.stdin.end("QUIT\n"); await deadline(exited.promise, "Xlib peer cleanup").catch(() => { child.kill("SIGKILL") }) }
        reader.close()
      },
    }
    peers.add(result)
    if (await deadline(next(), "Xlib initialization") !== "READY") throw new Error("Xlib peer initialization failed")
    return result
  }
  return {
    env,
    async owner({ selection = "clipboard", offers, stall = false, incremental = false }) {
      const native = await peer()
      const entries = offers.map((offer) => `${offer.mimeType}\t${Buffer.from(offer.bytes).toString("base64") || "="}`)
      if (await native.command(`OWN\t${selection.toUpperCase()}\t${Number(stall)}\t${incremental === "no-hint" ? 2 : Number(incremental)}\t${entries.join("\t")}`) !== "OK") throw new Error("Xlib selection ownership failed")
      return native
    },
    async read({ selection = "clipboard", target = "UTF8_STRING" } = {}) {
      const native = await peer()
      try {
        const response = await native.command(`READ\t${selection.toUpperCase()}\t${target}`)
        if (response === "NONE") return null
        if (!response.startsWith("DATA\t")) throw new Error(`Unexpected Xlib peer response: ${response}`)
        return new Uint8Array(Buffer.from(response.slice(5), "base64"))
      } finally { await native.dispose() }
    },
    async selectionOwner(selection = "clipboard") {
      const native = await peer()
      try { return Number((await native.command(`OWNER\t${selection.toUpperCase()}`)).split("\t")[1]) } finally { await native.dispose() }
    },
    async dispose() {
      await Promise.all([...peers].map((native) => native.dispose()))
      const stopped = Promise.withResolvers()
      server.once("exit", stopped.resolve)
      if (server.exitCode === null && server.signalCode === null) { server.kill("SIGTERM"); await deadline(stopped.promise, "Xvfb cleanup") }
      displayLines.close()
    },
  }
}

function deadline(promise, operation) {
  const timer = setTimeout(() => deferred.reject(new Error(`${operation} exceeded 10 seconds`)), 10_000)
  const deferred = Promise.withResolvers()
  promise.then(deferred.resolve, deferred.reject).finally(() => clearTimeout(timer))
  return deferred.promise
}
