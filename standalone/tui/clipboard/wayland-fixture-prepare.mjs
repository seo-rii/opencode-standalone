import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

// Independent compositor/client binaries are development fixtures, never bundled.
const root = join(dirname(fileURLToPath(import.meta.url)), "../.cache/wayland-fixture")
const packages = [
  ["s/sway/sway_1.7-6_amd64.deb", "0ea541540d7d6ab1c520ce8f8ace7892d07454c99d62375392f47045d213e8d6"],
  ["w/wlroots/libwlroots10_0.15.1-6_amd64.deb", "a11e37648d06e6b7013dae63b3a6a54187e05e59993a9ddebdf10f378aa257e8"],
  ["s/seatd/libseat1_0.7.0-6_amd64.deb", "646b162f58984f0d7d9021fb668361f6ca3cc9eaa670d1ae77352d563da686e8"],
  ["w/wl-clipboard/wl-clipboard_2.1.0-0.1+b1_amd64.deb", "f2a8d0573709684de292d5347962045952a1e48c35363bfdd1a2c2ee66525a14"],
  ["libx/libxcb/libxcb-xinput0_1.15-1_amd64.deb", "d11dc7b5f9d2addadea1e76d60551d95cc4c73a7eac7cbc0d62360e4e188c0ea"],
  ["libx/libxcb/libxcb-composite0_1.15-1_amd64.deb", "2e28fe9bad7af562fd9dd46a03fb03218850848f373aa1219b66ba6245f56801"],
]
await mkdir(root, { recursive: true })
for (const [path, sha256] of packages) {
  const archive = join(root, path.split("/").at(-1))
  let bytes = await readFile(archive).catch(() => undefined)
  if (!bytes) {
    const response = await fetch(`https://deb.debian.org/debian/pool/main/${path}`)
    if (!response.ok) throw new Error(`Fixture download failed: ${response.status} ${path}`)
    bytes = Buffer.from(await response.arrayBuffer())
    await writeFile(archive, bytes)
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`Fixture checksum mismatch: ${path}`)
  await promisify(execFile)("dpkg-deb", ["--extract", archive, join(root, "root")])
}
console.log(JSON.stringify({ root: join(root, "root"), packages: packages.length }))
