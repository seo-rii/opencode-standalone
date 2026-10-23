import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createParserWorker, getEmbeddedParsers, embeddedTreeSitterWasm } from "./runtime.mjs"

export async function runParserProof(dataPath, custom) {
  const results = []
  for (const iteration of [1, 2]) {
    const worker = createParserWorker({ name: `opencode-parser-proof-${iteration}` })
    const protocol = createProtocol(worker)
    try {
      const initialized = await protocol.request({ type: "INIT", dataPath, treeSitterWasmPath: embeddedTreeSitterWasm() }, "INIT_RESPONSE")
      assert.equal(initialized.error, undefined)
      for (const filetypeParser of getEmbeddedParsers()) protocol.send({ type: "ADD_FILETYPE_PARSER", filetypeParser })
      for (const filetype of ["javascript", "javascriptreact", "typescript", "typescriptreact", "markdown", "markdown_inline", "zig"]) {
        const preloaded = await protocol.request({ type: "PRELOAD_PARSER", filetype, messageId: `preload-${filetype}` }, "PRELOAD_PARSER_RESPONSE")
        assert.equal(preloaded.hasParser, true, `Real default parser ${filetype}: ${JSON.stringify(protocol.logs)}`)
      }

      const javascript = "const answer = 42;\n"
      const js = await protocol.request({ type: "ONESHOT_HIGHLIGHT", content: javascript, filetype: "javascript", messageId: "js" }, "ONESHOT_HIGHLIGHT_RESPONSE")
      assert.equal(js.hasParser, true)
      assert.ok(js.highlights.some(([start, end, group]) => javascript.slice(start, end) === "42" && group === "number"))
      assert.ok(js.highlights.some(([start, end, group]) => javascript.slice(start, end) === "const" && group.startsWith("keyword")))

      const languages = []
      for (const [filetype, content, text, group] of [
        ["typescript", "interface User { age: number }", "User", "type"],
        ["typescriptreact", 'const view = <Box title="hello" />;', "Box", "tag"],
        ["markdown_inline", "Some **bold** text", "**bold**", "markup.strong"],
        ["zig", "pub fn main() void { return; }", "fn", "keyword.function"],
      ]) {
        const response = await protocol.request({ type: "ONESHOT_HIGHLIGHT", content, filetype, messageId: `capture-${filetype}` }, "ONESHOT_HIGHLIGHT_RESPONSE")
        assert.equal(response.hasParser, true)
        assert.ok(response.highlights.some(([start, end, capture]) => content.slice(start, end) === text && capture === group), `${filetype}: ${JSON.stringify(response.highlights)}`)
        languages.push(filetype)
      }

      const markdown = "# title\n\nSome **bold** text.\n\n```js\nconst answer = 42;\n```\n"
      const md = await protocol.request({ type: "ONESHOT_HIGHLIGHT", content: markdown, filetype: "markdown", messageId: "md" }, "ONESHOT_HIGHLIGHT_RESPONSE")
      assert.equal(md.hasParser, true)
      assert.ok(md.highlights.some(([start, end, group, meta]) => markdown.slice(start, end) === "42" && group === "number" && meta?.isInjection === true && meta.injectionLang === "javascript"))
      assert.ok(md.highlights.some(([, , , meta]) => meta?.injectionLang === "markdown_inline"))

      const bufferId = 17
      const created = await protocol.request({ type: "INITIALIZE_PARSER", bufferId, version: 1, content: javascript, filetype: "javascript", messageId: "buffer" }, "PARSER_INIT_RESPONSE")
      assert.equal(created.hasParser, true)
      await protocol.wait((message) => message.type === "HIGHLIGHT_RESPONSE" && message.bufferId === bufferId && message.version === 1)
      const edited = javascript.replace("42", '"forty two"')
      protocol.send({ type: "HANDLE_EDITS", bufferId, version: 2, content: edited, edits: [{
        startIndex: 15,
        oldEndIndex: 17,
        newEndIndex: 26,
        startPosition: { row: 0, column: 15 },
        oldEndPosition: { row: 0, column: 17 },
        newEndPosition: { row: 0, column: 26 },
      }] })
      const edit = await protocol.wait((message) => message.type === "HIGHLIGHT_RESPONSE" && message.bufferId === bufferId && message.version === 2)
      assert.ok(edit.highlights.flatMap((line) => line.highlights).some((capture) => capture.group === "string" && edited.slice(capture.startCol, capture.endCol).includes("forty two")))
      assert.equal(edit.highlights.flatMap((line) => line.highlights).some((capture) => capture.group === "number"), false)

      protocol.send({ type: "RESET_BUFFER", bufferId, version: 3, content: javascript, edits: [] })
      const reset = await protocol.wait((message) => message.type === "HIGHLIGHT_RESPONSE" && message.bufferId === bufferId && message.version === 3)
      assert.ok(reset.highlights.flatMap((line) => line.highlights).some((capture) => capture.group === "number"))
      protocol.send({ type: "DISPOSE_BUFFER", bufferId })
      await protocol.wait((message) => message.type === "BUFFER_DISPOSED" && message.bufferId === bufferId)

      if (custom && iteration === 1) {
        for (const [filetype, wasm, query] of [["custom-local", custom.wasm, custom.query], ["custom-http", custom.url + "/parser.wasm", custom.url + "/highlights.scm"]]) {
          protocol.send({ type: "ADD_FILETYPE_PARSER", filetypeParser: { filetype, wasm, queries: { highlights: [query] } } })
          const response = await protocol.request({ type: "ONESHOT_HIGHLIGHT", content: "customName", filetype, messageId: filetype }, "ONESHOT_HIGHLIGHT_RESPONSE")
          assert.equal(response.hasParser, true, JSON.stringify(protocol.logs))
          assert.ok(response.highlights.some(([start, end, group]) => start === 0 && end === 10 && group === "standalone.custom"))
        }
      }

      const unknown = await protocol.request({ type: "PRELOAD_PARSER", filetype: "does-not-exist", messageId: "unknown" }, "PRELOAD_PARSER_RESPONSE")
      assert.equal(unknown.hasParser, false)
      const performance = await protocol.request({ type: "GET_PERFORMANCE", messageId: "performance" }, "PERFORMANCE_RESPONSE")
      assert.ok(performance.performance.parseTimes.length > 0)
      assert.ok(performance.performance.queryTimes.length > 0)
      const pathChanged = await protocol.request({ type: "UPDATE_DATA_PATH", dataPath: join(dataPath, "next"), messageId: "path" }, "UPDATE_DATA_PATH_RESPONSE")
      assert.equal(pathChanged.error, undefined)
      const cleared = await protocol.request({ type: "CLEAR_CACHE", messageId: "clear" }, "CLEAR_CACHE_RESPONSE")
      assert.equal(cleared.error, undefined)
      const reloaded = await protocol.request({ type: "ONESHOT_HIGHLIGHT", content: javascript, filetype: "javascript", messageId: "reload" }, "ONESHOT_HIGHLIGHT_RESPONSE")
      assert.deepEqual(reloaded.highlights, js.highlights)
      assert.deepEqual(protocol.logs.filter((message) => message.logType === "error"), [])
      results.push({ iteration, languages, javascriptCaptures: js.highlights.length, markdownCaptures: md.highlights.length, injectedCaptures: md.highlights.filter(([, , , meta]) => meta?.isInjection).length, incrementalLines: edit.highlights.length })
    } finally {
      await worker.terminate()
    }
  }
  return { upstream: "@opentui/core@0.6.6", runtime: "web-tree-sitter@0.25.10", results, custom: Boolean(custom), workerTerminated: true }
}

function createProtocol(worker) {
  const messages = []
  const waiting = new Set()
  const logs = []
  worker.on("message", (message) => {
    if (message.type === "WORKER_LOG") {
      logs.push(message)
      return
    }
    for (const request of waiting) {
      if (!request.matches(message)) continue
      waiting.delete(request)
      clearTimeout(request.timer)
      request.resolve(message)
      return
    }
    messages.push(message)
  })
  worker.on("error", (error) => {
    for (const request of waiting) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    waiting.clear()
  })
  function wait(matches) {
    const index = messages.findIndex(matches)
    if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const request = { matches, resolve, reject, timer: setTimeout(() => {
        waiting.delete(request)
        reject(new Error(`OpenTUI parser response deadline exceeded; messages=${JSON.stringify(messages).slice(0, 2000)}; logs=${JSON.stringify(logs).slice(0, 2000)}`))
      }, 15000) }
      waiting.add(request)
    })
  }
  return {
    logs,
    send(message) { worker.postMessage(message) },
    wait,
    request(message, type) {
      const response = wait((value) => value.type === type && (message.messageId === undefined || value.messageId === message.messageId))
      worker.postMessage(message)
      return response
    },
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const custom = process.argv[3] ? { wasm: process.argv[3], query: process.argv[4], url: process.argv[5] } : undefined
  console.log(JSON.stringify(await runParserProof(resolve(process.argv[2] ?? ".parser-data"), custom)))
}
