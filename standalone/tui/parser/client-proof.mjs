import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { TreeSitterClient } from "@opentui/core"

/** Exercise the published client and its real Node worker shim, not a parallel protocol client. */
export async function runParserClientProof(dataPath, custom) {
  const client = new TreeSitterClient({ dataPath, initTimeout: 15000 })
  const errors = []
  const warnings = []
  const logs = []
  let destroyed = 0
  client.on("error", (error) => errors.push(error))
  client.on("warning", (warning) => warnings.push(warning))
  client.on("worker:log", (type, message) => logs.push({ type, message }))
  client.onDestroy(() => { destroyed++ })
  try {
    await client.initialize()
    assert.equal(client.isInitialized(), true)
    for (const filetype of ["javascript", "javascriptreact", "typescript", "typescriptreact", "markdown", "markdown_inline", "zig"]) {
      assert.equal(await client.preloadParser(filetype), true, `Actual client default parser ${filetype}`)
    }

    const javascript = "const answer = 42;\n"
    const js = await client.highlightOnce(javascript, "javascript")
    assert.equal(js.error, undefined)
    assert.ok(js.highlights.some(([start, end, group]) => javascript.slice(start, end) === "42" && group === "number"))

    const markdown = "# title\n\nSome **bold** text.\n\n```js\nconst answer = 42;\n```\n"
    const md = await client.highlightOnce(markdown, "markdown")
    assert.equal(md.error, undefined)
    assert.ok(md.highlights.some(([start, end, group, meta]) => markdown.slice(start, end) === "42" && group === "number" && meta?.isInjection === true && meta.injectionLang === "javascript"))
    assert.ok(md.highlights.some(([, , , meta]) => meta?.injectionLang === "markdown_inline"))

    const bufferId = 23
    const initialized = waitForHighlight(client, bufferId, 1)
    assert.equal(await client.createBuffer(bufferId, javascript, "javascript"), true)
    await initialized
    assert.equal(client.getBuffer(bufferId).content, javascript)

    const edited = javascript.replace("42", '"forty two"')
    const updated = waitForHighlight(client, bufferId, 2)
    await client.updateBuffer(bufferId, [{
      startIndex: 15,
      oldEndIndex: 17,
      newEndIndex: 26,
      startPosition: { row: 0, column: 15 },
      oldEndPosition: { row: 0, column: 17 },
      newEndPosition: { row: 0, column: 26 },
    }], edited, 2)
    const lines = await updated
    assert.ok(lines.flatMap((line) => line.highlights).some((capture) => capture.group === "string" && edited.slice(capture.startCol, capture.endCol).includes("forty two")))
    assert.equal(lines.flatMap((line) => line.highlights).some((capture) => capture.group === "number"), false)
    assert.equal(client.getBuffer(bufferId).version, 2)

    const reset = waitForHighlight(client, bufferId, 3)
    await client.resetBuffer(bufferId, 3, javascript)
    assert.ok((await reset).flatMap((line) => line.highlights).some((capture) => capture.group === "number"))
    await client.removeBuffer(bufferId)
    assert.deepEqual(client.getAllBuffers(), [])

    if (custom) {
      for (const [filetype, wasm, query] of [["custom-local", custom.wasm, custom.query], ["custom-http", custom.url + "/parser.wasm", custom.url + "/highlights.scm"]]) {
        client.addFiletypeParser({ filetype, wasm, queries: { highlights: [query] } })
        const response = await client.highlightOnce("customName", filetype)
        assert.equal(response.error, undefined)
        assert.ok(response.highlights.some(([start, end, group]) => start === 0 && end === 10 && group === "standalone.custom"))
      }
    }

    assert.equal(await client.preloadParser("does-not-exist"), false)
    const performance = await client.getPerformance()
    assert.ok(performance.parseTimes.length > 0)
    assert.ok(performance.queryTimes.length > 0)
    await client.setDataPath(join(dataPath, "next"))
    await client.clearCache()
    assert.deepEqual((await client.highlightOnce(javascript, "javascript")).highlights, js.highlights)

    await client.destroy()
    assert.equal(destroyed, 1)
    assert.equal(client.isInitialized(), false)
    await client.initialize()
    assert.deepEqual((await client.highlightOnce(javascript, "javascript")).highlights, js.highlights)
    assert.deepEqual(errors, [])
    assert.deepEqual(warnings, [])
    assert.deepEqual(logs.filter((entry) => entry.type === "error"), [])
    return { upstream: "@opentui/core@0.6.6", actualClient: true, javascriptCaptures: js.highlights.length, markdownCaptures: md.highlights.length, incrementalLines: lines.length, custom: Boolean(custom), workerRestarted: true }
  } finally {
    await client.destroy()
  }
}

function waitForHighlight(client, bufferId, version) {
  return new Promise((resolve, reject) => {
    const onHighlight = (id, revision, highlights) => {
      if (id !== bufferId || revision !== version) return
      clearTimeout(timer)
      client.off("highlights:response", onHighlight)
      resolve(highlights)
    }
    const timer = setTimeout(() => {
      client.off("highlights:response", onHighlight)
      reject(new Error(`Published TreeSitterClient highlight deadline exceeded for buffer ${bufferId} version ${version}`))
    }, 15000)
    client.on("highlights:response", onHighlight)
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const custom = process.argv[3] ? { wasm: process.argv[3], query: process.argv[4], url: process.argv[5] } : undefined
  console.log(JSON.stringify(await runParserClientProof(resolve(process.argv[2] ?? ".parser-data"), custom)))
}
