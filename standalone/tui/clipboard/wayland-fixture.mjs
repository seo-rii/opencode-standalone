import { spawn } from "node:child_process"
import { once } from "node:events"
import { openSync, closeSync } from "node:fs"
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout } from "node:timers/promises"

const directory = dirname(fileURLToPath(import.meta.url))
const binaries = join(directory, "../.cache/wayland-fixture/root")

/** Real, private wlroots compositor; it never contacts the user's display. */
export async function waylandFixture() {
  const sway = join(binaries, "usr/bin/sway")
  await access(sway).catch(() => { throw new Error("Wayland fixtures missing: run node tui/clipboard/wayland-fixture-prepare.mjs") })
  const root = await mkdtemp(join(tmpdir(), "opencode-wayland-"))
  const configuration = join(root, "sway.conf")
  const log = join(root, "sway.log")
  await writeFile(configuration, "output * resolution 1280x720\nseat seat0 fallback true\nxwayland disable\n", { mode: 0o600 })
  const logfile = openSync(log, "wx", 0o600)
  const env = {
    ...process.env, XDG_RUNTIME_DIR: root, WLR_BACKENDS: "headless", WLR_LIBINPUT_NO_DEVICES: "1", WLR_RENDERER: "pixman",
    LD_LIBRARY_PATH: join(binaries, "usr/lib/x86_64-linux-gnu"), SWAYSOCK: join(root, "sway-ipc.sock"),
  }
  for (const name of ["WAYLAND_SOCKET", "WAYLAND_DISPLAY", "DISPLAY", "SWAY_SOCKET"]) delete env[name]
  const compositor = spawn(sway, ["--unsupported-gpu", "--config", configuration], { env, stdio: ["ignore", logfile, logfile] })
  closeSync(logfile)
  const exited = once(compositor, "exit")
  let disposing
  const dispose = () => disposing ??= (async () => {
    if (compositor.exitCode === null && compositor.signalCode === null) { compositor.kill("SIGCONT"); compositor.kill("SIGTERM") }
    await exited
    await rm(root, { recursive: true, force: true })
  })()
  try {
    const deadline = performance.now() + 10_000
    while (true) {
      const names = await readdir(root)
      const display = names.find((name) => /^wayland-\d+$/.test(name))
      if (display) return { root, compositor, env: { ...env, WAYLAND_DISPLAY: display }, bin: (name) => join(binaries, "usr/bin", name), dispose }
      if (compositor.exitCode !== null || compositor.signalCode !== null) {
        await exited
        throw new Error(`Headless Sway exited before socket creation: ${(await readFile(log, "utf8")).slice(-8000)}`)
      }
      if (performance.now() >= deadline) throw new Error("Headless Sway did not create its private display")
      await setTimeout(20)
    }
  } catch (error) { await dispose(); throw error }
}

export function waylandClient(fixture, executable, args, input) {
  const child = spawn(fixture.bin(executable), args, { env: fixture.env, stdio: ["pipe", "pipe", "pipe"] })
  const output = []
  const diagnostics = []
  child.stdout.on("data", (bytes) => output.push(bytes))
  child.stderr.on("data", (bytes) => diagnostics.push(bytes))
  child.stdin.on("error", () => {})
  if (input !== undefined) child.stdin.end(input)
  else child.stdin.end()
  const result = once(child, "close").then(([code, signal]) => ({ code, signal, stdout: Buffer.concat(output), stderr: Buffer.concat(diagnostics).toString() }))
  return { child, result, async dispose() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await result } }
}
