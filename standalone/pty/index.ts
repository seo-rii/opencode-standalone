import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { accessSync, closeSync, constants, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { ReadStream } from "node:tty"
import { getSystemErrorName } from "node:util"
import type { Disp, Exit, Opts, Proc } from "../../packages/core/src/pty/pty.ts"

export type { Disp, Exit, Opts, Proc } from "../../packages/core/src/pty/pty.ts"

export const helperFlag = "--standalone-pty-exec"

type FFI = {
  dlopen(
    path: string | null,
    definitions: Record<string, { arguments: string[]; return: string }>,
  ): {
    lib: { close(): void }
    functions: Record<string, (...args: Array<number | bigint | Uint8Array | null>) => number | bigint>
  }
  getInt32(pointer: number | bigint): number
}

let native: ReturnType<typeof loadNative> | undefined

/** The executable entry must dispatch helperFlag before loading the application. */
export function spawn(file: string, args: string[], opts: Opts): Proc & {
  onBinaryData(listener: (data: Uint8Array) => void): Disp
  onProcessExit(listener: (event: Exit) => void): Disp
  writeBinary(data: Uint8Array): void
  pause(): void
  resume(): void
} {
  const binding = (native ??= loadNative())
  const size = windowSize(opts.cols ?? 80, opts.rows ?? 24)
  const cwd = path.resolve(opts.cwd ?? process.cwd())
  if (!statSync(cwd).isDirectory()) throw Object.assign(new Error(`PTY cwd is not a directory: ${cwd}`), { code: "ENOTDIR" })
  const env = { ...(opts.env ?? process.env), TERM: opts.name }
  const executable = resolveExecutable(file, env, cwd)
  if (!process.argv[1]) throw new Error("PTY requires an executable JavaScript entry file")

  const master = Buffer.alloc(4)
  const slave = Buffer.alloc(4)
  if (binding.functions.openpty(master, slave, null, null, size) !== 0) throw binding.error("openpty")
  const masterFD = master.readInt32LE()
  const slaveFD = slave.readInt32LE()
  const stream = (() => {
    try {
      return new ReadStream(masterFD, { readable: true, writable: true })
    } catch (error) {
      closeSync(masterFD)
      closeSync(slaveFD)
      throw error
    }
  })()
  const child = (() => {
    try {
      return childProcess.spawn(
        process.execPath,
        [
          ...process.execArgv,
          path.resolve(process.argv[1]),
          helperFlag,
          JSON.stringify({ file: executable, args }),
        ],
        { cwd, env, detached: true, stdio: [slaveFD, slaveFD, slaveFD] },
      )
    } catch (error) {
      stream.destroy()
      throw error
    } finally {
      closeSync(slaveFD)
    }
  })()

  const events = new EventEmitter()
  let exited: Exit | undefined
  let closed = false
  let notified = false
  let drain: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    if (!exited || !closed || notified) return
    notified = true
    clearTimeout(drain)
    events.emit("exit", exited)
    events.removeAllListeners()
  }
  const decoder = new TextDecoder()
  stream.on("data", (data: Buffer) => {
    events.emit("binaryData", data)
    const decoded = decoder.decode(data, { stream: true })
    if (decoded) events.emit("data", decoded)
  })
  // A Linux PTY reports EIO when the last slave closes. The stream's close
  // event completes exit notification after all already-read output is delivered.
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EIO") child.kill("SIGHUP")
  })
  stream.once("end", () => stream.destroy())
  stream.once("close", () => {
    const decoded = decoder.decode()
    if (decoded) events.emit("data", decoded)
    closed = true
    finish()
  })
  child.once("error", (error) => {
    events.emit("data", `PTY startup failed: ${error.message}\r\n`)
    exited = { exitCode: 127 }
    stream.destroy()
  })
  child.once("exit", (code, signal) => {
    exited = { exitCode: code ?? 0, ...(signal ? { signal } : {}) }
    events.emit("processExit", exited)
    finish()
    // A detached grandchild can retain the slave after the shell exits.
    // Bound that drain while letting normal EOF deliver output immediately.
    if (!closed) drain = setTimeout(() => stream.destroy(), 200).unref()
  })

  return {
    pid: child.pid ?? -1,
    onData(listener) {
      events.on("data", listener)
      return { dispose: () => void events.off("data", listener) }
    },
    onBinaryData(listener) {
      events.on("binaryData", listener)
      return { dispose: () => void events.off("binaryData", listener) }
    },
    onProcessExit(listener) {
      events.on("processExit", listener)
      return { dispose: () => void events.off("processExit", listener) }
    },
    onExit(listener) {
      events.on("exit", listener)
      return { dispose: () => void events.off("exit", listener) }
    },
    write(data) {
      if (exited || closed) return
      stream.write(data)
    },
    writeBinary(data) {
      if (exited || closed) return
      stream.write(data)
    },
    pause() {
      stream.pause()
    },
    resume() {
      if (!closed) stream.resume()
    },
    resize(cols, rows) {
      if (exited || closed) return
      if (binding.functions.ioctl(masterFD, binding.resize, windowSize(cols, rows)) !== 0)
        throw binding.error("TIOCSWINSZ")
    },
    kill(signal = "SIGHUP") {
      if (exited) return
      child.kill(signal as NodeJS.Signals)
    },
  }
}

/** Run inside a fresh Node process, never in a forked copy of V8. */
export async function runPtyHelper(): Promise<never> {
  if (process.argv[2] !== helperFlag) throw new Error("Invalid PTY helper invocation")
  const input: unknown = JSON.parse(process.argv[3] ?? "null")
  if (
    !input ||
    typeof input !== "object" ||
    !("file" in input) ||
    typeof input.file !== "string" ||
    !("args" in input) ||
    !Array.isArray(input.args) ||
    !input.args.every((arg): arg is string => typeof arg === "string")
  )
    throw new Error("Invalid PTY helper command")

  const binding = (native ??= loadNative())
  // detached:true already creates the session. Acquiring its controlling
  // terminal before exec preserves shell job control and terminal signals.
  if (binding.functions.ioctl(0, binding.controlling, null) !== 0) throw binding.error("TIOCSCTTY")
  process.execve!(input.file, [input.file, ...input.args], process.env)
  throw new Error("process.execve unexpectedly returned")
}

function windowSize(cols: number, rows: number) {
  if (![cols, rows].every((value) => Number.isInteger(value) && value > 0 && value <= 65535))
    throw new RangeError("PTY dimensions must be integers between 1 and 65535")
  const size = Buffer.alloc(8)
  size.writeUInt16LE(rows, 0)
  size.writeUInt16LE(cols, 2)
  return size
}

function resolveExecutable(file: string, env: NodeJS.ProcessEnv, cwd: string) {
  if (file.includes("/")) {
    const executable = path.resolve(cwd, file)
    accessSync(executable, constants.X_OK)
    return executable
  }
  for (const directory of (env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    const executable = path.resolve(cwd, directory, file)
    try {
      accessSync(executable, constants.X_OK)
      return executable
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))
        throw error
    }
  }
  throw Object.assign(new Error(`PTY executable not found: ${file}`), { code: "ENOENT" })
}

function loadNative() {
  // Darwin arm64's variadic ioctl ABI needs a separate implementation;
  // passing it a fixed-argument FFI signature would be unsafe.
  if (process.platform !== "linux")
    throw new Error(`Standalone PTY is not implemented for ${process.platform}`)
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new Error(`Standalone PTY ABI is not implemented for ${process.arch}`)
  const ffi = createRequire(import.meta.url)("node:ffi") as FFI
  const errnoSymbol = "__errno_location"
  const definitions = {
    openpty: { arguments: ["pointer", "pointer", "pointer", "pointer", "pointer"], return: "i32" },
    ioctl: { arguments: ["i32", "u64", "pointer"], return: "i32" },
    [errnoSymbol]: { arguments: [], return: "pointer" },
  }
  const library = (() => {
    try {
      return ffi.dlopen(null, definitions)
    } catch {
      return ffi.dlopen("libutil.so.1", definitions)
    }
  })()
  return {
    // Retain the library for the lifetime of all borrowed function pointers.
    library: library.lib,
    functions: library.functions,
    controlling: 0x540en,
    resize: 0x5414n,
    error(operation: string) {
      const code = getSystemErrorName(-ffi.getInt32(library.functions[errnoSymbol]()))
      return Object.assign(new Error(`${operation}: ${code}`), { code })
    },
  }
}
