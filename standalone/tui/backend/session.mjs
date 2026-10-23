/** Terminal transitions and controls serialize through the actual Session feed. */
export const sessionMethods = {
  sessionSetupTerminal(context, session, options = {}) {
    return this.call(context, "session_setup_terminal", { ...this.session(context, session), options: {
      use_alternate_screen: options.useAlternateScreen ?? true, mouse: options.mouse ?? true,
      mouse_movement: options.mouseMovement ?? true, kitty_keyboard_flags: options.kittyKeyboardFlags ?? 5, clear_on_close: options.clearOnClose ?? true,
    } })
  },
  sessionSuspend(context, session) { return this.call(context, "session_suspend", this.session(context, session)) },
  sessionResume(context, session) { return this.call(context, "session_resume", this.session(context, session)) },
  sessionGetTerminalState(context, session) { return this.call(context, "session_terminal_state", this.session(context, session)) },
  sessionWrite(context, session, bytes) { return this.call(context, "session_write", { ...this.session(context, session), bytes: Buffer.from(bytes).toString("base64") }) },
  sessionSetDebugOverlay(context, session, enabled, corner) { return this.call(context, "session_debug_overlay", { ...this.session(context, session), enabled, corner }) },
  sessionSetCursor(context, session, options) {
    const layout = this.helpers.nativeLayouts.ot_session_cursor_update
    const constants = this.helpers.nativeConstants
    const bytes = new Uint8Array(layout.size)
    const words = new Int32Array(bytes.buffer)
    if (options.position !== undefined) {
      for (const value of [options.position.x, options.position.y]) {
        if (!Number.isFinite(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Session cursor coordinates must fit signed 32-bit cells")
      }
      words[layout.fields.fields.offset / 4] |= constants.OT_CURSOR_POSITION
      words[layout.fields.x.offset / 4] = options.position.x
      words[layout.fields.y.offset / 4] = options.position.y
      bytes[layout.fields.visible.offset] = cursorBoolean(options.position.visible, "Session cursor visibility")
    }
    if (options.style != null) {
      const style = { block: 0, line: 1, underline: 2, default: 3 }[options.style]
      if (typeof style !== "number") throw new TypeError("Unknown cursor style")
      words[layout.fields.fields.offset / 4] |= constants.OT_CURSOR_STYLE
      bytes[layout.fields.style.offset] = style
    }
    if (options.blinking != null) {
      words[layout.fields.fields.offset / 4] |= constants.OT_CURSOR_BLINKING
      bytes[layout.fields.blinking.offset] = cursorBoolean(options.blinking, "Session cursor blinking")
    }
    if (options.color != null) {
      if (options.color.buffer.length !== 4) throw new RangeError("Session cursor color must have four packed RGBA lanes")
      words[layout.fields.fields.offset / 4] |= constants.OT_CURSOR_COLOR
      new Uint16Array(bytes.buffer, layout.fields.color.offset, layout.fields.color.size / 2).set(options.color.buffer)
    }
    if (options.cursor != null) {
      const pointer = this.helpers.mouseStyleToId[options.cursor]
      if (typeof pointer !== "number") throw new TypeError("Unknown mouse pointer style")
      words[layout.fields.fields.offset / 4] |= constants.OT_CURSOR_MOUSE_POINTER
      bytes[layout.fields.mouse_pointer.offset] = pointer
    }
    return this.sessionControl(context, session, { kind: "cursor", bytes })
  },
  sessionUpdateMemoryStats(context, session, heapUsed, heapTotal, arrayBuffers) { return this.call(context, "session_memory_stats", { ...this.session(context, session), heap_used: heapUsed, heap_total: heapTotal, array_buffers: arrayBuffers }) },
  sessionDumpHitGrid(context, session) { return this.call(context, "session_dump_hit_grid", this.session(context, session)) },
  sessionGetLinkId(context, session, x, y) { return this.call(context, "session_link_id", { ...this.session(context, session), x, y }) },
  contextGetLinkUrl(context, linkId) { return this.decoder.decode(Buffer.from(this.call(context, "context_link_url", { link_id: linkId }), "base64")) },
  sessionClipboard(context, session, target, bytes) { return this.call(context, "session_clipboard", { ...this.session(context, session), target, bytes: Buffer.from(bytes).toString("base64") }) },
  sessionNotification(context, session, message, title = "") {
    if (typeof message !== "string" || typeof title !== "string") throw new TypeError("Notification message and title must be strings")
    const limit = this.helpers.nativeConstants.OT_SESSION_CONTROL_PACKET_BYTES + 1
    return this.call(context, "session_notification", { ...this.session(context, session), message: message.slice(0, limit), title: title.slice(0, limit) })
  },
  sessionGetKittyImageTransport(context, session) {
    const value = this.call(context, "session_kitty_status", this.session(context, session))
    return { requested: value[0], effective: value[1], fileState: value[2], fallback: value[3], pendingFiles: value[4], pendingBytes: value[5] }
  },
  sessionPollKittyImageTransport(context, session, nowNs) { return this.call(context, "session_kitty_poll", { ...this.session(context, session), now_ns: nowNs.toString() }) },
  sessionCancelKittyImageTransport(context, session, failed) { return this.call(context, "session_kitty_cancel", { ...this.session(context, session), failed }) },
  sessionProcessKittyImageReply(context, session, bytes) { return this.call(context, "session_kitty_reply", { ...this.session(context, session), bytes: Buffer.from(bytes).toString("base64") }) },
  sessionStartKittyFileProbe(context, session) { return this.call(context, "session_kitty_probe", this.session(context, session)) },
}

function cursorBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`)
  return Number(value)
}
