import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { imageInfo } from "@opentui/core"
import { NativeImage, NativeImagePool, ImageRenderable, ImageError, ResourceContext, NativeError, NativeStatus, RGBA, CliRenderEvents, createTestRenderer } from "./image-entry.mjs"
import { checkPublishedLargeImages } from "./image-large-proof.mjs"

export { NativeImage, NativeImagePool, ImageRenderable, ImageError, ResourceContext, NativeError, NativeStatus, RGBA, CliRenderEvents, createTestRenderer, imageInfo }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ largeImages: checkPublishedLargeImages({ NativeImage, NativeImagePool, ResourceContext, imageInfo }) }))
}
