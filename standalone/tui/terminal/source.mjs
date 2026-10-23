import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"

/** Prepare the exact Ghostty dependency already pinned by OpenTUI's archive. */
export async function prepareTerminalSources(directory, manifest) {
  const pins = JSON.parse(await readFile(path.join(directory, "terminal/sources.json"), "utf8"))
  const archive = path.join(directory, ".cache/upstream/zig-deps.tar.gz")
  const expected = manifest.sources.find((entry) => entry.path === "zig-deps.tar.gz").sha256
  if (pins.upstreamOpenTuiCommit !== manifest.opentuiCommit || pins.vendorArchiveSha256 !== expected) throw new Error("Pinned terminal sources differ from OpenTUI's dependency manifest")
  const sourceArchive = path.join(directory, ".cache/upstream/opentui.tar.gz")
  if (createHash("sha256").update(await readFile(sourceArchive)).digest("hex") !== manifest.renderer.sha256) throw new Error("Pinned OpenTUI source archive checksum mismatch")
  const pinScript = spawnSync("tar", ["-xOf", sourceArchive, `opentui-${manifest.opentuiCommit}/${pins.sourceOfPins}`], { encoding: "utf8" })
  if (pinScript.status !== 0) throw new Error("Cannot read OpenTUI's pinned Ghostty source manifest")
  for (const [name, value] of [
    ["GHOSTTY_COMMIT", pins.ghostty.commit],
    ["GHOSTTY_SHA256", pins.ghostty.upstreamArchiveSha256],
    ["UUCODE_GHOSTTY_COMMIT", pins.uucode.commit],
    ["UUCODE_GHOSTTY_SHA256", pins.uucode.upstreamArchiveSha256],
  ]) {
    if (!pinScript.stdout.split("\n").includes(`${name}=${value}`)) throw new Error(`OpenTUI's pinned ${name} changed`)
  }
  const bytes = await readFile(archive)
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Pinned Ghostty dependency archive checksum mismatch")
  const destination = path.join(directory, ".cache/factory-deps")
  await mkdir(destination, { recursive: true })
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", destination, "ghostty", "uucode-ghostty"], { stdio: "inherit" })
  if (extracted.status !== 0) throw new Error("Pinned Ghostty dependency extraction failed")
  // The upstream embedder permits only direct Kitty image transmission. WASI
  // has no shm_open; retain Ghostty's own explicit unsupported-medium branch
  // for that unused platform implementation without changing the VT engine.
  const imageFile = path.join(destination, "ghostty/src/terminal/kitty/graphics_image.zig")
  const image = await readFile(imageFile, "utf8")
  const sharedMemoryGuard = "if (comptime builtin.abi.isAndroid() or builtin.target.os.tag == .windows) {"
  if (image.split(sharedMemoryGuard).length !== 2) throw new Error("Pinned Ghostty shared-memory platform guard changed")
  await writeFile(imageFile, image.replace(sharedMemoryGuard, "if (comptime builtin.abi.isAndroid() or builtin.target.os.tag == .windows or builtin.cpu.arch.isWasm()) {"))
  const licenses = [
    `Ghostty ${pins.ghostty.commit} (reported ${pins.ghostty.reportedVersion})\n${"=".repeat(112)}`,
    await readFile(path.join(destination, "ghostty/LICENSE"), "utf8"),
    "Ghostty Unicode dependency\n==========================",
    await readFile(path.join(destination, "uucode-ghostty/LICENSE.md"), "utf8"),
  ].join("\n\n")
  await writeFile(path.join(directory, "terminal/LICENSES.txt"), licenses)
  return licenses
}
