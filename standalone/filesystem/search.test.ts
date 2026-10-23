import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { promisify } from "node:util"
import { files, grep, PatternError } from "./search.ts"

async function fixture(context: TestContext, content: Record<string, string | Uint8Array>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-standalone-search-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all(
    Object.entries(content).map(async ([name, bytes]) => {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true })
      await writeFile(path.join(directory, name), bytes)
    }),
  )
  return directory
}

test("glob excludes hidden paths and Git metadata before applying its limit", async (context) => {
  const cwd = await fixture(context, {
    ".git/config.ts": "secret",
    ".hidden.ts": "hidden",
    ".hidden/nested.ts": "hidden",
    "src/visible.ts": "visible",
  })
  assert.deepEqual(await files({ cwd, pattern: "**/*.ts", limit: 1 }), [
    { path: "src/visible.ts", type: "file" },
  ])
  assert.deepEqual(
    (await files({ cwd, pattern: "**/*.ts", hidden: true, limit: 20 })).map((entry) => entry.path),
    [".hidden/nested.ts", ".hidden.ts", "src/visible.ts"],
  )
})

test("catch-all find honors nested Git ignores and .rgignore precedence", async (context) => {
  const cwd = await fixture(context, {
    ".git/config": "",
    ".git/info/exclude": "private.txt\n",
    ".gitignore": "build/\n*.log\n",
    ".ignore": "src/hidden.txt\n",
    ".rgignore": "!src/hidden.txt\n",
    "build/generated.js": "ignored",
    "root.log": "ignored",
    "private.txt": "ignored",
    "src/.gitignore": "!keep.log\n",
    "src/keep.log": "kept",
    "src/other.log": "ignored",
    "src/hidden.txt": "kept",
    "src/index.ts": "kept",
  })
  assert.deepEqual(
    (await files({ cwd, pattern: "*", find: true, limit: 20 })).map((entry) => entry.path),
    ["src/hidden.txt", "src/index.ts", "src/keep.log"],
  )
  assert.deepEqual(
    (await files({ cwd: path.join(cwd, "src"), pattern: "*", find: true, limit: 20 })).map((entry) => entry.path),
    ["hidden.txt", "index.ts", "keep.log"],
  )
})

test("positive find globs override ignore files and hidden filtering, while excludes still win", async (context) => {
  const cwd = await fixture(context, {
    ".git/config": "",
    ".gitignore": "generated/\n",
    ".opencode/config.ts": "hidden",
    "generated/index.ts": "generated",
    "src/index.ts": "source",
    "Pictures/private.ts": "private",
  })
  assert.deepEqual(
    (
      await files({ cwd, pattern: "**/*.ts", find: true, exclude: ["Pictures/**"], limit: 20 })
    ).map((entry) => entry.path),
    [".opencode/config.ts", "generated/index.ts", "src/index.ts"],
  )
})

test("Git ignore files require a repository but ordinary ignore files do not", async (context) => {
  const cwd = await fixture(context, {
    ".gitignore": "visible.txt\n",
    ".ignore": "excluded.txt\n",
    "visible.txt": "visible",
    "excluded.txt": "excluded",
  })
  assert.deepEqual(await files({ cwd, pattern: "*", find: true, limit: 20 }), [
    { path: "visible.txt", type: "file" },
  ])
})

test("global Git excludes and worktree info/exclude apply without a Git executable", async (context) => {
  const cwd = await fixture(context, {
    ".gitconfig": '[include]\n  path = "git settings"\n',
    "git settings": '[core]\n  excludesFile = "~/global ignore" # comment\n',
    "global ignore": "global.txt\n",
    "metadata/config": "",
    "metadata/info/exclude": "private.txt\n",
    "metadata/worktrees/feature/commondir": "../..\n",
    "project/.git": "gitdir: ../metadata/worktrees/feature\n",
    "project/global.txt": "ignored",
    "project/private.txt": "ignored",
    "project/visible.txt": "visible",
  })
  const source = `import { files } from ${JSON.stringify(new URL("./search.ts", import.meta.url).href)};
    console.log(JSON.stringify(await files({ cwd: process.argv[1], pattern: "*", find: true, limit: 20 })));`
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, path.join(cwd, "project")], {
    env: {
      ...process.env,
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: path.join(cwd, ".config"),
      GIT_CONFIG_GLOBAL: path.join(cwd, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: "",
    },
  })
  assert.deepEqual(JSON.parse(result.stdout), [{ path: "visible.txt", type: "file" }])
})

test("following symlinks preserves file aliases and terminates directory cycles", async (context) => {
  if (process.platform === "win32") {
    context.skip("Creating file symlinks requires additional Windows privileges")
    return
  }
  const cwd = await fixture(context, { "src/file.ts": "needle" })
  await symlink("src/file.ts", path.join(cwd, "alias.ts"))
  await symlink("..", path.join(cwd, "src/cycle"))
  assert.deepEqual(await files({ cwd, pattern: "*", find: true, limit: 20 }), [
    { path: "src/file.ts", type: "file" },
  ])
  assert.deepEqual(await files({ cwd, pattern: "*", find: true, follow: true, limit: 20 }), [
    { path: "alias.ts", type: "file" },
    { path: "src/file.ts", type: "file" },
  ])
})

test("grep preserves UTF-8 byte offsets, CRLF, hidden files, and include filters", async (context) => {
  const cwd = await fixture(context, {
    ".git/config.ts": "needle\n",
    ".hidden.ts": "α\n🙂needle🙂needle\r\n",
    "skip.txt": "needle\n",
  })
  assert.deepEqual(await grep({ cwd, pattern: "needle", include: "*.ts", limit: 20 }), [
    {
      entry: { path: ".hidden.ts", type: "file" },
      line: 2,
      offset: 3,
      text: "🙂needle🙂needle\r\n",
      submatches: [
        { text: "needle", start: 4, end: 10 },
        { text: "needle", start: 14, end: 20 },
      ],
    },
  ])
})

test("grep supports literal and insensitive matching and rejects invalid expressions", async (context) => {
  const cwd = await fixture(context, { "file.txt": "A+B aab\n" })
  const result = await grep({ cwd, pattern: "a+b", literal: true, caseSensitive: false, limit: 10 })
  assert.deepEqual(result[0]?.submatches, [{ text: "A+B", start: 0, end: 3 }])
  await assert.rejects(grep({ cwd, pattern: "[", limit: 10 }), PatternError)
  await assert.rejects(grep({ cwd, pattern: "(a)\\1", limit: 10 }), PatternError)
})

test("grep bounds previews, submatches and result counts, and handles a final line without newline", async (context) => {
  const cwd = await fixture(context, {
    "large.txt": `Cloudflare${"x".repeat(70 * 1024)}\n${"needle ".repeat(150)}\nneedle`,
    "binary.dat": Buffer.from("needle\0binary"),
  })
  const preview = await grep({ cwd, pattern: "Cloudflare", limit: 10 })
  assert.equal(preview.length, 1)
  assert.equal(preview[0]?.text.length, 2_003)
  assert.deepEqual(preview[0]?.submatches, [{ text: "Cloudflare", start: 0, end: 10 }])
  const bounded = await grep({ cwd, pattern: "needle", limit: 1 })
  assert.equal(bounded.length, 1)
  assert.equal(bounded[0]?.submatches.length, 100)
  const full = await grep({ cwd, pattern: "needle", limit: 10 })
  assert.equal(full.length, 2)
  assert.equal(full[1]?.line, 3)
  assert.equal(full[1]?.text, "needle")
  assert.equal(full[1]?.offset, Buffer.byteLength(`Cloudflare${"x".repeat(70 * 1024)}\n${"needle ".repeat(150)}\n`))
})

test("already-aborted searches reject without producing results", async (context) => {
  const cwd = await fixture(context, { "file.txt": "needle" })
  const signal = AbortSignal.abort(new Error("cancelled"))
  await assert.rejects(files({ cwd, pattern: "*", limit: 10, signal }), /cancelled/)
  await assert.rejects(grep({ cwd, pattern: "needle", limit: 10, signal }), /cancelled/)
})
