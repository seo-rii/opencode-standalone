import { createFactoryTransport } from "./transport.mjs"
import { EditorResources } from "./editor.mjs"
import { sessionMethods } from "./session.mjs"
import { textMethods } from "./text.mjs"
import { bufferMethods } from "./buffer.mjs"
import { measureMethods } from "./measure.mjs"
import { hostMethods } from "./host.mjs"
import { imageMethods } from "./image.mjs"
import { terminalMethods } from "./terminal.mjs"
export { createStandaloneImageMemoryView } from "./image.mjs"

const pointers = new WeakMap()

/** Host adaptation of the actual upstream scoped buffer-access constructors. */
export function createStandaloneMemoryView(Type, pointer, byteOffset, byteLength) {
  const value = pointers.get(pointer)
  if (!value || !value.lease.active || value.owner.closed) throw new Error("WASM buffer lease has ended")
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || !Number.isInteger(byteLength) || byteLength < 0 || byteOffset + byteLength > value.length) {
    throw new RangeError("WASM buffer view exceeds its checked lease")
  }
  return new Type(value.owner.transport.buffer, value.offset + byteOffset, byteLength / Type.BYTES_PER_ELEMENT)
}

/** Implements the native factory's host boundary; Context/Yoga/Scene/output remain upstream WASM. */
export function createStandaloneRenderLib(helpers) {
  return new Proxy(new StandaloneRenderLib(helpers), {
    get(target, property, receiver) {
      if (property in target) {
        // oxlint-disable-next-line no-restricted-globals -- Forward actual backend members through the explicit unsupported-operation guard.
        return Reflect.get(target, property, receiver)
      }
      if (typeof property === "symbol") return undefined
      throw new helpers.NativeError(`WASM backend ${property}`, helpers.NativeStatus.UnsupportedResource)
    },
  })
}

class StandaloneRenderLib extends EditorResources {
  disposed = false

  constructor(helpers) {
    super()
    this.helpers = helpers
    this.contexts = new Map()
    this.leases = new WeakMap()
    this.imagePixelLeases = new WeakMap()
    this.encoder = new TextEncoder()
    this.decoder = new TextDecoder()
    this.yogaHost = new helpers.YogaHost(this)
    this.imageRetainIccCache()
  }

  getYogaHost() { return this.yogaHost }
  releaseAfterPaint(context, release) { return this.helpers.releaseAfterPaint(context, release) }
  dispose() {
    if (this.disposed) return
    if (this.contexts.size !== Number(this.editMeasureContext !== undefined)) throw new this.helpers.NativeError("dispose", this.helpers.NativeStatus.ContextBusy)
    this.imageReleaseIccCache()
    this.yogaHost.dispose()
    if (this.editMeasureContext) this.destroyContext(this.editMeasureContext)
    this.editMeasureContext = undefined
    this.disposed = true
  }

  createContext(options) {
    const context = Object.freeze({})
    const transport = createFactoryTransport({ sceneMeasure: (...arguments_) => this.invokeSceneMeasure(context, ...arguments_) })
    const id = this.invoke(transport, "context_create", { object_capacity: options.objectCapacity, render_cells_max: options.renderCellsMax })
    this.contexts.set(context, { context, id, transport, closed: false, measures: new Map() })
    for (let client = 0; client < this.imageIccClients; client++) this.call(context, "image", { icc_retain: {} })
    return context
  }

  destroyContext(context) {
    this.getYogaHost().assertMutable()
    const owner = this.owner(context)
    this.call(context, "context_destroy", {})
    owner.measures.clear()
    owner.closed = true
    this.contexts.delete(context)
  }

  owner(context) {
    const owner = this.contexts.get(context)
    if (!owner) throw new this.helpers.NativeError("Context handle", this.helpers.NativeStatus.WrongContext)
    return owner
  }

  invoke(transport, operation, options, transfer) {
    try {
      return transport.call(operation, options, transfer)
    } catch (error) {
      if (error.nativeStatus === undefined) throw error
      throw Object.assign(new this.helpers.NativeError(`WASM ${operation}`, error.nativeStatus), { code: error.code, cause: error })
    }
  }

  call(context, operation, options, transfer) {
    const owner = this.owner(context)
    try {
      return this.invoke(owner.transport, operation, options, transfer)
    } finally {
      if (operation !== "context_destroy" && !this.getYogaHost().inCallback) this.drainEditEvents(context, owner)
    }
  }

  handle(context, value) {
    this.owner(context)
    if (value.context !== context) throw new this.helpers.NativeError("Context handle", this.helpers.NativeStatus.WrongContext)
    return { context: value.contextId.toString(), slot: value.slot, generation: value.generation }
  }

  issued(context, value) {
    return { context, contextId: BigInt(value.context), slot: value.slot, generation: value.generation }
  }

  session(context, session) { return { session: this.handle(context, session) } }
  node(context, node) { return { node: this.handle(context, node) } }

  createSession(context, options) {
    return this.issued(context, this.call(context, "session_create", {
      chunk_size: options.chunkSize, span_capacity: options.spanCapacity,
      max_bytes: options.maxBytes.toString(), control_capacity: options.controlCapacity ?? 0,
    }))
  }
  destroySession(context, session) {
    this.call(context, "session_destroy", this.session(context, session))
    for (const [slot, entry] of this.owner(context).measures) {
      try {
        this.sceneHasMeasure(context, entry.handle)
      } catch (error) {
        if (!(error instanceof this.helpers.NativeError) || error.status !== this.helpers.NativeStatus.StaleHandle) throw error
        this.owner(context).measures.delete(slot)
      }
    }
  }
  sessionGetWriteLimit(context, session) { return BigInt(this.call(context, "session_write_limit", this.session(context, session))) }
  sessionAttachRenderer(context, session, options) {
    return this.call(context, "session_attach", { ...this.session(context, session), width: options.width, height: options.height, remote: options.remote ?? null, environment: Object.entries(options.environment ?? {}).map(([key, value]) => ({ key, value })) })
  }
  sessionGetRendererState(context, session) {
    const result = this.call(context, "session_renderer_state", this.session(context, session))
    return { width: result.width, height: result.height, frameCount: BigInt(result.frame_count), framePending: result.frame_pending }
  }
  sessionGetState(context, session) { return this.call(context, "session_state", this.session(context, session)) }
  sessionClose(context, session) { return this.call(context, "session_close", this.session(context, session)) }
  sessionCancel(context, session) { return this.call(context, "session_cancel", this.session(context, session)) }
  sessionResizeRenderer(context, session, width, height) { return this.call(context, "session_resize", { ...this.session(context, session), width, height }) }
  sessionSyncDetached(context, session, parent) { return this.call(context, "session_sync_detached", { ...this.session(context, session), parent: this.handle(context, parent) }) }
  sessionPump(context, session, nowNs, workBudget) {
    const result = this.call(context, "session_pump", { ...this.session(context, session), now_ns: nowNs.toString(), work_budget: workBudget })
    return { status: result.status, deadlineNs: result.deadline_ns === null ? null : BigInt(result.deadline_ns) }
  }
  sessionReadOutput(context, session, bytes) {
    const result = this.call(context, "session_read_output", { ...this.session(context, session), capacity: bytes.length })
    if (result === null) return null
    const output = Buffer.from(result.bytes, "base64")
    if (output.length > bytes.length) throw new RangeError("WASM output exceeds its supplied destination")
    bytes.set(output)
    return { session: this.issued(context, result.ticket.session), requestId: BigInt(result.ticket.request_id), byteCount: result.ticket.byte_count }
  }
  sessionCompleteOutput(context, session, ticket, success) {
    return this.call(context, "session_complete_output", { ...this.session(context, session), ticket: { session: this.handle(context, ticket.session), request_id: ticket.requestId.toString(), byte_count: ticket.byteCount }, success })
  }
  sessionGetCapabilities(context, session) {
    const value = this.call(context, "session_capabilities", this.session(context, session))
    const caps = Object.fromEntries(["kitty_keyboard", "kitty_graphics", "rgb", "ansi256", "sgr_pixels", "color_scheme_updates", "explicit_width", "scaled_text", "sixel", "focus_tracking", "sync", "bracketed_paste", "hyperlinks", "osc52", "notifications", "explicit_cursor_positioning", "remote", "program_status"].map((name) => [name, (value.flags & this.helpers.nativeConstants[`OT_CAP_${name.toUpperCase()}`]) !== 0]))
    return {
      ...caps, unicode: ["wcwidth", "unicode", "no-zwj", "unicode-wide"][value.width_method],
      multiplexer: ["none", "tmux", "zellij", "screen", "unknown"][value.multiplexer],
      image_protocol: ["auto", "kitty", "sixel", "blocks"][value.image_protocol],
      osc52_support: ["unknown", "supported", "unsupported"][value.osc52_support],
      kittyKeyboardFlags: value.kitty_keyboard_flags,
      terminal: { name: value.term_name, version: value.term_version, from_xtversion: value.term_from_xtversion },
    }
  }
  sessionSetScreen(context, session, alternate, width, height, trailingOutput) { return this.call(context, "session_set_screen", { ...this.session(context, session), alternate, width, height, trailing_output: trailingOutput ? Buffer.from(trailingOutput).toString("base64") : "" }) }
  sessionSplitControl(context, session, command) {
    this.getYogaHost().assertMutable()
    const commands = { reset: 0, sync: 1, "output-offset": 2, "render-offset": 3, transition: 4, "clear-transition": 5 }
    if (!Object.hasOwn(commands, command.kind)) throw new TypeError("Unknown split control")
    const args = command.kind === "reset" ? [command.seedRows, command.pinnedRenderOffset]
      : command.kind === "sync" ? [command.pinnedRenderOffset]
      : command.kind === "output-offset" ? [command.surfaceOffset]
      : command.kind === "render-offset" ? [command.renderOffset]
      : command.kind === "transition" ? [["viewport-scroll", "clear-stale-rows"].indexOf(command.mode) + 1, command.sourceTopLine, command.sourceHeight, command.targetTopLine, command.targetHeight, command.scrollLines ?? 0] : []
    if (command.kind === "transition" && args[0] === 0) throw new TypeError("Unknown split transition mode")
    if (args.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw new RangeError("Split control arguments must be u32 values")
    return this.call(context, "session_split_control", { ...this.session(context, session), command: commands[command.kind], arguments: args })
  }
  sessionSetKittyImageTransport(context, session, mode) { return this.call(context, "session_kitty_transport", { ...this.session(context, session), mode }) }
  sessionSetImageResolution(context, session, terminalWidth, terminalHeight, pixelWidth, pixelHeight) { return this.call(context, "session_image_resolution", { ...this.session(context, session), terminal_width: terminalWidth, terminal_height: terminalHeight, pixel_width: pixelWidth, pixel_height: pixelHeight }) }
  sessionSetPaletteState(context, session, palette, foreground, background, epoch) { return this.call(context, "session_palette", { ...this.session(context, session), palette: palette.map((color) => Array.from(color.buffer)), foreground: Array.from(foreground.buffer), background: Array.from(background.buffer), epoch }) }
  sessionUpdateStats(context, session, overallMs, fps, callbackMs) { return this.call(context, "session_update_stats", { ...this.session(context, session), overall_ms: overallMs, fps, callback_ms: callbackMs }) }
  sessionControl(context, session, command) {
    const constants = this.helpers.nativeConstants
    const name = command.kind.replaceAll("-", "_").toUpperCase()
    const kind = constants[`OT_CONTROL_${name}`]
    if (kind === undefined) throw new this.helpers.NativeError("ot_session_control", this.helpers.NativeStatus.UnsupportedResource)
    const argument = command.kind === "mouse" ? ["disabled", "drag", "motion"].indexOf(command.mode) : command.kind === "kitty-keyboard-flags" ? command.flags : 0
    const bytes = command.bytes ?? (command.kind === "title" ? this.encoder.encode(command.title) : command.kind === "program-status" ? this.helpers.programStatusPayload(command.status, this.encoder) : new Uint8Array(0))
    return this.call(context, "session_control", { ...this.session(context, session), kind, argument, bytes: Buffer.from(bytes).toString("base64") })
  }

  sceneCreateNode(context, session, kind, num) {
    const kinds = { root: 0, box: 1, text: 2, slider: 3, arrow: 4, editor: 5, custom: 6, text_view: 7, image: 8 }
    if (!Object.hasOwn(kinds, kind)) throw new this.helpers.NativeError("ot_scene_create_node", this.helpers.NativeStatus.UnsupportedResource)
    return this.issued(context, this.call(context, "scene_create", { ...this.session(context, session), kind: kinds[kind], num }))
  }
  sceneDestroyNode(context, node) {
    this.call(context, "scene_destroy", this.node(context, node))
    this.owner(context).measures.delete(node.slot)
  }
  sceneMoveNode(context, node, parent, index) { return this.call(context, "scene_move", { ...this.node(context, node), parent: parent === null ? null : this.handle(context, parent), index }) }
  sceneSetFocus(context, node, focused) { return this.mutate(context, "scene_focus", { ...this.node(context, node), focused }) }
  sceneSetViewport(context, node, viewport) { return this.mutate(context, "scene_viewport", { ...this.node(context, node), viewport: viewport === null ? null : this.handle(context, viewport) }) }
  sceneSetSurface(context, node, buffer) { return this.mutate(context, "scene_surface", { ...this.node(context, node), buffer: buffer === null ? null : this.handle(context, buffer) }) }
  sceneSetSlider(context, node, options) {
    const orientation = ["horizontal", "vertical"].indexOf(options.orientation)
    if (orientation < 0) throw new TypeError("Unknown scene slider orientation")
    return this.mutate(context, "scene_slider", { ...this.node(context, node), options: { orientation, min: options.min, max: options.max, value: options.value, viewport_size: options.viewPortSize, foreground: Array.from(options.foregroundColor.buffer), background: Array.from(options.backgroundColor.buffer) } })
  }
  sceneGetSliderThumb(context, node) { return this.call(context, "scene_slider_thumb", this.node(context, node)) }
  sceneSetArrow(context, node, options) {
    const direction = ["up", "down", "left", "right"].indexOf(options.direction)
    if (direction < 0) throw new TypeError("Unknown scene arrow direction")
    return this.mutate(context, "scene_arrow", { ...this.node(context, node), options: { direction, attributes: options.attributes, foreground: Array.from(options.foregroundColor.buffer), background: Array.from(options.backgroundColor.buffer), text: options.text ?? null } })
  }
  sceneSetEditorView(context, node, view) { return this.mutate(context, "scene_editor_view", { ...this.node(context, node), view: view === null ? null : this.handle(context, view) }) }
  sceneSetEditorOptions(context, node, options) {
    const style = ["block", "line", "underline", "default"].indexOf(options.style)
    const pointer = options.cursor === undefined ? this.helpers.nativeConstants.OT_MOUSE_POINTER_UNCHANGED : this.helpers.mouseStyleToId[options.cursor]
    if (style < 0 || pointer === undefined) throw new TypeError("Unknown scene editor cursor style")
    return this.mutate(context, "scene_editor_options", { ...this.node(context, node), options: { show_cursor: options.showCursor, style, blinking: options.blinking, color: Array.from(options.color.buffer), mouse_pointer: pointer } })
  }
  sceneGetLayout(context, node, rawYoga) { return this.call(context, "scene_layout", { ...this.node(context, node), raw_yoga: rawYoga }) }
  sceneMeasureLayout(context, session, root) {
    this.getYogaHost().assertMutable()
    const operation = () => this.call(context, "scene_measure_layout", { ...this.session(context, session), root: this.handle(context, root) })
    if (this.owner(context).measures.size === 0) return operation()
    this.getYogaHost().flushSceneMutations()
    return this.getYogaHost().runMutation(operation)
  }
  sceneGetStyle(context, node, group, kind, edge) {
    const result = this.call(context, "scene_style", { ...this.node(context, node), group, kind, edge })
    const bits = new DataView(new ArrayBuffer(4))
    bits.setUint32(0, result.value_bits, true)
    return { unit: result.unit, value: bits.getFloat32(0, true) }
  }
  sceneMarkDirty(context, node) { return this.call(context, "scene_mark_dirty", this.node(context, node)) }
  sceneSetHooks(context, node, flags, generation, initialWidth, initialHeight) { return this.call(context, "scene_hooks", { ...this.node(context, node), flags, generation: generation.toString(), initial_width: initialWidth, initial_height: initialHeight }) }
  sceneHasMeasure(context, node) { return this.call(context, "scene_has_measure", this.node(context, node)) }
  sceneFlush(context, staging) {
    if (staging.count === 0) return
    this.getYogaHost().runMutation(() => {
      const count = staging.count
      const words = staging._views(context)
      let applied = 0
      let rejected = 0
      let result
      try {
        result = this.call(context, "scene_flush", { bytes: Buffer.from(words.buffer, words.byteOffset, staging.byteLength).toString("base64") })
        applied = result.applied
        rejected = [this.helpers.NativeStatus.InvalidArgument, this.helpers.NativeStatus.WrongKind, this.helpers.NativeStatus.StaleHandle].includes(result.status) && applied < count ? 1 : 0
      } finally {
        staging.consume(applied + rejected)
      }
      if (result.status !== 0) {
        const error = new this.helpers.NativeError("ot_scene_flush", result.status)
        error.message += ` after ${applied} of ${count} staged entries`
        throw error
      }
    })
  }
  sceneSetBoxDetails(context, node, options) {
    return this.call(context, "scene_box", { ...this.node(context, node), options: {
      title: options.title ?? "", bottom_title: options.bottomTitle ?? "",
      title_alignment: ["left", "center", "right"].indexOf(options.titleAlignment), bottom_title_alignment: ["left", "center", "right"].indexOf(options.bottomTitleAlignment),
      title_color: options.titleColor ? Array.from(options.titleColor.buffer) : null,
      custom_border_chars: options.customBorderChars ? Array.from(options.customBorderChars) : null,
    } })
  }
  sceneSetText(context, node, bytes) { return this.call(context, "scene_text", { ...this.node(context, node), text: this.decoder.decode(bytes) }) }
  sceneSetStyledText(context, node, content) {
    this.getYogaHost().assertMutable()
    const encoded = this.helpers.encodeStyledText.call(this, content)
    return this.call(context, "scene_styled_text", {
      // The upstream encoder skips empty chunks but retains their allocation.
      // Native FFI reads only this count-qualified prefix of the record array.
      ...this.node(context, node), bytes: Buffer.from(encoded.bytes).toString("base64"), records: Buffer.from(encoded.records.buffer, encoded.records.byteOffset, encoded.count * this.helpers.nativeLayouts.ot_styled_text_chunk.size).toString("base64"),
      count: encoded.count, url_bytes: Buffer.from(encoded.urlBytes).toString("base64"),
    })
  }
  sceneGetText(context, node) { return this.decoder.decode(Buffer.from(this.call(context, "scene_get_text", this.node(context, node)), "base64")) }
  sceneSetTextOptions(context, node, options) {
    return this.call(context, "scene_text_options", { ...this.node(context, node), options: {
      foreground: Array.from(options.fg.buffer), background: Array.from(options.bg.buffer), attributes: options.attributes,
      wrap_mode: options.wrapMode, text_align: options.textAlign, truncate: options.truncate,
      first_line_offset: options.firstLineOffset, scroll_x: options.scrollX, scroll_y: options.scrollY,
      tab_indicator: typeof options.tabIndicator === "string" ? (options.tabIndicator.codePointAt(0) ?? null) : (options.tabIndicator ?? null),
      tab_color: options.tabIndicatorColor ? Array.from(options.tabIndicatorColor.buffer) : null,
    } })
  }
  sceneSetTextSelection(context, node, options) {
    return this.call(context, "scene_selection", { ...this.node(context, node), options: {
      operation: ["reset", "set", "update"].indexOf(options.operation), behavior: ["cell", "word", "line"].indexOf(options.behavior),
      anchor_x: Math.trunc(options.anchorX), anchor_y: Math.trunc(options.anchorY), focus_x: Math.trunc(options.focusX), focus_y: Math.trunc(options.focusY),
      foreground: options.fg ? Array.from(options.fg.buffer) : null, background: options.bg ? Array.from(options.bg.buffer) : null,
    } })
  }
  sceneGetTextSelection(context, node) {
    const packed = BigInt(this.call(context, "scene_selection_state", this.node(context, node)))
    return packed === 0xffffffffffffffffn ? null : { start: Number(packed >> 32n), end: Number(packed & 0xffffffffn) }
  }
  sceneGetTextMetrics(context, node) {
    const value = this.call(context, "scene_text_info", this.node(context, node))
    return { byteLength: value.byte_count, textLength: value.text_length, lineCount: value.line_count, virtualLineCount: value.virtual_line_count, widthColsMax: value.width_cols_max }
  }
  sceneGetTextLineInfo(context, node, firstLine = 0, lineCount = 0xffffffff) {
    const metrics = this.sceneGetTextMetrics(context, node)
    const lines = this.call(context, "scene_text_lines", { ...this.node(context, node), first_line: firstLine, count: Math.min(lineCount, Math.max(0, metrics.virtualLineCount - firstLine)) })
    return { lineStartCols: lines.map((line) => line.start_cols), lineWidthCols: lines.map((line) => line.width_cols), lineSources: lines.map((line) => line.source_line), lineWraps: lines.map((line) => line.wrap_index), lineWidthColsMax: metrics.widthColsMax }
  }

  frame(context, frame) {
    if (frame === null) return null
    return {
      session: this.handle(context, frame.session), root: this.handle(context, frame.root), node: this.handle(context, frame.node),
      frame_id: frame.frameId.toString(), request_id: frame.requestId.toString(), layout_epoch: frame.layoutEpoch.toString(), hook_generation: frame.hookGeneration.toString(),
      kind: frame.kind, num: frame.num, width: frame.width, height: frame.height,
    }
  }
  sceneFrameStep(context, session, previous, options, maxWork = 0xffffffff, recording = null) {
    this.getYogaHost().assertMutable()
    const operation = () => this.call(context, "frame_step", { ...this.session(context, session), previous: this.frame(context, previous), options: {
      background: Array.from(options.background.buffer), use_mouse: options.useMouse, excluded_hit_num: options.excludedHitNum,
      max_layout_rounds: options.maxLayoutRounds, max_host_requests: options.maxHostRequests, preserve_unwritten: options.preserveUnwritten ?? false,
    }, max_work: maxWork, recording: recording === null ? null : Buffer.from(recording).toString("base64") })
    const value = this.owner(context).measures.size === 0 ? operation() : this.sceneFrameStepWithMeasures(context, session, operation)
    return {
      session: this.issued(context, value.session), root: this.issued(context, value.root), node: this.issued(context, value.node),
      frameId: BigInt(value.frame_id), requestId: BigInt(value.request_id), layoutEpoch: BigInt(value.layout_epoch), hookGeneration: BigInt(value.hook_generation),
      kind: value.kind, num: value.num, width: value.width, height: value.height,
      paintLayout: value.geometry?.paint ?? undefined, publicLayout: value.geometry?.public_layout ?? undefined,
    }
  }
  sceneFrameStepWithMeasures(context, session, operation) {
    this.getYogaHost().flushSceneMutations()
    let accepted
    try {
      return this.getYogaHost().runMutation(() => accepted = operation())
    } catch (error) {
      if (accepted) {
        try {
          this.call(context, "frame_cancel", { ...this.session(context, session), frame_id: accepted.frame_id })
        } catch { /* Preserve the original measurement error, as the native factory does. */ }
      }
      throw error
    }
  }
  sceneFrameCommit(context, session, frame, force) { return this.call(context, "frame_commit", { ...this.session(context, session), frame: this.frame(context, frame), force }) }
  sceneFrameGetPaintSlots(context, session, frame) {
    return this.call(context, "frame_paint_slots", { ...this.session(context, session), frame: this.frame(context, frame) }).map((value) => ({
      node: this.issued(context, value.node), num: value.num, hooks: value.hooks, opacity: value.opacity, paintLayout: value.paint_layout, publicLayout: value.public_layout ?? undefined,
    }))
  }
  sceneFrameCancel(context, session, frameId) { return this.call(context, "frame_cancel", { ...this.session(context, session), frame_id: frameId.toString() }) }
  sceneGetStats(context, session) {
    const value = this.call(context, "scene_stats", this.session(context, session))
    return { nativeLastFrameTime: value.lastFrameTime, nativeAverageFrameTime: value.averageFrameTime, nativeFrameCount: Number(value.frameCount), cellsUpdated: value.cellsUpdated, averageCellsUpdated: value.averageCellsUpdated, nativeRenderTime: value.renderTime ?? undefined, nativeStdoutWriteTime: value.outputWriteTime ?? undefined }
  }
  sceneHitTest(context, session, x, y) { return this.call(context, "scene_hit_test", { ...this.session(context, session), x, y }) }
  sceneGetCursorState(context, session) {
    const value = this.call(context, "scene_cursor", this.session(context, session))
    return { x: value.x, y: value.y, visible: value.visible, style: ["block", "line", "underline", "default"][value.style] ?? "block", blinking: value.blinking, color: this.helpers.RGBA.fromValues(...value.color) }
  }
  logContextDiagnostics(context, maxLevel = 3) {
    const value = this.call(context, "diagnostics", {})
    for (const record of value.records) {
      if (record.level <= maxLevel) console[["error", "warn", "info", "debug"][record.level] ?? "log"](record.message)
    }
  }

  sessionAcquireBufferLease(context, session, which) { return this.acquireLease(context, session, which, null) }
  sceneFrameAcquireBufferLease(context, session, frame, which) { return this.acquireLease(context, session, which, frame) }
  acquireLease(context, session, which, frame) {
    const value = this.call(context, "session_buffer_lease", { ...this.session(context, session), which: which === "current" ? 0 : 1, frame: this.frame(context, frame) })
    return this.checkedLease(context, value)
  }
  checkedLease(context, value) {
    const owner = this.owner(context)
    const handle = this.issued(context, value.handle)
    const lease = { handle, active: true }
    this.leases.set(handle, lease)
    const pointer = (field, stride) => {
      const pointer = Object.freeze({})
      pointers.set(pointer, { owner, lease, offset: value[field], length: value.width * value.height * stride })
      return pointer
    }
    return { handle, width: value.width, height: value.height, generation: BigInt(value.generation), char: pointer("char", 4), fg: pointer("fg", 8), bg: pointer("bg", 8), attributes: pointer("attributes", 4) }
  }
  contextValidateBufferLease(context, lease) { return this.call(context, "lease_validate", { lease: this.handle(context, lease) }) }
  contextReleaseBufferLease(context, handle) {
    this.call(context, "lease_release", { lease: this.handle(context, handle) })
    const lease = this.leases.get(handle)
    if (lease) lease.active = false
  }
  contextBufferLeaseGetRealCharSize(context, lease, addLineBreaks) {
    return Buffer.from(this.call(context, "lease_resolved", { lease: this.handle(context, lease), add_line_breaks: addLineBreaks, include_lengths: false }).bytes, "base64").length
  }
  contextBufferLeaseWriteResolvedChars(context, lease, bytes, addLineBreaks, cellLengths) {
    const value = this.call(context, "lease_resolved", { lease: this.handle(context, lease), add_line_breaks: addLineBreaks, include_lengths: cellLengths !== undefined })
    const text = Buffer.from(value.bytes, "base64")
    if (text.length > bytes.length) throw new this.helpers.NativeError("ot_buffer_lease_write_resolved_chars", this.helpers.NativeStatus.InvalidArgument)
    bytes.set(text)
    if (cellLengths) cellLengths.set(Buffer.from(value.cell_lengths, "base64"))
    return text.length
  }
}

Object.assign(StandaloneRenderLib.prototype, sessionMethods, textMethods, bufferMethods, measureMethods, hostMethods, imageMethods, terminalMethods)
