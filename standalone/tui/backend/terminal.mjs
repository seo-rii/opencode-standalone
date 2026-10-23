const ioBytesMax = 1024 * 1024

/** Preserve the published controller boundary around OpenTUI's real Ghostty terminal. */
export const terminalMethods = {
  terminalMutation(context, request, transfer) {
    return this.getYogaHost().runMutation(() => this.call(context, "terminal", request, transfer))
  },
  terminalBytes(context, request, transfer = {}) {
    return this.terminalMutation(context, request, { ...transfer, read: (result, view) => view(result).slice() })
  },
  createContextEmbeddedTerminal(context, options) {
    return this.issued(context, this.terminalMutation(context, { create: {
      cols: dimension(options.cols, "columns"), rows: dimension(options.rows, "rows"),
      max_scrollback: u32(options.maxScrollback ?? 10_000, "Embedded terminal maxScrollback"),
    } }))
  },
  destroyContextEmbeddedTerminal(context, terminal) {
    return this.terminalMutation(context, { destroy: { terminal: this.handle(context, terminal) } })
  },
  contextEmbeddedTerminalWrite(context, terminal, data) {
    this.getYogaHost().assertMutable()
    const handle = this.handle(context, terminal)
    const input = bytes(typeof data === "string" ? this.encoder.encode(data) : data)
    // Match the original FFI's 1 MiB write admission and preserve parser state
    // between chunks, including UTF-8 and escape sequences crossing the bound.
    for (let offset = 0; offset === 0 || offset < input.byteLength; offset += ioBytesMax) {
      const chunk = input.subarray(offset, offset + ioBytesMax)
      this.terminalMutation(context, ([bytes]) => ({ write: { terminal: handle, bytes } }), { input: [chunk] })
    }
  },
  contextEmbeddedTerminalResize(context, terminal, cols, rows) {
    return this.terminalMutation(context, { resize: { terminal: this.handle(context, terminal), cols: dimension(cols, "columns"), rows: dimension(rows, "rows") } })
  },
  contextTerminalCommand(context, terminal, command, argument = 0) {
    return this.terminalMutation(context, { command: { terminal: this.handle(context, terminal), command, argument: i32(argument, "Embedded terminal command argument") } })
  },
  contextEmbeddedTerminalInvalidate(context, terminal) { return this.contextTerminalCommand(context, terminal, 0) },
  contextEmbeddedTerminalScroll(context, terminal, delta) { return this.contextTerminalCommand(context, terminal, 1, delta) },
  contextEmbeddedTerminalClearSelection(context, terminal) { return this.contextTerminalCommand(context, terminal, 2) },
  contextEmbeddedTerminalSetTransparentBackground(context, terminal, transparent) {
    return this.contextTerminalCommand(context, terminal, this.helpers.nativeConstants.OT_EMBEDDED_TERMINAL_SET_TRANSPARENT_BACKGROUND, transparent ? 1 : 0)
  },
  contextEmbeddedTerminalSetSelection(context, terminal, start, end) {
    return this.terminalMutation(context, { selection: {
      terminal: this.handle(context, terminal), start_x: u32(start.x, "Selection start x"), start_y: u32(start.y, "Selection start y"),
      end_x: u32(end.x, "Selection end x"), end_y: u32(end.y, "Selection end y"),
    } })
  },
  contextEmbeddedTerminalGetSelectedText(context, terminal) {
    return this.terminalBytes(context, { selected_text: { terminal: this.handle(context, terminal) } })
  },
  contextEmbeddedTerminalCompose(drawing, terminal, x, y) {
    return this.terminalMutation(drawing.context, { compose: {
      terminal: this.handle(drawing.context, terminal), ...this.drawing(drawing),
      x: i32(x, "Terminal composition x"), y: i32(y, "Terminal composition y"),
    } })
  },
  contextEmbeddedTerminalCursor(context, terminal) {
    const value = this.call(context, "terminal", { cursor: { terminal: this.handle(context, terminal) } })
    return {
      x: value.x, y: value.y, hasValue: value.has_value !== 0, visible: value.visible !== 0,
      blinking: value.blinking !== 0, wideTail: value.wide_tail !== 0,
      style: ["bar", "block", "underline", "block-hollow"][value.style] ?? "block",
      ...value.color_has_value !== 0 ? { color: { r: value.color_r, g: value.color_g, b: value.color_b } } : {},
    }
  },
  contextEmbeddedTerminalEncodeKey(context, terminal, key) {
    const action = ["release", "press", "repeat"].indexOf(key.action ?? "press")
    if (action < 0) throw new TypeError("Unknown embedded terminal key action")
    const options = {
      action, composing: boolean(key.composing ?? false, "Key composing"), mods: u32(key.mods ?? 0, "Key modifiers"),
      consumed_mods: u32(key.consumedMods ?? 0, "Key consumed modifiers"),
      unshifted_codepoint: u32(key.unshiftedCodepoint ?? 0, "Key codepoint"),
    }
    const handle = this.handle(context, terminal)
    return this.terminalBytes(context, ([key, text]) => ({ encode_key: { terminal: handle, options, key, text } }), {
      input: [this.encoder.encode(key.key ?? ""), this.encoder.encode(key.text ?? "")],
    })
  },
  contextEmbeddedTerminalEncodeMouse(context, terminal, mouse) {
    const action = ["press", "release", "motion"].indexOf(mouse.action)
    const button = mouse.button === undefined ? -1 : ["unknown", "left", "right", "middle", "four", "five", "six", "seven"].indexOf(mouse.button)
    if (action < 0 || mouse.button !== undefined && button < 0) throw new TypeError("Unknown embedded terminal mouse action or button")
    return this.terminalBytes(context, { encode_mouse: { terminal: this.handle(context, terminal), options: {
      action, button, mods: u32(mouse.mods ?? 0, "Mouse modifiers"),
      any_button_pressed: boolean(mouse.anyButtonPressed ?? false, "Mouse button pressed"),
      x: f32(mouse.x, "Mouse x"), y: f32(mouse.y, "Mouse y"),
    } } })
  },
  contextEmbeddedTerminalEncodePaste(context, terminal, input) {
    const handle = this.handle(context, terminal)
    return this.terminalBytes(context, ([bytes]) => ({ encode_paste: { terminal: handle, bytes } }), { input: [bytes(input)] })
  },
  contextEmbeddedTerminalEncodeFocus(context, terminal, focused) {
    return this.terminalBytes(context, { encode_focus: { terminal: this.handle(context, terminal), focused: boolean(focused, "Terminal focused") } })
  },
  contextEmbeddedTerminalDrainResponses(context, terminal) {
    const request = { drain_responses: { terminal: this.handle(context, terminal) } }
    try {
      return this.terminalBytes(context, request)
    } catch (error) {
      // OpenTUI preserves the response prefix after one overflow indication.
      if (!(error instanceof this.helpers.NativeError) || error.status !== this.helpers.NativeStatus.OutputBackpressure) throw error
      return this.terminalBytes(context, request)
    }
  },
}

function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("Terminal bytes must be a Uint8Array")
  u32(value.byteLength, "Terminal byte length")
  return value
}

function dimension(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError(`Embedded terminal ${name} must be an integer between 1 and 65535`)
  return value
}

function u32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${label} must be an unsigned 32-bit integer`)
  return value
}

function i32(value, label) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError(`${label} must be a signed 32-bit integer`)
  return value
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`)
  return Number(value)
}

function f32(value, label) {
  if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) throw new RangeError(`${label} must be a finite 32-bit float`)
  return Math.fround(value)
}
