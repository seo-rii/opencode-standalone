import { createReadStream } from "node:fs"
import path from "node:path"
import { RE2JS } from "re2js"
import { inaccessible, walk } from "./walk.ts"

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly literal?: boolean
  readonly caseSensitive?: boolean
  readonly limit: number
  readonly signal?: AbortSignal
}

export type Entry = { path: string; type: "file" }
export type Match = {
  entry: Entry
  line: number
  offset: number
  text: string
  submatches: { text: string; start: number; end: number }[]
}

export class PatternError extends Error {
  readonly pattern: string

  constructor(pattern: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "PatternError"
    this.pattern = pattern
  }
}

export async function files(input: GlobInput & { exclude?: readonly string[]; find?: boolean }) {
  input.signal?.throwIfAborted()
  const result: Entry[] = []
  if (input.limit <= 0) return result
  // Find("*") omits --glob upstream; other positive find globs include hidden files.
  const pattern = input.find && input.pattern === "*" ? undefined : input.pattern
  const hidden = input.hidden || !!(input.find && pattern && !pattern.startsWith("!"))
  for await (const relative of walk({ ...input, pattern, hidden })) {
    result.push({ path: relative, type: "file" })
    if (result.length >= input.limit) break
  }
  return result
}

export async function grep(input: GrepInput) {
  input.signal?.throwIfAborted()
  const expression = (() => {
    try {
      return RE2JS.compile(
        input.literal ? RE2JS.quote(input.pattern) : input.pattern,
        input.caseSensitive === false ? RE2JS.CASE_INSENSITIVE : 0,
      )
    } catch (cause) {
      throw new PatternError(input.pattern, cause)
    }
  })()
  const results: Match[] = []
  if (input.limit <= 0) return results
  const candidates = input.file
    ? [input.file]
    : walk({ cwd: input.cwd, pattern: input.include, hidden: true, signal: input.signal })
  for await (const file of candidates) {
    input.signal?.throwIfAborted()
    // Explicit file arguments bypass ignore files, just as ripgrep does.
    const relative = path.relative(input.cwd, path.resolve(input.cwd, file)).split(path.sep).join("/")
    if (relative.split("/").includes(".git")) continue
    try {
      for await (const line of lines(path.resolve(input.cwd, file), input.signal)) {
        const text = line.bytes.toString("utf8")
        const content = text.endsWith("\n") ? text.slice(0, -1) : text
        const matcher = expression.matcher(content)
        const submatches: Match["submatches"] = []
        while (submatches.length < 100 && matcher.find()) {
          const start = matcher.start()
          const end = matcher.end()
          submatches.push({
            text: content.slice(start, end),
            start: Buffer.byteLength(content.slice(0, start)),
            end: Buffer.byteLength(content.slice(0, end)),
          })
        }
        if (!submatches.length) continue
        results.push({
          entry: { path: relative, type: "file" },
          line: line.number,
          offset: line.offset,
          text: text.length > 2_000 ? text.slice(0, 2_000) + "..." : text,
          submatches,
        })
        if (results.length >= input.limit) return results
      }
    } catch (cause) {
      if (inaccessible(cause)) continue
      throw cause
    }
  }
  return results
}

async function* lines(file: string, signal?: AbortSignal) {
  const stream = createReadStream(file, { signal })
  let pending: Buffer[] = []
  let offset = 0
  let number = 1
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      const bytes = Buffer.from(chunk)
      if (bytes.includes(0)) return
      let start = 0
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        signal?.throwIfAborted()
        const part = bytes.subarray(start, end + 1)
        const line = pending.length ? Buffer.concat([...pending, part]) : part
        pending = []
        yield { bytes: line, offset, number }
        offset += line.length
        number++
        start = end + 1
      }
      if (start < bytes.length) pending.push(bytes.subarray(start))
    }
    if (pending.length) yield { bytes: Buffer.concat(pending), offset, number }
  } finally {
    stream.destroy()
  }
}
