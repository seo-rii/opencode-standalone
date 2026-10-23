import { createImageTransport } from "./runtime.mjs"
import { runImageScenarios } from "./scenarios.mjs"
import fixtures from "./fixtures.json" with { type: "json" }

const result = runImageScenarios(createImageTransport(), fixtures)
console.log(JSON.stringify({ requests: result.trace.length, captures: result.captures.length, formats: ["png", "jpeg", "gif", "webp", "rgba"], icc: result.stats }))
