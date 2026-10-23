import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

type Layout = { size: number; align: number; fields: Record<string, { offset: number; size: number; type: string }> }
type Exports = WebAssembly.Exports & {
  memory: WebAssembly.Memory
  __indirect_function_table: WebAssembly.Table
  ghostty_type_json(): number
  ghostty_wasm_alloc_u8_array(length: number): number
  ghostty_wasm_free_u8_array(pointer: number, length: number): void
  ghostty_core_terminal_new(allocator: number, output: number, options: number): number
  ghostty_core_terminal_free(terminal: number): void
  ghostty_core_terminal_resize(terminal: number, cols: number, rows: number, width: number, height: number): number
  ghostty_terminal_vt_write(terminal: number, data: number, length: number): void
  ghostty_terminal_get(terminal: number, key: number, output: number): number
  ghostty_terminal_set(terminal: number, key: number, value: number): number
  ghostty_terminal_grid_ref(terminal: number, point: number, output: number): number
  ghostty_formatter_terminal_new(allocator: number, output: number, terminal: number, options: number): number
  ghostty_formatter_format_buf(formatter: number, output: number, length: number, written: number): number
  ghostty_formatter_free(formatter: number): void
}

let runtime: Promise<Awaited<ReturnType<typeof load>>> | undefined

/** Uses the pinned Ghostty C API in WASM, including its real VT formatter. */
export async function createTerminal(cols: number, rows: number, scrollback = 2 * 1024 * 1024) {
  return new Terminal(await (runtime ??= load()), cols, rows, scrollback)
}

class Terminal {
  private handle: number
  private runtime: Awaited<ReturnType<typeof load>>
  private responses: Buffer[] = []
  private freed = false

  constructor(runtime: Awaited<ReturnType<typeof load>>, cols: number, rows: number, scrollback: number) {
    this.runtime = runtime
    this.handle = runtime.struct("GhosttyTerminalOptions", (options) => {
      runtime.field(options, "GhosttyTerminalOptions", "cols", cols)
      runtime.field(options, "GhosttyTerminalOptions", "rows", rows)
      runtime.field(options, "GhosttyTerminalOptions", "max_scrollback", scrollback)
      return runtime.buffer(4, (output) => {
        check(runtime.exports.ghostty_core_terminal_new(0, output, options))
        return runtime.view().getUint32(output, true)
      })
    })
    runtime.terminals.set(this.handle, this.responses)
    // Function pointers are WASM table indices, not linear-memory addresses.
    check(runtime.exports.ghostty_terminal_set(this.handle, 1, runtime.writeCallback))
  }

  write(bytes: Uint8Array) {
    this.runtime.buffer(bytes.byteLength, (pointer) => {
      new Uint8Array(this.runtime.exports.memory.buffer).set(bytes, pointer)
      this.runtime.exports.ghostty_terminal_vt_write(this.handle, pointer, bytes.byteLength)
    })
  }

  resize(cols: number, rows: number) {
    check(this.runtime.exports.ghostty_core_terminal_resize(this.handle, cols, rows, 0, 0))
  }

  takeResponses() {
    return this.responses.splice(0)
  }

  title() {
    return this.runtime.buffer(8, (output) => {
      check(this.runtime.exports.ghostty_terminal_get(this.handle, 12, output))
      const pointer = this.runtime.view().getUint32(output, true)
      const length = this.runtime.view().getUint32(output + 4, true)
      return Buffer.from(this.runtime.exports.memory.buffer, pointer, length).toString("utf8")
    })
  }

  cursor() {
    return { cursor_x: this.get(3, 2), cursor_y: this.get(4, 2) }
  }

  snapshot() {
    const cursor = this.cursor()
    return {
      text: this.format(0).toString("utf8"),
      checkpoint: Buffer.concat([
        this.format(1),
        Buffer.from(`\x1b[${cursor.cursor_y + 1};${cursor.cursor_x + 1}H`),
      ]),
      ...cursor,
    }
  }

  checkpoint() {
    const cursor = this.cursor()
    return Buffer.concat([this.format(1), Buffer.from(`\x1b[${cursor.cursor_y + 1};${cursor.cursor_x + 1}H`)])
  }

  readRows(rows?: number) {
    const count = rows ?? this.get(2, 2)
    if (!Number.isInteger(count) || count < 1 || count > 65535) throw new Error("row count must be positive and fit u16")
    const total = this.get(14, 4)
    const length = Math.min(total, count)
    let bytes = 2 + length * 25
    if (bytes > 1024 * 1024) throw new Error("rows exceed 1048576 byte limit")
    const lines = Array.from({ length }, (_, index) => {
      const line = this.runtime.struct("GhosttySelection", (selection) => {
        const layout = this.runtime.layouts.GhosttySelection
        this.gridRef(0, total - length + index, selection + layout.fields.start.offset)
        this.gridRef(this.get(1, 2) - 1, total - length + index, selection + layout.fields.end.offset)
        return this.format(0, selection).toString("utf8")
      })
      bytes += Buffer.byteLength(JSON.stringify(line))
      if (bytes > 1024 * 1024) throw new Error("rows exceed 1048576 byte limit")
      return line
    })
    return { lines, ...this.cursor() }
  }

  free() {
    if (this.freed) return
    this.freed = true
    this.runtime.exports.ghostty_core_terminal_free(this.handle)
    this.runtime.terminals.delete(this.handle)
  }

  private get(key: number, size: 2 | 4) {
    return this.runtime.buffer(4, (output) => {
      check(this.runtime.exports.ghostty_terminal_get(this.handle, key, output))
      return size === 2 ? this.runtime.view().getUint16(output, true) : this.runtime.view().getUint32(output, true)
    })
  }

  private gridRef(x: number, y: number, output: number) {
    this.runtime.struct("GhosttyPoint", (point) => {
      this.runtime.field(point, "GhosttyPoint", "tag", 2)
      const value = point + this.runtime.layouts.GhosttyPoint.fields.value.offset
      this.runtime.field(value, "GhosttyPointCoordinate", "x", x)
      this.runtime.field(value, "GhosttyPointCoordinate", "y", y)
      this.runtime.field(output, "GhosttyGridRef", "size", this.runtime.layouts.GhosttyGridRef.size)
      check(this.runtime.exports.ghostty_terminal_grid_ref(this.handle, point, output))
    })
  }

  private format(emit: 0 | 1, selection = 0) {
    return this.runtime.struct("GhosttyFormatterTerminalOptions", (options) => {
      this.runtime.field(options, "GhosttyFormatterTerminalOptions", "emit", emit)
      this.runtime.field(options, "GhosttyFormatterTerminalOptions", "trim", 1)
      this.runtime.field(options, "GhosttyFormatterTerminalOptions", "selection", selection)
      const extra = options + this.runtime.layouts.GhosttyFormatterTerminalOptions.fields.extra.offset
      this.runtime.field(extra, "GhosttyFormatterTerminalExtra", "size", this.runtime.layouts.GhosttyFormatterTerminalExtra.size)
      for (const field of ["modes", "scrolling_region", "tabstops", "pwd", "keyboard"])
        this.runtime.field(extra, "GhosttyFormatterTerminalExtra", field, selection ? 0 : 1)
      const screen = extra + this.runtime.layouts.GhosttyFormatterTerminalExtra.fields.screen.offset
      this.runtime.field(screen, "GhosttyFormatterScreenExtra", "size", this.runtime.layouts.GhosttyFormatterScreenExtra.size)
      for (const field of ["style", "hyperlink", "protection", "kitty_keyboard", "charsets"])
        this.runtime.field(screen, "GhosttyFormatterScreenExtra", field, selection ? 0 : 1)
      return this.runtime.buffer(4, (output) => {
        check(this.runtime.exports.ghostty_formatter_terminal_new(0, output, this.handle, options))
        const formatter = this.runtime.view().getUint32(output, true)
        try {
          const measured = this.runtime.exports.ghostty_formatter_format_buf(formatter, 0, 0, output)
          if (measured !== -3) check(measured)
          const length = this.runtime.view().getUint32(output, true)
          if (length > 6 * 1024 * 1024) throw new Error("terminal snapshot exceeds frame limit")
          return this.runtime.buffer(length, (pointer) => {
            check(this.runtime.exports.ghostty_formatter_format_buf(formatter, pointer, length, output))
            return Buffer.from(new Uint8Array(this.runtime.exports.memory.buffer, pointer, length))
          })
        } finally {
          this.runtime.exports.ghostty_formatter_free(formatter)
        }
      })
    })
  }
}

async function load() {
  // The build substitutes this import with embedded bytes. Source tests use the
  // same pinned package asset without loading its browser-facing JavaScript.
  const bytes = await import("virtual:standalone-persistent-pty-wasm")
    .then((value: { default: Uint8Array }) => value.default)
    .catch(() => readFile(createRequire(import.meta.url).resolve("ghostty-web/ghostty-vt.wasm")))
  const instantiated = await WebAssembly.instantiate(new Uint8Array(bytes), { env: { log() {} } })
  const exports = instantiated.instance.exports as Exports
  const view = () => new DataView(exports.memory.buffer)
  const pointer = exports.ghostty_type_json()
  const memory = new Uint8Array(exports.memory.buffer)
  const layouts = JSON.parse(Buffer.from(memory.subarray(pointer, memory.indexOf(0, pointer))).toString()) as Record<string, Layout>
  const buffer = <T>(length: number, use: (pointer: number) => T): T => {
    const pointer = exports.ghostty_wasm_alloc_u8_array(Math.max(1, length))
    if (!pointer) throw new Error("Ghostty WASM allocation failed")
    new Uint8Array(exports.memory.buffer, pointer, Math.max(1, length)).fill(0)
    try {
      return use(pointer)
    } finally {
      exports.ghostty_wasm_free_u8_array(pointer, Math.max(1, length))
    }
  }
  const field = (pointer: number, type: string, name: string, value: number) => {
    const definition = layouts[type].fields[name]
    if (definition.size === 1) return view().setUint8(pointer + definition.offset, value)
    if (definition.size === 2) return view().setUint16(pointer + definition.offset, value, true)
    if (definition.size === 4) return view().setUint32(pointer + definition.offset, value, true)
    throw new Error(`Unsupported Ghostty field ABI: ${type}.${name}`)
  }
  const struct = <T>(type: string, use: (pointer: number) => T) => buffer(layouts[type].size, (pointer) => {
    if (layouts[type].fields.size) field(pointer, type, "size", layouts[type].size)
    return use(pointer)
  })
  const terminals = new Map<number, Buffer[]>()
  // A tiny WASM import/export bridge gives the JS callback a typed funcref that
  // can be installed in Ghostty's existing indirect-function table.
  const bridge = await WebAssembly.instantiate(Uint8Array.from([
    0,97,115,109,1,0,0,0, 1,8,1,96,4,127,127,127,127,0,
    2,13,1,3,101,110,118,5,119,114,105,116,101,0,0,
    7,9,1,5,119,114,105,116,101,0,0,
  ]), { env: { write(terminal: number, _userdata: number, pointer: number, length: number) {
    terminals.get(terminal)?.push(Buffer.from(new Uint8Array(exports.memory.buffer, pointer, length)))
  } } })
  const writeCallback = exports.__indirect_function_table.grow(1)
  exports.__indirect_function_table.set(writeCallback, bridge.instance.exports.write)
  return { exports, layouts, view, buffer, field, struct, terminals, writeCallback }
}

function check(result: number) {
  if (result !== 0) throw new Error(`Ghostty C API failed: ${result}`)
}
