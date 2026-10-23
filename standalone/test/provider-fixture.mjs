import assert from "node:assert/strict"
import { createServer } from "node:http"
import { setImmediate } from "node:timers/promises"

export const prompt =
  "standalone-fixture: read sample.txt, grep for needle, replace original with updated in sample.txt, execute the shell check, and read pixel.png."
export const completion = "Standalone fixture completed the read, search, edit, shell, and image checks."
// A 2-by-2 RGBA PNG. The provider checks that OpenCode really resizes it to 1-by-1.
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==",
  "base64",
)

// A real OpenAI Chat-compatible HTTP peer. It inspects actual tool results from
// OpenCode before choosing the next streamed function call.
export async function provider(t) {
  const requests = []
  const failures = []
  const calls = [
    { id: "call_fixture_read", name: "read", input: { path: "sample.txt" } },
    { id: "call_fixture_grep", name: "grep", input: { pattern: "needle", include: "*.txt" } },
    {
      id: "call_fixture_edit",
      name: "edit",
      input: { path: "sample.txt", oldString: "original", newString: "updated" },
    },
    {
      id: "call_fixture_shell",
      name: "shell",
      input: { command: "test -z \"$PATH\" && printf 'standalone-shell-ok\\n'", timeout: 10_000 },
    },
    { id: "call_fixture_image", name: "read", input: { path: "pixel.png" } },
  ]
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST")
      assert.equal(request.url, "/v1/chat/completions")
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        assert.ok(size < 8 * 1024 * 1024, "Fixture request exceeded 8 MiB")
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      requests.push(body)
      assert.equal(body.model, "test-model")
      assert.equal(body.stream, true)
      const workflow =
        Array.isArray(body.tools) && body.tools.length > 0 && JSON.stringify(body.messages).includes("standalone-fixture:")
      const results = body.messages.filter((message) => message.role === "tool")
      const pending = workflow ? calls.find((call) => !results.some((result) => result.tool_call_id === call.id)) : undefined
      if (workflow) {
        for (const call of calls)
          assert.ok(body.tools.some((tool) => tool.function.name === call.name), `Missing ${call.name} tool`)
        const read = results.find((result) => result.tool_call_id === calls[0].id)
        const grep = results.find((result) => result.tool_call_id === calls[1].id)
        const shell = results.find((result) => result.tool_call_id === "call_fixture_shell")
        const image = results.find((result) => result.tool_call_id === "call_fixture_image")
        if (read) assert.match(JSON.stringify(read.content), /standalone needle original/)
        if (grep) {
          assert.match(JSON.stringify(grep.content), /sample\.txt/)
          assert.match(JSON.stringify(grep.content), /needle/)
        }
        if (shell) assert.match(JSON.stringify(shell.content), /standalone-shell-ok/)
        if (image) {
          const images = body.messages
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            .filter((item) => item.type === "image_url")
          assert.equal(images.length, 1, "Image read must reach the real provider protocol")
          assert.match(images[0].image_url.url, /^data:image\/png;base64,/)
          const resized = Buffer.from(images[0].image_url.url.split(",")[1], "base64")
          assert.equal(resized.readUInt32BE(16), 1, "Photon must resize the width, not pass the original through")
          assert.equal(resized.readUInt32BE(20), 1, "Photon must resize the height, not pass the original through")
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const send = async (delta, finish = null) => {
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-fixture-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1_700_000_000,
            model: "test-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        )
        await setImmediate()
      }
      await send({ role: "assistant" })
      if (pending) {
        const input = JSON.stringify(pending.input)
        const split = Math.floor(input.length / 2)
        await send({
          tool_calls: [{
            index: 0,
            id: pending.id,
            type: "function",
            function: { name: pending.name, arguments: input.slice(0, split) },
          }],
        })
        await send({ tool_calls: [{ index: 0, function: { arguments: input.slice(split) } }] })
        await send({}, "tool_calls")
      } else {
        await send({ content: workflow ? completion : "Standalone fixture session" })
        await send({}, "stop")
      }
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
      )
      response.end("data: [DONE]\n\n")
    })().catch((error) => {
      failures.push(error)
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: error.message } }))
    })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`
  return {
    requests,
    failures,
    config: {
      model: "fixture/test-model",
      experimental: { portable_shell_scanner: false },
      media: { image: { max_width: 1, max_height: 1 } },
      providers: {
        fixture: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL },
          models: {
            "test-model": {
              name: "Local protocol fixture",
              limit: { context: 32768, output: 2048 },
              capabilities: { tools: true, input: ["text", "image"], output: ["text"], reasoning: { supported: false } },
            },
          },
        },
      },
    },
  }
}
