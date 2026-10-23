import { readFile, readdir, mkdir, symlink, lstat, readlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = fileURLToPath(new URL("../../", import.meta.url))
const modules = path.join(root, "standalone/node_modules")
await mkdir(path.join(modules, "@opencode"), { recursive: true })

async function link(target, destination) {
  const exists = await lstat(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error
  })
  if (exists) {
    if (!exists.isSymbolicLink() || path.resolve(path.dirname(destination), await readlink(destination)) !== target)
      throw new Error(`Refusing to replace existing dependency path: ${destination}`)
    return
  }
  await symlink(path.relative(path.dirname(destination), target), destination, "junction")
}

await link(modules, path.join(root, "node_modules"))
for (const entry of await readdir(path.join(root, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const directory = path.join(root, "packages", entry.name)
  const manifest = await readFile(path.join(directory, "package.json"), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error
  })
  if (!manifest) continue
  const pkg = JSON.parse(manifest)
  if (!pkg.name?.startsWith("@opencode/")) continue
  await link(directory, path.join(modules, pkg.name))
}

const upstream = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
for (const [specifier, patch] of Object.entries(upstream.patchedDependencies)) {
  const split = specifier.lastIndexOf("@")
  const name = specifier.slice(0, split)
  const version = specifier.slice(split + 1)
  // The build applies Photon's export-table fix and embeds its WASM in memory.
  // Its upstream patch also assumes extraction to a filesystem asset.
  if (name === "@silvia-odwyer/photon-node") continue
  const directory = path.join(modules, name)
  const manifest = await readFile(path.join(directory, "package.json"), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error
  })
  if (!manifest || JSON.parse(manifest).version !== version) continue
  const input = (await readFile(path.join(root, patch), "utf8"))
    .split(/(?=^diff --git )/m)
    .filter((part) => !part.split("\n", 1)[0].includes(".bun-tag-"))
    .join("")
  const args = ["apply", "--ignore-whitespace", `--directory=${path.relative(root, directory)}`]
  const reverse = spawnSync("git", [...args, "--reverse", "--check", "-"], { cwd: root, encoding: "utf8", input })
  if (reverse.status === 0) continue
  const applied = spawnSync("git", [...args, "-"], { cwd: root, encoding: "utf8", input })
  if (applied.status !== 0) throw new Error(`Upstream patch failed: ${patch}\n${applied.stderr}`)
  console.log(`Applied upstream patch: ${specifier}`)
}
console.log("Workspace sources linked; installed upstream patches preserved.")

