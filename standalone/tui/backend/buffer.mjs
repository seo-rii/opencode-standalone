/** Checked owned buffers and the upstream binary drawing record format. */
export const bufferMethods = {
  drawing({ context, target, frame }) { return { target: this.handle(context, target), frame: this.frame(context, frame ?? null) } },
  createContextBuffer(context, options) {
    return this.issued(context, this.mutate(context, "buffer_create", { width: options.width, height: options.height, respect_alpha: options.respectAlpha ?? false, width_method: this.helpers.widthMethodId(options.widthMethod ?? "unicode", "buffer") }))
  },
  destroyContextBuffer(context, buffer) { return this.mutate(context, "object_destroy", { handle: this.handle(context, buffer) }) },
  contextResizeBuffer(context, buffer, width, height) { return this.mutate(context, "buffer_resize", { buffer: this.handle(context, buffer), width, height }) },
  contextAcquireBufferLease(context, buffer) { return this.checkedLease(context, this.call(context, "buffer_lease", { buffer: this.handle(context, buffer) })) },
  createContextUnicode(context, text, widthMethod) { return this.issued(context, this.mutate(context, "unicode_create", { text, width_method: this.helpers.widthMethodId(widthMethod, "Unicode") })) },
  getContextUnicode(context, unicode) { return this.call(context, "unicode_get", { unicode: this.handle(context, unicode) }).map((value) => ({ width: value.width, char: value.character })) },
  destroyContextUnicode(context, unicode) { return this.mutate(context, "object_destroy", { handle: this.handle(context, unicode) }) },
  contextBufferDrawUnicode(drawing, unicode, index, x, y, foreground, background, attributes) {
    return this.mutate(drawing.context, "buffer_draw_unicode", { ...this.drawing(drawing), unicode: this.handle(drawing.context, unicode), index, x, y, foreground: Array.from(foreground.buffer), background: Array.from(background.buffer), attributes })
  },
  contextDrawBuffer(drawing, options) {
    const scratch = this.helpers.createBufferDrawRecord()
    const encoded = this.helpers.encodeBufferDrawRecord(drawing.context, options, scratch.words, scratch.signed, scratch.colors, 0, scratch.source)
    const text = this.encoder.encode(this.helpers.drawRecordText(options))
    const bottom = this.encoder.encode(this.helpers.drawRecordBottomTitle(options))
    if (text.length > this.helpers.nativeConstants.OT_BUFFER_TEXT_BYTES_MAX || bottom.length > this.helpers.nativeConstants.OT_BUFFER_TEXT_BYTES_MAX) throw new RangeError("Buffer text exceeds the native byte limit")
    return this.mutate(drawing.context, "buffer_draw", { ...this.drawing(drawing), record: bytes(scratch.records[encoded.operation]), source: encoded.source === null ? null : this.handle(drawing.context, options.source), text: bytes(text), bottom: bytes(bottom) })
  },
  contextBufferStack(drawing, options) {
    const operation = ["getOpacity", "pushScissor", "popScissor", "clearScissors", "pushOpacity", "popOpacity", "clearOpacity"].indexOf(options.operation)
    if (operation < 0) throw new TypeError("Invalid checked buffer stack operation")
    const opacity = options.opacity ?? 1
    if (!Number.isFinite(opacity)) throw new RangeError("Buffer opacity must be finite")
    return this.mutate(drawing.context, "buffer_stack", { ...this.drawing(drawing), operation, x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0, opacity: Math.max(0, Math.min(1, opacity)) })
  },
  contextDrawGrid(drawing, options) {
    if (options.borderChars.length !== 11) throw new RangeError("Border characters must contain 11 Unicode scalars")
    return this.mutate(drawing.context, "buffer_grid", { ...this.drawing(drawing), options: { border_chars: Array.from(options.borderChars), foreground: Array.from(options.borderFg.buffer), background: Array.from(options.borderBg.buffer), draw_inner: options.drawInner, draw_outer: options.drawOuter }, columns: Array.from(options.columnOffsets), rows: Array.from(options.rowOffsets) })
  },
  contextDrawPackedBuffer(drawing, data, byteLength, x, y, width, height) {
    if (byteLength > data.byteLength) throw new RangeError("Pixel byte count exceeds the supplied view")
    return this.mutate(drawing.context, "buffer_packed", { ...this.drawing(drawing), bytes: bytes(data.subarray(0, byteLength)), x, y, width, height })
  },
  contextDrawSuperSampleBuffer(drawing, data, byteLength, x, y, format, stride) {
    if (format !== "rgba8unorm" && format !== "bgra8unorm") throw new TypeError("Unknown pixel format")
    if (byteLength > data.byteLength) throw new RangeError("Pixel byte count exceeds the supplied view")
    return this.mutate(drawing.context, "buffer_supersample", { ...this.drawing(drawing), bytes: bytes(data.subarray(0, byteLength)), x, y, format: format === "bgra8unorm" ? 0 : 1, stride })
  },
  contextDrawGrayscaleBuffer(drawing, data, x, y, width, height, foreground, background, supersampled) {
    if (!(data instanceof Float32Array)) throw new TypeError("Grayscale input must be a Float32Array")
    return this.mutate(drawing.context, "buffer_grayscale", { ...this.drawing(drawing), bytes: bytes(data), x, y, width, height, foreground: foreground === null ? null : Array.from(foreground.buffer), background: background === null ? null : Array.from(background.buffer), supersampled })
  },
  contextColorMatrixBuffer(drawing, matrix, mask, strength, channel) {
    if (!(matrix instanceof Float32Array) || (mask !== null && !(mask instanceof Float32Array))) throw new TypeError("Color matrix input must be a Float32Array")
    if (matrix.length !== 16) throw new RangeError("Color matrix must contain 16 floats")
    if (!Number.isFinite(strength)) throw new RangeError("Color matrix strength must be finite")
    return this.mutate(drawing.context, "buffer_color_matrix", { ...this.drawing(drawing), matrix: bytes(matrix), mask: mask === null ? null : bytes(mask), strength, channel })
  },
  contextDrawEditorView(drawing, view, x, y) { return this.mutate(drawing.context, "buffer_draw_editor", { ...this.drawing(drawing), source: this.handle(drawing.context, view), x, y }) },
  contextDrawSceneText(drawing, node, x, y) { return this.mutate(drawing.context, "buffer_draw_scene_text", { ...this.drawing(drawing), source: this.handle(drawing.context, node), x, y }) },
  sceneFrameCopyBuffer(context, session, frame, target) { return this.mutate(context, "frame_copy_buffer", { ...this.session(context, session), frame: this.frame(context, frame), target: this.handle(context, target) }) },
  sessionRenderSplit(context, session, frame, snapshots, pinnedRenderOffset, force) {
    return { status: this.mutate(context, "session_render_split", { ...this.session(context, session), frame: this.frame(context, frame), snapshots: snapshots.map((value) => ({ buffer: this.handle(context, value.snapshot), row_columns: value.rowColumns, start_on_new_line: value.startOnNewLine, trailing_newline: value.trailingNewline })), pinned_render_offset: pinnedRenderOffset, force }) }
  },
}

function bytes(value) { return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") }
