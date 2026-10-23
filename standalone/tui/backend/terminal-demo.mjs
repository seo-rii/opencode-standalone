import { EmbeddedTerminalRenderable, BoxRenderable, OptimizedBuffer, ResourceContext, NativeError, NativeStatus, RGBA, CliRenderEvents, Selection, createTestRenderer } from "./terminal-entry.mjs"
import { checkPublishedTerminalResources, checkPublishedTerminalScene } from "./terminal-proof.mjs"

const api = { EmbeddedTerminalRenderable, BoxRenderable, OptimizedBuffer, ResourceContext, NativeError, NativeStatus, RGBA, CliRenderEvents, Selection, createTestRenderer }
console.log(JSON.stringify({ resources: checkPublishedTerminalResources(api), scenes: [await checkPublishedTerminalScene(api, 44), await checkPublishedTerminalScene(api, 100)] }))
