import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import timers from "node:timers/promises"
import { createTerminal } from "../persistent-pty/terminal.ts"
import { helperFlag, runPtyHelper, spawn } from "../pty/index.ts"
import type { Exit } from "../pty/index.ts"
import { deadline, diagnostic, sandbox } from "./harness.mjs"
import { provider } from "./provider-fixture.mjs"
import { startX11Fixture } from "../tui/clipboard/x11-fixture.mjs"

if (process.argv[2] === helperFlag) {
  process.stderr.write("standalone test PTY helper ready\n")
  await runPtyHelper()
} else {
  for (const mode of ["default", "mini", "terminal", "clipboard"]) {
    test(`copied full CLI ${mode} draws, edits Korean input, streams a reply, resizes and exits through a real PTY`, { timeout: 180_000 }, async (t) => {
      const fixture = await provider(t)
      const isolated = await sandbox(t, fixture.config)
      const clipboard = mode === "clipboard" ? await startX11Fixture(path.join(isolated.root, "clipboard-display")) : undefined
      if (clipboard) {
        t.after(() => clipboard.dispose())
        await clipboard.owner({ offers: [{ mimeType: "UTF8_STRING", bytes: Buffer.from("standalone ui 한국어") }] })
      }
      const server = await isolated.serve({ env: mode === "terminal" ? { PS1: "VT> " } : {} })
      const terminal = await createTerminal(100, 30)
      const proc = spawn(process.execPath, [
        "--no-addons", "--experimental-ffi", isolated.executable,
        ...mode === "mini" ? ["mini"] : [], "--server", server.url,
      ], { cwd: isolated.paths.project, env: {
        ...isolated.env, COLORTERM: "truecolor", LANG: "C.UTF-8", OTUI_USE_CONSOLE: "false",
        ...clipboard ? { DISPLAY: clipboard.env.DISPLAY, XAUTHORITY: clipboard.env.XAUTHORITY } : {},
      }, name: "xterm-256color", cols: 100, rows: 30 })
      const events = new EventEmitter()
      const decoder = new TextDecoder()
      let output = ""
      let closed = false
      let processExit: Exit | undefined
      const processListener = proc.onProcessExit((value) => { processExit = value })
      const exit = new Promise<Exit>((resolve) => proc.onExit((value) => {
        closed = true
        resolve(value)
        events.emit("output")
      }))
      const listener = proc.onBinaryData((bytes) => {
        const next = output + decoder.decode(bytes, { stream: true })
        output = next.length > 262144 ? `${next.slice(0, 131072)}\n[output truncated]\n${next.slice(-131072)}` : next
        terminal.write(bytes)
        for (const response of terminal.takeResponses()) proc.writeBinary(response)
        events.emit("output")
      })
      const screen = () => terminal.snapshot().text
      async function until(pattern: RegExp, milliseconds = 30_000) {
        const check = () => pattern.test(screen())
        if (check()) return
        let listener: (() => void) | undefined
        try {
          await deadline(new Promise<void>((resolve, reject) => {
            listener = () => {
              if (/(?:NativeError2?|TypeError|ReferenceError|SyntaxError):/.test(output) || /OpenCode crashed/.test(screen()))
                return reject(new Error(`TUI reported a runtime error\n${diagnostic({ stdout: output, stderr: screen() })}`))
              if (check()) return resolve()
              if (closed) reject(new Error(`TUI exited before ${pattern}\n${diagnostic({ stdout: output, stderr: screen() })}`))
            }
            events.on("output", listener)
            listener()
          }), milliseconds, () => `TUI did not draw ${pattern}\n${diagnostic({ stdout: output, stderr: screen() })}`)
        } finally {
          if (listener) events.off("output", listener)
        }
      }
      try {
        await until(/Ask anything/, 60_000)
        // The mini footer appears before its real session/config bootstrap is
        // ready to accept prompts. Wait for the configured model to arrive.
        await until(/Local protocol fixture/)
        // Only the isolated native Xlib owner supplies the clipboard-mode text.
        proc.write(mode === "clipboard" ? "\x16" : "standalone ui 한국어")
        await until(/standalone ui 한국어/u)
        terminal.resize(44, 20)
        proc.resize(44, 20)
        await until(/standalone ui 한국어/u)
        proc.write("\r")
        // The actual mini reply can wrap between words at 44 columns.
        await until(/Standalone\s+fixture\s+session/)
        assert.deepEqual(fixture.failures.map((error: Error) => error.message), [])
        assert.ok(fixture.requests.length > 0)
        if (mode === "terminal") {
          terminal.resize(100, 30)
          proc.resize(100, 30)
          proc.write("/terminal")
          await until(/New terminal/)
          proc.write("\r")
          await until(/VT>/)
          const sessions = await server.json("/api/session")
          const route = `/api/experimental/session/${sessions.data[0].id}/terminal`
          const panes = await server.json(route)
          assert.equal(panes.data.length, 1)
          const base = `/api/experimental/persistent-pty/${panes.data[0].id}`
          // The echoed command cannot itself match the formatted reply.
          proc.write("printf '\\033[32mVT_%s_%s\\033[0m\\n' ECHO 한글\r")
          await until(/VT_ECHO_한글/u)
          const connected = (await server.json(base)).data
          const wide = connected.size
          proc.write("\x18t")
          await until(/^(?![\s\S]*VT_ECHO_한글)/u)
          proc.write("\x18t")
          await until(/VT_ECHO_한글/u)
          assert.equal((await server.json(base)).data.pid, connected.pid)
          terminal.resize(44, 20)
          proc.resize(44, 20)
          await deadline((async () => {
            for (;;) {
              const size = (await server.json(base)).data.size
              if (size.cols < wide.cols && size.rows < wide.rows) return
              await timers.setTimeout(25)
            }
          })(), 10_000, () => `Terminal pane did not resize its real PTY\n${diagnostic({ stdout: output, stderr: screen() })}`)
          proc.write("printf 'VT_NARROW_%s\\n' OK\r")
          await until(/VT_NARROW_OK/)
          assert.match((await server.json(`${base}/snapshot`)).data.text, /VT_ECHO_한글/u)
          proc.write("exit 23\r")
          await deadline((async () => {
            while ((await server.json(route)).data.length) await timers.setTimeout(25)
          })(), 10_000, () => `Exited terminal pane was not removed\n${diagnostic({ stdout: output, stderr: screen() })}`)
        }
        proc.write("\x03")
        if (mode === "mini") {
          await until(/again to exit/)
          proc.write("\x03")
        }
        assert.equal((await deadline(exit, 10_000, () => "TUI did not exit on control-C")).exitCode, 0)
      } catch (cause) {
        if (cause instanceof Error) cause.message += `\nPTY helper PID: ${proc.pid}; process exit: ${JSON.stringify(processExit)}; Node flags: ${JSON.stringify(process.execArgv)}`
        const sessions = await server.json("/api/session").catch((error: Error) => ({ error: error.message }))
        const messages = "data" in sessions ? await Promise.all(sessions.data.slice(-2).map(async (session: { id: string }) => ({
          session,
          messages: await server.json(`/api/session/${session.id}/message`).catch((error: Error) => ({ error: error.message })),
        }))) : sessions
        if (cause instanceof Error) cause.message += `\nProvider calls: ${JSON.stringify(fixture.requests.map((request: { messages: { role: string; content: unknown }[] }) => ({
          messages: request.messages.map((message) => ({ role: message.role, content: JSON.stringify(message.content).slice(-300) })),
        })))}\nStored messages: ${JSON.stringify(messages).slice(-12000)}`
        const directory = path.join(isolated.paths.data, "opencode", "log")
        const files = await readdir(directory).catch(() => [])
        const logs = await Promise.all(files.slice(-3).map(async (file) => {
          const bytes = await readFile(path.join(directory, file)).catch(() => Buffer.alloc(0))
          return `${file}:\n${bytes.toString("utf8").slice(-8000)}`
        }))
        if (cause instanceof Error && logs.length) cause.message += `\nIsolated CLI logs:\n${logs.join("\n")}`
        throw cause
      } finally {
        if (mode === "terminal") await server.request("/api/experimental/persistent-pty/shutdown", { method: "POST" }).catch(() => undefined)
        if (!closed) {
          proc.kill("SIGTERM")
          const timer = setTimeout(() => proc.kill("SIGKILL"), 3_000)
          try {
            await deadline(exit, 10_000, () => "PTY did not close during cleanup")
          } finally {
            clearTimeout(timer)
          }
        }
        listener.dispose()
        processListener.dispose()
        terminal.free()
        await clipboard?.dispose()
      }
    })
  }
}
