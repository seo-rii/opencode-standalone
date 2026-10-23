import assert from "node:assert/strict"
import { test } from "node:test"
import { createTerminal } from "./terminal.ts"

test("Ghostty parses VT edits, UTF-8, title and device replies and produces restorable checkpoints", async () => {
  const terminal = await createTerminal(20, 4)
  const restored = await createTerminal(20, 4)
  try {
    terminal.write(Buffer.from("\x1b]0;terminal title\x07\x1b[31moutdated\x1b[0m\r한글\x1b[K\r\nnext\x1b[6n"))
    assert.equal(terminal.title(), "terminal title")
    assert.deepEqual(terminal.takeResponses(), [Buffer.from("\x1b[2;5R")])
    assert.deepEqual(terminal.cursor(), { cursor_x: 4, cursor_y: 1 })
    assert.equal(terminal.snapshot().text, "한글\nnext")
    restored.write(terminal.checkpoint())
    assert.equal(restored.snapshot().text, terminal.snapshot().text)
    assert.deepEqual(restored.cursor(), terminal.cursor())
    assert.deepEqual(terminal.readRows(), { lines: ["한글", "next", "", ""], cursor_x: 4, cursor_y: 1 })
  } finally { terminal.free(); restored.free() }
})

test("Ghostty row reads include scrollback and blank physical rows without joining wraps", async () => {
  const terminal = await createTerminal(5, 3)
  try {
    terminal.write(Buffer.from("1234567\r\n\r\nlast"))
    assert.deepEqual(terminal.readRows(4).lines, ["12345", "67", "", "last"])
    assert.deepEqual(terminal.readRows().lines, ["67", "", "last"])
    assert.throws(() => terminal.readRows(0), /positive/)
    terminal.resize(10, 4)
    assert.deepEqual(terminal.cursor(), { cursor_x: 4, cursor_y: 2 })
  } finally { terminal.free() }
})
