/** Shared text resources use the pinned checked C ABI in the Context's reactor. */
export const textMethods = {
  createContextTextBuffer(context, options = {}) {
    this.getYogaHost().assertMutable()
    return this.issued(context, this.call(context, "text", { create: { width_method: this.helpers.widthMethodId(options.widthMethod ?? "unicode", "text") } }))
  },
  destroyContextTextBuffer(context, buffer) { return this.mutate(context, "text", { destroy: { buffer: this.handle(context, buffer) } }) },
  createContextTextBufferView(context, buffer) {
    return this.issued(context, this.mutate(context, "text", { view_create: { buffer: this.handle(context, buffer) } }))
  },
  destroyContextTextBufferView(context, view) { return this.mutate(context, "text", { view_destroy: { view: this.handle(context, view) } }) },

  contextTextBufferSetText(context, buffer, bytes) { return this.mutate(context, "text", { set_text: { buffer: this.handle(context, buffer), bytes: encodeBytes(bytes) } }) },
  contextTextBufferAppend(context, buffer, bytes) { return this.mutate(context, "text", { append: { buffer: this.handle(context, buffer), bytes: encodeBytes(bytes) } }) },
  contextTextBufferClear(context, buffer, reset = false) { return this.mutate(context, "text", { clear: { buffer: this.handle(context, buffer), reset } }) },
  encodeTextBufferStyledText(content) { return this.helpers.encodeStyledText.call(this, content, true, true) },
  contextTextBufferSetStyledText(context, buffer, content) { return this.contextTextBufferSetEncodedStyledText(context, buffer, this.encodeTextBufferStyledText(content)) },
  contextTextBufferSetEncodedStyledText(context, buffer, encoded) {
    return this.mutate(context, "text", { styled: { buffer: this.handle(context, buffer), ...styled(encoded) } })
  },
  contextTextBufferReplaceStyledBatch(context, replacements, beforeNative) {
    const constants = this.helpers.nativeConstants
    if (replacements.length > constants.OT_TEXT_REPLACEMENT_COUNT_MAX) return null
    let byteCount = 0
    let chunkCount = 0
    let urlByteCount = 0
    for (const replacement of replacements) {
      byteCount += replacement.text.bytes.length
      chunkCount += replacement.text.count
      urlByteCount += replacement.text.urlBytes.length
    }
    if (byteCount > constants.OT_TEXT_REPLACEMENT_BYTES_MAX || chunkCount > constants.OT_TEXT_REPLACEMENT_CHUNKS_MAX || urlByteCount > constants.OT_TEXT_REPLACEMENT_URL_BYTES_MAX) return null
    const input = replacements.map((replacement) => ({
      buffer: this.handle(context, replacement.buffer), view: this.handle(context, replacement.view), ...styled(replacement.text),
    }))
    return this.getYogaHost().runMutation(() => {
      beforeNative()
      const result = this.call(context, "text", { replace_batch: { replacements: input } })
      return Uint32Array.from(result.flatMap((value) => [value.text_length, value.byte_count]))
    })
  },
  contextTextBufferSetSyntaxStyle(context, buffer, style) {
    return this.mutate(context, "text", { set_style: { buffer: this.handle(context, buffer), style: style === null ? null : this.handle(context, style) } })
  },
  contextTextBufferGetInfo(context, buffer) {
    const value = this.call(context, "text", { info: { buffer: this.handle(context, buffer) } })
    return { contentEpoch: BigInt(value.content_epoch), byteLength: value.byte_count, textLength: value.text_length, lineCount: value.line_count, highlightCount: value.highlight_count, tabWidth: value.tab_width }
  },
  contextTextBufferGetText(context, buffer) { return this.decoder.decode(Buffer.from(this.call(context, "text", { get_text: { buffer: this.handle(context, buffer) } }), "base64")) },
  contextTextBufferGetRange(context, buffer, start, end) {
    return this.decoder.decode(Buffer.from(this.call(context, "text", { range: { buffer: this.handle(context, buffer), start: u32(start, "Text range start"), end: u32(end, "Text range end") } }), "base64"))
  },
  contextTextBufferSetDefaults(context, buffer, mask, style) {
    return this.mutate(context, "text", { defaults: { buffer: this.handle(context, buffer), mask: u32(mask, "Text default style mask"), record: encodeBytes(this.helpers.encodeEditorStyle(style)) } })
  },
  contextTextBufferSetTabWidth(context, buffer, width) { return this.mutate(context, "text", { tab_width: { buffer: this.handle(context, buffer), width: u32(width, "Text tab width") } }) },
  contextTextBufferHighlight(context, buffer, operation, argument = 0, highlight) {
    const record = this.helpers.encodeContextHighlight(highlight)
    return this.mutate(context, "text", { highlight: { buffer: this.handle(context, buffer), operation: u32(operation, "Text highlight operation"), argument: u32(argument, "Text highlight argument"), record: record === null ? null : encodeBytes(record) } })
  },
  contextTextBufferGetHighlights(context, buffer, line) {
    return this.call(context, "text", { highlights: { buffer: this.handle(context, buffer), line: u32(line, "Text highlight line") } }).map((value) => ({ start: value.start, end: value.end, styleId: value.style_id, priority: value.priority, hlRef: value.ref }))
  },

  contextTextBufferViewSetViewport(context, view, viewport, sizeOnly = false) {
    return this.mutate(context, "text", { viewport: {
      view: this.handle(context, view), x: u32(viewport.x, "Text viewport x"), y: u32(viewport.y, "Text viewport y"),
      width: u32(viewport.width, "Text viewport width"), height: u32(viewport.height, "Text viewport height"), size_only: sizeOnly,
    } })
  },
  contextTextBufferViewCommand(context, view, command, argument) {
    return this.mutate(context, "text", { command: { view: this.handle(context, view), command: u32(command, "Text view command"), argument: u32(argument, "Text view command argument") } })
  },
  contextTextBufferViewSetTabColor(context, view, color) {
    return this.mutate(context, "text", { tab_color: { view: this.handle(context, view), color: color === null ? null : Array.from(color.buffer) } })
  },
  contextTextBufferViewSelect(context, view, selection) {
    return this.mutate(context, "text", { select: { view: this.handle(context, view), record: encodeBytes(this.helpers.encodeEditorSelection(selection)) } })
  },
  contextTextBufferViewResetSelection(context, view, local, clear = false) {
    const handle = this.handle(context, view)
    this.getYogaHost().assertMutable()
    this.owner(context)
    if (clear) return
    return this.call(context, "text", { select: { view: handle, record: encodeBytes(this.helpers.encodeEditorSelection({ operation: local ? 5 : 2 })) } })
  },
  contextTextBufferViewGetInfo(context, view) {
    const value = this.call(context, "text", { view_info: { view: this.handle(context, view) } })
    return {
      virtualLineCount: value.virtual_line_count, totalVirtualLineCount: value.total_virtual_line_count,
      selection: value.selection_present === 0 ? null : { start: value.selection_start, end: value.selection_end }, selectionOccupancy: value.selection_occupancy === 0 ? "cell" : "boundary",
    }
  },
  contextTextBufferViewGetSelectedText(context, view) { return this.decoder.decode(Buffer.from(this.call(context, "text", { selected_text: { view: this.handle(context, view) } }), "base64")) },
  contextTextBufferViewGetLines(context, view, logical = false, firstLine = 0, lineCount = 0xffffffff) {
    const value = this.call(context, "text", { lines: { view: this.handle(context, view), logical, first_line: u32(firstLine, "Text first line"), count: u32(lineCount, "Text line count") } })
    return {
      lineStartCols: value.lines.map((line) => line.start_cols), lineWidthCols: value.lines.map((line) => line.width_cols),
      lineSources: value.lines.map((line) => line.source_line), lineWraps: value.lines.map((line) => line.wrap_index), lineWidthColsMax: value.width_cols_max,
    }
  },
  contextTextBufferViewMeasure(context, view, width, height) {
    const value = this.call(context, "text", { measure: { view: this.handle(context, view), width: u32(width, "Text measure width"), height: u32(height, "Text measure height") } })
    return { lineCount: value.line_count, widthColsMax: value.width_cols_max }
  },
  sceneSetTextView(context, node, view) { return this.mutate(context, "text", { scene_view: { node: this.handle(context, node), view: view === null ? null : this.handle(context, view) } }) },
  sceneSetTextViewPaint(context, node, enabled) { return this.mutate(context, "text", { scene_paint: { node: this.handle(context, node), enabled } }) },
  contextDrawTextBufferView({ context, target, frame }, view, x, y) {
    this.getYogaHost().assertMutable()
    return this.call(context, "text", { draw: { target: this.handle(context, target), frame: this.frame(context, frame), view: this.handle(context, view), x: Math.trunc(x) || 0, y: Math.trunc(y) || 0 } })
  },
}

function encodeBytes(value) { return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") }
function styled(encoded) { return { bytes: encodeBytes(encoded.bytes), records: encodeBytes(encoded.records), count: encoded.count, url_bytes: encodeBytes(encoded.urlBytes) } }
function u32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${label} must fit an unsigned 32-bit integer`)
  return value
}
