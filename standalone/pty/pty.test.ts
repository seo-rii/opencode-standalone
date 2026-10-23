import assert from "node:assert/strict"
import { test } from "node:test"
import { helperFlag, runPtyHelper, spawn } from "./index.ts"
import type { Exit, Proc } from "./index.ts"

if (process.argv[2] === helperFlag) {
  await runPtyHelper()
} else {
  test("POSIX PTY provides a terminal, input, resize, exit status and listener disposal", { timeout: 10_000 }, async (t) => {
    const proc = spawn("sh", ["-c", [
      "test -t 0 && test -t 1 && test -t 2 || exit 91",
      "printf 'INITIAL:'; stty size",
      "printf 'READY\\n'",
      "read value",
      "printf 'INPUT:%s\\n' \"$value\"",
      "printf 'RESIZED:'; stty size",
      "exit 17",
    ].join("; ")], { name: "xterm-256color", cols: 80, rows: 24 })
    t.after(() => proc.kill("SIGKILL"))
    const capture = observe(proc)
    const disposed: string[] = []
    proc.onData((value) => disposed.push(value)).dispose()
    await capture.until("READY\r\n")
    proc.resize(101, 37)
    proc.write("hello 한글\n")
    assert.deepEqual(await capture.exit, { exitCode: 17 })
    assert.match(capture.output(), /INITIAL:24 80\r\n/)
    assert.match(capture.output(), /INPUT:hello 한글\r\n/)
    assert.match(capture.output(), /RESIZED:37 101\r\n/)
    assert.deepEqual(disposed, [])
  })

  test("control-C reaches the foreground program through the terminal", { timeout: 10_000 }, async (t) => {
    const proc = spawn("sh", ["-c", "trap 'printf INTERRUPTED; exit 23' INT; printf 'READY\\n'; read value"], {
      name: "xterm-256color",
    })
    t.after(() => proc.kill("SIGKILL"))
    const capture = observe(proc)
    await capture.until("READY\r\n")
    proc.write("\x03")
    assert.deepEqual(await capture.exit, { exitCode: 23 })
    assert.match(capture.output(), /INTERRUPTED/)
  })

  test("kill reaps the child and reports its signal", { timeout: 10_000 }, async (t) => {
    const proc = spawn("sh", ["-c", "printf 'READY\\n'; read value"], { name: "xterm-256color" })
    t.after(() => proc.kill("SIGKILL"))
    const capture = observe(proc)
    await capture.until("READY\r\n")
    const disposed: Exit[] = []
    proc.onExit((value) => disposed.push(value)).dispose()
    proc.kill("SIGTERM")
    assert.deepEqual(await capture.exit, { exitCode: 0, signal: "SIGTERM" })
    assert.deepEqual(disposed, [])
    assert.throws(() => process.kill(proc.pid, 0), { code: "ESRCH" })
  })

  test("invalid dimensions and missing executables fail before spawning", () => {
    assert.throws(() => spawn("sh", [], { name: "xterm", cols: 0 }), RangeError)
    assert.throws(() => spawn("standalone-pty-nonexistent-command", [], { name: "xterm" }), { code: "ENOENT" })
  })
}

function observe(proc: Proc) {
  let output = ""
  const waiting = new Set<{ text: string; resolve(): void; reject(error: Error): void }>()
  const data = proc.onData((value) => {
    output += value
    for (const item of waiting) {
      if (!output.includes(item.text)) continue
      waiting.delete(item)
      item.resolve()
    }
  })
  const exit = new Promise<Exit>((resolve) => {
    proc.onExit((result) => {
      data.dispose()
      for (const item of waiting) item.reject(new Error(`PTY exited before ${item.text}: ${output}`))
      waiting.clear()
      resolve(result)
    })
  })
  return {
    exit,
    output: () => output,
    until(text: string) {
      if (output.includes(text)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => waiting.add({ text, resolve, reject }))
    },
  }
}
