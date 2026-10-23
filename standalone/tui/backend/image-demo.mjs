import { NativeImage, NativeImagePool, ImageRenderable, ImageError, ResourceContext, NativeError, NativeStatus, RGBA, CliRenderEvents, createTestRenderer } from "./image-entry.mjs"
import { checkPublishedImages, checkPublishedImageScene } from "./image-proof.mjs"

const api = { NativeImage, NativeImagePool, ImageRenderable, ImageError, ResourceContext, NativeError, NativeStatus, RGBA, CliRenderEvents, createTestRenderer }
console.log(JSON.stringify({ images: checkPublishedImages(api), scene: await checkPublishedImageScene(api) }))
