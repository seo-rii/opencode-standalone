import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { build } from "vite"
import { tuiRuntime } from "../scripts/tui-runtime.mjs"

test("actual TUI attachment functions read local files through Node with the original byte limits", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-tui-files-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entry = fileURLToPath(new URL("../../packages/tui/src/component/prompt/local-attachment.ts", import.meta.url))
  const result = await build({
    configFile: false,
    root: directory,
    logLevel: "silent",
    esbuild: { tsconfigRaw: "{}" },
    plugins: [tuiRuntime()],
    build: {
      ssr: entry, write: false, minify: false,
      rollupOptions: { external: isBuiltin, output: { format: "esm", inlineDynamicImports: true } },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((value) => value.output)
  assert.equal(outputs.length, 1)
  const module = path.join(directory, "attachment.mjs")
  await writeFile(module, outputs[0].code)
  const attachment = await import(pathToFileURL(module).href)
  const svg = "<svg>한국어</svg>"
  const svgPath = path.join(directory, "image with spaces.svg")
  const pngPath = path.join(directory, "image.png")
  const bytes = Buffer.from([0, 137, 255, 13, 10])
  await Promise.all([writeFile(svgPath, svg), writeFile(pngPath, bytes)])
  assert.deepEqual(await attachment.readLocalAttachment(svgPath), { type: "text", mime: "image/svg+xml", content: svg })
  assert.deepEqual(await attachment.readLocalAttachment(pngPath, bytes.length), { type: "binary", mime: "image/png", content: bytes })
  assert.equal(await attachment.readLocalAttachment(svgPath, Buffer.byteLength(svg) - 1), undefined)
  assert.equal(await attachment.readLocalAttachment(pngPath, bytes.length - 1), undefined)
  assert.equal(await attachment.readLocalAttachment(path.join(directory, "missing.png")), undefined)
  assert.deepEqual(await attachment.resolvePastedAttachments(`"${svgPath}"`, process.platform), [
    { type: "text", content: svg, filename: "image with spaces.svg" },
  ])
  assert.deepEqual(await attachment.resolvePastedAttachments(pathToFileURL(pngPath).href, process.platform), [
    { type: "file", uri: `data:image/png;base64,${bytes.toString("base64")}`, filename: "image.png" },
  ])
})

test("built-in TUI sounds retain their exact bytes in a copied module and custom sound paths still load", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-tui-sounds-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entry = path.join(directory, "entry.mjs")
  await writeFile(entry, 'export { defaultSoundPath, questionSoundPath, permissionSoundPath, errorSoundPath, subagentDoneSoundPath, readBuiltinSound } from "virtual:standalone-tui-sounds"\n')
  const result = await build({
    configFile: false, root: directory, logLevel: "silent", plugins: [tuiRuntime()],
    build: {
      ssr: entry, write: false, minify: false,
      rollupOptions: { external: isBuiltin, output: { format: "esm", inlineDynamicImports: true } },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((value) => value.output)
  assert.equal(outputs.length, 1)
  const module = path.join(directory, "sounds.mjs")
  await writeFile(module, outputs[0].code)
  const sounds = await import(pathToFileURL(module).href)
  for (const [name, file] of Object.entries({
    defaultSoundPath: "bip-bop-01.mp3", questionSoundPath: "bip-bop-03.mp3",
    permissionSoundPath: "staplebops-06.mp3", errorSoundPath: "nope-03.mp3", subagentDoneSoundPath: "yup-01.mp3",
  })) {
    const original = await readFile(new URL(`../../packages/ui/src/assets/audio/${file}`, import.meta.url))
    assert.deepEqual(await sounds.readBuiltinSound(sounds[name]), original)
  }
  const custom = path.join(directory, "custom.mp3")
  await writeFile(custom, Buffer.from([0, 255, 128, 1]))
  assert.deepEqual(await sounds.readBuiltinSound(custom), Buffer.from([0, 255, 128, 1]))
  await assert.rejects(sounds.readBuiltinSound(path.join(directory, "missing.mp3")), { code: "ENOENT" })
})
