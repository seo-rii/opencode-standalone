import { Effect, FileSystem, Option } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { OPENCODE_LOCAL } from "../../packages/cli/src/version.js"
import { decodeAssetArchive } from "./runtime.mjs"

export type AssetMap = Readonly<Record<string, string | Uint8Array>>
export type BrotliMap = Readonly<Record<string, Uint8Array>>

export const load = Effect.fn("cli.app-assets.load")(function* () {
  const embedded = yield* Effect.tryPromise(() => import("virtual:opencode-app-assets")).pipe(
    Effect.map((module) => decodeAssetArchive(module.default())),
    Effect.option,
  )
  if (Option.isSome(embedded) && (Object.keys(embedded.value.files).length > 0 || !OPENCODE_LOCAL))
    return embedded.value
  if (!OPENCODE_LOCAL) return yield* Effect.fail(new Error("Web UI assets are missing from the CLI build"))
  return { files: yield* sourceAssets(), brotli: undefined }
})

const sourceAssets = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = path.resolve(import.meta.dirname, "../../packages/app/dist")
  const files = yield* fs.readDirectory(root, { recursive: true })
  const assets = Object.fromEntries(
    (yield* Effect.forEach(
      files.filter((file) => !file.endsWith(".map")),
      Effect.fnUntraced(function* (file) {
        const target = path.join(root, file)
        if ((yield* fs.stat(target)).type === "Directory") return
        return [file, target] as const
      }),
      { concurrency: "unbounded" },
    )).filter((asset) => asset !== undefined),
  )
  return new Proxy({}, {
    get: (_, key) => {
      if (typeof key !== "string" || assets[key] === undefined) return
      const body = readFileSync(assets[key]!)
      return key === "_headers" || /\.(?:css|html|js|json|svg|txt|webmanifest|xml)$/.test(key) ? body.toString() : body
    },
  })
})
