import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
const cache = join(directory, "../.cache/clipboard-image")
const source = join(directory, "../.cache/factory-source/src/clipboard/windows-dib.zig")
const sourceSha256 = createHash("sha256").update(await readFile(source)).digest("hex")
if (sourceSha256 !== "f35cb199bcc26e07018feff5d2e6873978d4c09062111d5f3a1c2a0b0a85a082") throw new Error("Original Windows clipboard converter source has changed")
await mkdir(cache, { recursive: true })
const result = spawnSync(process.env.OPENCODE_ZIG ?? join(directory, "../.cache/zig/zig"), [
  "build-exe", join(directory, "image-native.c"), "-lc", "-O", "ReleaseSafe",
  "--dep", "clipboard_dib", `-Mroot=${join(directory, "image-native.zig")}`,
  `-Mclipboard_dib=${source}`,
  "--cache-dir", join(cache, "zig"),
  "--global-cache-dir", join(directory, "../.cache/zig-global"),
  `-femit-bin=${join(cache, "native")}`,
], { stdio: "inherit" })
if (result.status !== 0) throw new Error(`Original DIB conversion reference failed to build: ${result.status ?? result.signal}`)
const nativeSha256 = createHash("sha256").update(await readFile(join(cache, "native"))).digest("hex")
await writeFile(join(cache, "receipt.json"), JSON.stringify({ sourceSha256, nativeSha256 }) + "\n")
console.log(JSON.stringify({ native: join(cache, "native") }))
