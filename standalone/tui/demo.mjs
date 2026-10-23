import { createUnicode } from "./unicode.mjs"

const unicode = createUnicode()
const title = "OpenTUI Unicode WASM proof"
const columns = 40
const rows = ["한국어와 English", "👩🏽‍💻 개발자 · 👨‍👩‍👧‍👦 family", "e\u0301 / 🇰🇷 / 日本語", "This is a computation proof, not the full OpenCode TUI."]
const lines = [title, ...rows].flatMap((row) => {
  const wrapped = []
  for (let remaining = row; remaining;) {
    const result = unicode.wrap(remaining, columns)
    if (!result.byteOffset) throw new Error("A grapheme does not fit in the demo frame")
    wrapped.push(`│ ${result.text}${" ".repeat(columns - result.columnsUsed)} │`)
    remaining = result.remainder
  }
  return wrapped
})
const frame = [`┌${"─".repeat(columns + 2)}┐`, ...lines, `└${"─".repeat(columns + 2)}┘`].join("\n")
process.stdout.write(process.stdout.isTTY ? `\u001b[36m${frame}\u001b[0m\n` : `${frame}\n`)

