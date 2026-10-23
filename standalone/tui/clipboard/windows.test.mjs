import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { clipboardWorkers } from "../../scripts/clipboard-workers.mjs"
import { createWindowsClipboard } from "./windows.mjs"

if (process.platform !== "win32") {
  test("Windows public factory reports unsupported on a different operating system", async () => {
    await assert.rejects(createWindowsClipboard(), { code: "WINDOWS_UNSUPPORTED" })
  })
}

if (process.platform === "linux") {
  test("Windows worker exchanges real FFI memory and preserves clipboard ownership, Unicode, bounds and cancellation against a native ABI fixture", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "standalone-windows-abi-"))
    try {
      const library = join(root, "clipboard-abi.so")
      const proof = join(root, "proof.mjs")
      await run(process.env.CC ?? "cc", ["-std=c11", "-O2", "-shared", "-fPIC", "-pthread", "-Wall", "-Wextra", "-Werror", fileURLToPath(new URL("./windows-fixture.c", import.meta.url)), "-o", library])
      const result = await build({
        entryPoints: [fileURLToPath(new URL("./windows-abi-proof.mjs", import.meta.url))],
        outfile: proof,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node26",
        minify: true,
        legalComments: "none",
        plugins: [clipboardWorkers()],
        metafile: true,
      })
      for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) assert.ok(dependency.path.startsWith("node:"), dependency.path)
      const completed = await run(process.execPath, ["--experimental-ffi", "--no-addons", proof, library], { env: { PATH: "", HOME: root, TMPDIR: root } })
      assert.deepEqual(JSON.parse(completed.stdout), { platform: "linux", nativeAbiFixture: true, actualWindows: false })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

if (process.platform === "win32") {
  test("Windows clipboard exchanges Unicode, registered PNG and DIB with actual Win32 in a private window station", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "standalone-windows-native-"))
    try {
      const proof = join(root, "proof.mjs")
      await build({
        entryPoints: [fileURLToPath(new URL("./windows-native-proof.mjs", import.meta.url))],
        outfile: proof,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node26",
        minify: true,
        legalComments: "none",
        plugins: [clipboardWorkers()],
      })
      const completed = await run(process.execPath, ["--experimental-ffi", "--no-addons", proof], { env: {
        PATH: "", HOME: root, USERPROFILE: root, TMP: root, TEMP: root,
        SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
      } })
      assert.deepEqual(JSON.parse(completed.stdout), { platform: "win32", actualWindows: true, privateWindowStation: true })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) { resolve({ stdout, stderr }); return }
      reject(new Error(`${executable} failed (${code ?? signal}): ${stderr || stdout}`))
    })
  })
}
