import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
export const standaloneBackendPath = join(directory, "index.mjs")
const published = JSON.parse(await readFile(join(directory, "published-sources.json"), "utf8"))

/** Fork only the native factory and typed memory-view host seams in pinned published JS. */
export async function standalonePackagePlugin({ transform = (_path, source) => source } = {}) {
  const entry = fileURLToPath(import.meta.resolve("@opentui/core"))
  const root = dirname(entry)
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  if (manifest.version !== published.version) throw new Error(`Expected ${published.package} ${published.version}`)
  const sources = new Map()
  for (const [filename, hash] of Object.entries(published.files)) {
    const path = join(root, filename)
    const source = await readFile(path, "utf8")
    if (createHash("sha256").update(source).digest("hex") !== hash) throw new Error(`Published source checksum mismatch: ${path}`)
    sources.set(path, source)
  }
  return {
    name: "opentui-standalone-backend",
    setup(build) {
      build.onResolve({ filter: /^opencode:tui-backend$/ }, () => ({ path: standaloneBackendPath }))
      build.onLoad({ filter: /chunk-node-(?:p43t2gam|2rg7pskw)\.js$/ }, async ({ path }) => {
        const original = sources.get(path)
        if (!original) throw new Error(`Unexpected published OpenTUI chunk: ${path}`)
        return { contents: await transform(path, adaptPublishedBackendSource(path, original)), loader: "js", resolveDir: root }
      })
    },
  }
}

/** Checked source adapter shared by esbuild and the main Vite/Rollup pipeline. */
export function adaptPublishedBackendSource(path, original) {
  const name = basename(path)
  const expected = published.files[name]
  if (!expected) return undefined
  if (createHash("sha256").update(original).digest("hex") !== expected) throw new Error(`Published source checksum mismatch: ${path}`)
  if (!name.startsWith("chunk-node-")) return original
  if (path.endsWith("chunk-node-p43t2gam.js")) {
    let contents = replace(original,
      "var backend = loadBackend();",
      'var backend = createUnsupportedBackend(new Error("Standalone TUI uses WASM linear memory"));')
    contents = replace(contents,
      "var backend2 = await loadBackend2();",
      'var backend2 = createUnsupportedBackend2(new Error("Standalone TUI does not expose process pointers"));')
    contents = replace(contents,
      'try {\n  targetLibPath = await resolveNativeLibraryPath();\n  if (isBunfsPath(targetLibPath)) {\n    targetLibPath = targetLibPath.replace("../", "");\n  }\n  if (!existsSync2(targetLibPath)) {\n    throw new Error(`OpenTUI native library does not exist at ${JSON.stringify(targetLibPath)}`);\n  }\n} catch (error) {\n  targetLibError = error instanceof Error ? error : new Error(String(error));\n}',
      'targetLibError = new Error("Native shared-library loading is unavailable in the standalone WASM backend");')
    const factory = "opentuiLib = createStandaloneRenderLib({ YogaHost, NativeError: NativeError2, NativeStatus: NativeStatus2, RGBA: RGBA2, nativeConstants, nativeLayouts, encodeStyledText: FFIRenderLib2.prototype.encodeStyledText, releaseAfterPaint: FFIRenderLib2.prototype.releaseAfterPaint, encodeEditorStyle, encodeEditorSelection, widthMethodId, encodeContextHighlight, programStatusPayload, mouseStyleToId: MOUSE_STYLE_TO_ID, createBufferDrawRecord, encodeBufferDrawRecord, encodeImageDrawOptions, drawRecordText, drawRecordBottomTitle, rejectAsyncCallback });"
    contents = replace(contents,
      "opentuiLib = new FFIRenderLib2(opentuiLibPath);",
      factory, 2)
    contents = replace(contents,
      `try {\n  ${factory}\n} catch (error) {}`,
      "// WASM contexts are allocated lazily by the first actual renderer owner.")
    return 'import { createStandaloneRenderLib } from "opencode:tui-backend";\n' + contents
  }
  let contents = original
  for (const [type, field, stride] of [["Uint32Array", "char", 4], ["Uint16Array", "fg", 8], ["Uint16Array", "bg", 8], ["Uint32Array", "attributes", 4]]) {
    contents = replace(contents,
      `new ${type}(toArrayBuffer(value.${field}, 0, value.width * value.height * ${stride}))`,
      `createStandaloneMemoryView(${type}, value.${field}, 0, value.width * value.height * ${stride})`)
  }
  contents = replace(contents,
    "new Uint8Array(toArrayBuffer(result.pointer, 0, result.byteCount))",
    "createStandaloneImageMemoryView(result.pointer, result.byteCount)")
  return 'import { createStandaloneMemoryView, createStandaloneImageMemoryView } from "opencode:tui-backend";\n' + contents
}

function replace(source, before, after, count = 1) {
  if (source.split(before).length !== count + 1) throw new Error(`Pinned published seam did not match ${count} times: ${before}`)
  return source.replaceAll(before, after)
}
