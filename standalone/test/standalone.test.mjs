import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { diagnostic, sandbox } from "./harness.mjs"
import { completion, png, prompt, provider } from "./provider-fixture.mjs"

test("copied single file prints version and help with an empty PATH", { timeout: 90_000 }, async (t) => {
  const isolated = await sandbox(t)
  // The ordinary invocation exercises the launcher's Node FFI re-exec as well.
  const version = await isolated.run(["--version"], { ffi: false })
  assert.match(version.stdout, /\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b/, diagnostic(version))
  const help = await isolated.run(["--help"])
  assert.match(help.stdout, /OpenCode command line interface/i, diagnostic(help))
  assert.match(help.stdout, /\brun\b/, diagnostic(help))
  assert.match(help.stdout, /\bserve\b/, diagnostic(help))
})

test("copied single file serves, runs real streamed tools, and persists sessions across restart", { timeout: 150_000 }, async (t) => {
  const fixture = await provider(t)
  const isolated = await sandbox(t, fixture.config)
  const sample = path.join(isolated.paths.project, "sample.txt")
  await writeFile(sample, "standalone needle original\n")
  await writeFile(path.join(isolated.paths.project, "pixel.png"), png)
  const configuration = path.join(isolated.paths.project, ".opencode")
  await mkdir(configuration)
  const plugin = path.join(configuration, "sdk-plugin")
  await mkdir(plugin)
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "standalone-sdk-check", type: "module" }))
  await writeFile(path.join(plugin, "server.js"), `import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Plugin, Location, Mcp, PersistentPty, Rpc, Vcs, WebSearch, Worktree } from "@opencode/plugin"
import { define } from "@opencode/plugin/promise/plugin"

export default define({
  id: "standalone-sdk-check",
  async setup(context) {
    assert.equal(Plugin.define, define)
    const effect = await import("@opencode/plugin/effect")
    for (const [name, value] of Object.entries({ Location, Mcp, PersistentPty, Rpc, Vcs, WebSearch, Worktree })) {
      assert.equal(typeof value, "object", name)
      assert.equal(effect[name], value, name)
    }
    await writeFile(path.join(context.location.directory, "sdk-check.json"), JSON.stringify({ loaded: true }))
  },
})
`)
  const effectPlugin = path.join(configuration, "effect-sdk-plugin")
  await mkdir(effectPlugin)
  await writeFile(path.join(effectPlugin, "package.json"), JSON.stringify({ name: "standalone-effect-sdk-check", type: "module" }))
  await writeFile(path.join(effectPlugin, "server.js"), `import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Plugin } from "@opencode/plugin/effect"
import { Rpc } from "@opencode/plugin/rpc"
import { Effect, Option, Schema } from "effect"
import { some } from "effect/Option"

export default Plugin.define({
  id: "standalone-effect-sdk-check",
  effect: (context) => Effect.gen(function* () {
    const direct = yield* Effect.promise(() => import("effect/Effect"))
    const option = yield* Effect.promise(() => import("effect/Option"))
    assert.equal(Effect, direct)
    assert.equal(Option, option)
    assert.equal(Option.some, some)
    assert.equal(typeof Rpc.define, "function")
    const value = Schema.decodeUnknownSync(Schema.Struct({ loaded: Schema.Boolean }))({ loaded: true })
    yield* Effect.promise(() => writeFile(path.join(context.location.directory, "effect-sdk-check.json"), JSON.stringify(value)))
  }),
})
`)
  await writeFile(path.join(configuration, "opencode.json"), JSON.stringify({ plugins: [plugin, effectPlugin] }))
  const server = await isolated.serve()
  const info = await server.json("/api/info")
  assert.match(info.version, /standalone/)
  assert.ok(info.pid > 0)

  const result = await isolated.run([
    "run", "--server", server.url, "--model", "fixture/test-model", "--format", "json", "--auto",
    "--title", "Standalone persistence fixture", prompt,
  ])
  assert.deepEqual(fixture.failures.map((error) => error.message), [], diagnostic(result))
  const events = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
  const toolEvents = events.filter((event) => event.type === "tool_use")
  assert.deepEqual(toolEvents.map((event) => event.part.tool), ["read", "grep", "edit", "shell", "read"], diagnostic(result))
  assert.ok(toolEvents.every((event) => event.part.state.status === "completed"), diagnostic(result))
  assert.match(result.stdout, new RegExp(completion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), diagnostic(result))
  assert.equal(await readFile(sample, "utf8"), "standalone needle updated\n")
  for (const marker of ["sdk-check.json", "effect-sdk-check.json"]) {
    const loaded = await readFile(path.join(isolated.paths.project, marker), "utf8").catch((cause) => {
      throw new Error(`Plugin did not activate: ${marker}\n${diagnostic(server.output)}`, { cause })
    })
    assert.deepEqual(JSON.parse(loaded), { loaded: true })
  }
  assert.ok(fixture.requests.some((request) => request.messages.some((message) => message.tool_call_id === "call_fixture_image")))

  const listed = await server.json("/api/session")
  const session = listed.data.find((entry) => entry.title === "Standalone persistence fixture")
  assert.ok(session, JSON.stringify(listed))
  const before = await server.json(`/api/session/${session.id}/message`)
  assert.ok(before.data.length > 0)
  assert.match(JSON.stringify(before), /Standalone fixture completed/)
  await server.stop()

  const restarted = await isolated.serve()
  assert.equal((await restarted.json(`/api/session/${session.id}`)).data.title, session.title)
  const after = await restarted.json(`/api/session/${session.id}/message`)
  assert.deepEqual(after.data, before.data)
  assert.equal(await readFile(sample, "utf8"), "standalone needle updated\n")
})
