import { readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { archiveDirectory } from "./archive.mjs"
import { notices } from "../scripts/notices.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const cache = join(root, "standalone/.cache/web")
const output = join(cache, "dist")
const modules = new Set()
const assetPackages = ["@betteroffice/docx", "@betteroffice/fonts", "@betteroffice/pptx", "@betteroffice/xlsx", "@ibm/plex", "ghostty-web"]

// Only this dedicated builder process is affected. Import the original plugin
// after choosing its channel; never import vite.config.ts's upload plugin.
process.env.OPENCODE_CHANNEL = "dev"
const { build, version } = await import("vite-web")
if (version !== "8.2.2") throw new Error(`Expected upstream browser Vite 8.2.2; found ${version}`)
const { default: desktopPlugin } = await import("../../packages/app/vite.js")
const { icons } = await import("../../packages/app/vite.icons.ts")
const { serviceWorker } = await import("../../packages/app/vite.pwa.ts")
await mkdir(cache, { recursive: true })
const pwa = serviceWorker(output)
let written = false
const pwaBuild = pwa.find((plugin) => plugin.name === "vite-plugin-pwa:build")
const closePwa = pwaBuild.closeBundle.handler
pwaBuild.closeBundle = {
  ...pwaBuild.closeBundle,
  async handler(error) {
    // Rolldown can call closeBundle without forwarding an earlier error. Do
    // not replace the original failure with Workbox's empty-precache error.
    if (!written) return
    return closePwa.call(this, error)
  },
}

function recordModules(rootOutput = false) {
  return {
    name: "opencode-standalone:web-notices",
    writeBundle() {
      if (rootOutput) written = true
    },
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (!id.startsWith(root) || this.getModuleInfo(id)?.isIncluded === false) continue
        modules.add(relative(root, id.split("?", 1)[0]).split(sep).join("/"))
      }
    },
  }
}

await build({
  root: join(root, "packages/app"),
  configFile: false,
  envDir: false,
  envPrefix: [],
  mode: "production",
  cacheDir: join(cache, "vite"),
  logLevel: "warn",
  plugins: [desktopPlugin, icons("dev"), pwa, recordModules(true)],
  define: {
    "import.meta.env.VITE_OPENCODE_SERVER_MODE": JSON.stringify("origin"),
    "import.meta.env.VITE_SENTRY_DSN": JSON.stringify(""),
  },
  worker: { format: "es", plugins: () => [recordModules()] },
  build: {
    outDir: output,
    emptyOutDir: true,
    assetsDir: "_assets",
    target: "esnext",
    sourcemap: false,
  },
})

const archive = await archiveDirectory(output)
await writeFile(join(cache, "app.archive"), archive.bytes)

const packageRoots = []
const nestedNotices = []
for (const name of assetPackages) {
  // Resolve through the prepared standalone installation. Some packages do not
  // export package.json; walking upward from their entry is unnecessary here.
  const directory = join(root, "standalone/node_modules", name)
  const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
  packageRoots.push({ name, version: metadata.version, path: relative(root, directory).split(sep).join("/") })
  for (const file of await licenseFiles(directory)) {
    nestedNotices.push(`${name}@${metadata.version} / ${file}\n${await readFile(join(directory, file), "utf8")}`)
  }
}
const licenses = `${await notices(root, modules, assetPackages)}\n\nFont and WASM distribution notices\n\n${nestedNotices.join("\n\n----------------------------------------\n\n")}`
await writeFile(join(cache, "licenses.txt"), licenses)
const manifest = {
  upstream: "f7577a1f65b465b35b0dcb30b23f22c14e3b5460",
  vite: version,
  serverMode: "origin",
  sentryUpload: false,
  archive: { path: "app.archive", bytes: archive.bytes.length, sha256: createHash("sha256").update(archive.bytes).digest("hex"), ...archive.compression },
  licenses: { path: "licenses.txt", bytes: Buffer.byteLength(licenses), sha256: createHash("sha256").update(licenses).digest("hex") },
  files: archive.files,
  modules: [...modules].sort(),
  assetPackages: packageRoots,
}
await writeFile(join(cache, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(JSON.stringify({ archive: join(cache, "app.archive"), bytes: archive.bytes.length, assets: archive.files.length, modules: modules.size, licenses: join(cache, "licenses.txt") }))

async function licenseFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(current, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : licenseFiles(root, path)
    if (!/^(?:licen[sc]e|copying|copyright|notice|ofl)(?:[.-]|$)/i.test(entry.name)) return []
    return [relative(root, path).split(sep).join("/")]
  }))).flat().sort()
}

