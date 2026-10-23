import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const artifact = process.env.OPENCODE_STANDALONE_ARTIFACT ?? fileURLToPath(new URL("../dist/opencode-standalone.js", import.meta.url))

export async function sandbox(t, config = {}, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-standalone-test-"))
  const children = new Set()
  t.after(async () => {
    await Promise.all([...children].map((child) => child.stop()))
    await rm(root, { recursive: true, force: true })
  })
  const paths = Object.fromEntries(
    ["bin", "project", "home", "cache", "config", "data", "state", "tmp"].map((name) => [name, path.join(root, name)]),
  )
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory)))
  const executable = path.join(paths.bin, "opencode-standalone.js")
  await copyFile(options.artifact ?? artifact, executable)
  assert.deepEqual(await readdir(paths.bin), ["opencode-standalone.js"])
  const password = randomUUID()
  const env = {
    // Inherit no user config, provider credentials, proxies, NODE_OPTIONS, or module search paths.
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
    PATH: "",
    SHELL: "/bin/sh",
    HOME: paths.home,
    USERPROFILE: paths.home,
    PWD: paths.project,
    TMPDIR: paths.tmp,
    TEMP: paths.tmp,
    TMP: paths.tmp,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    OPENCODE_TEST_HOME: paths.home,
    OPENCODE_CONFIG_DIR: path.join(paths.config, "opencode"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DB: path.join(paths.data, "opencode.db"),
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  }
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }

  function launch(args, options = {}) {
    const child = spawn(process.execPath, ["--no-addons", ...(options.ffi === false ? [] : ["--experimental-ffi"]), executable, ...args], {
      cwd: paths.project,
      env: { ...env, ...options.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const events = new EventEmitter()
    const output = { stdout: "", stderr: "" }
    let closed = false
    let error
    for (const stream of ["stdout", "stderr"]) {
      child[stream].setEncoding("utf8")
      child[stream].on("data", (chunk) => {
        const next = output[stream] + chunk
        output[stream] = next.length > 262_144 ? `${next.slice(0, 131_072)}\n[output truncated]\n${next.slice(-131_072)}` : next
        events.emit("output")
      })
    }
    child.on("error", (value) => {
      error = value
    })
    const exit = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        closed = true
        resolve({ code, signal, error, ...output })
        events.emit("output")
      })
    })
    const running = {
      child,
      output,
      exit,
      async stop() {
        if (closed) return
        const kill = (signal) => {
          try {
            if (process.platform === "win32") child.kill(signal)
            else process.kill(-child.pid, signal)
          } catch (cause) {
            if (cause.code !== "ESRCH") throw cause
          }
        }
        kill("SIGTERM")
        const timer = setTimeout(() => kill("SIGKILL"), 3_000)
        try {
          await deadline(exit, 10_000, () => `Child did not stop\n${diagnostic(output)}`)
        } finally {
          clearTimeout(timer)
        }
      },
      async waitFor(pattern) {
        const match = () => pattern.exec(output.stdout + "\n" + output.stderr)
        if (match()) return match()
        let listener
        try {
          return await deadline(
            new Promise((resolve, reject) => {
              listener = () => {
                const found = match()
                if (found) return resolve(found)
                if (closed) reject(new Error(`Child exited before ${pattern}\n${diagnostic(output)}`))
              }
              events.on("output", listener)
              listener()
            }),
            45_000,
            () => `Child did not emit ${pattern}\n${diagnostic(output)}`,
          )
        } finally {
          events.off("output", listener)
        }
      },
    }
    children.add(running)
    return running
  }

  async function run(args, options) {
    const child = launch(args, options)
    const result = await deadline(child.exit, 60_000, () => `Command did not finish\n${diagnostic(child.output)}`)
    assert.equal(result.error, undefined, diagnostic(result))
    assert.equal(result.code, 0, diagnostic(result))
    return result
  }

  async function serve(options = {}) {
    const process = launch(["serve", "--hostname", "127.0.0.1", "--port", "0"], options)
    const match = await process.waitFor(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)
    const url = match[1]
    const request = (route, options = {}) => fetch(new URL(route, url), {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(10_000),
    })
    const json = async (route) => {
      const response = await request(route)
      assert.equal(response.status, 200, `${route}: ${await response.clone().text()}\n${diagnostic(process.output)}`)
      return response.json()
    }
    return { ...process, url, json, request }
  }

  return { root, paths, executable, env, run, serve }
}

export function diagnostic(output) {
  // Preserve an exception's leading message even when its Data-URL stack is megabytes long.
  const bounded = (value) => {
    const clean = value.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "<embedded-bundle>")
    return clean.length > 12_000 ? `${clean.slice(0, 6_000)}\n[output truncated]\n${clean.slice(-6_000)}` : clean
  }
  return `stdout:\n${bounded(output.stdout)}\nstderr:\n${bounded(output.stderr)}`
}

export function deadline(promise, milliseconds, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
