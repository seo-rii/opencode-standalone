import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(await readFile(path.join(directory, "sources.json"), "utf8"))
await access(path.join(directory, ".cache/factory-source/src/entry.zig"))
await access(path.join(directory, ".cache/factory-deps/ghostty/build.zig"))
const zig = process.env.OPENCODE_ZIG ?? path.join(directory, ".cache/zig/zig")
const version = spawnSync(zig, ["version"], { encoding: "utf8" })
if (version.status !== 0 || version.stdout.trim() !== manifest.zig.version) throw new Error(`Expected Zig ${manifest.zig.version}`)
const result = spawnSync(zig, [
  "build", "-Dfactory=true", "-Dterminal-oracle=true", "terminal-oracle", "-j2",
  "--prefix", path.join(directory, ".cache/terminal-native-build"),
  "--cache-dir", path.join(directory, ".cache/terminal-native-zig"),
  "--global-cache-dir", path.join(directory, ".cache/zig-global"),
], { cwd: directory, stdio: "inherit" })
if (result.status !== 0) throw new Error(`Native terminal oracle build failed (${result.status ?? result.signal})`)
console.log(JSON.stringify({ native: path.join(directory, ".cache/terminal-native-build/bin/opentui-terminal-reference") }))
