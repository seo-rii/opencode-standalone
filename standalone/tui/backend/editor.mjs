/** Native edit buffers and editor views owned by the same checked Context reactor. */
export class EditorResources {
  editEvents = new WeakMap()
  editMeasureContext = undefined

  edit(context, edit) { return { edit: this.handle(context, edit) } }
  view(context, view) { return { view: this.handle(context, view) } }
  mutate(context, operation, options) { return this.getYogaHost().runMutation(() => this.call(context, operation, options)) }

  createContextEditBuffer(context, options = {}) {
    this.getYogaHost().assertMutable()
    return this.issued(context, this.call(context, "edit_create", { width_method: this.helpers.widthMethodId(options.widthMethod ?? "unicode", "editor") }))
  }
  destroyContextEditBuffer(context, edit) {
    this.mutate(context, "object_destroy", { handle: this.handle(context, edit) })
    this.editEvents.get(context)?.get(edit.slot)?.listeners.clear()
    this.editEvents.get(context)?.delete(edit.slot)
  }
  createContextEditorView(context, edit, width, height) {
    return this.issued(context, this.mutate(context, "editor_create", { ...this.edit(context, edit), width, height }))
  }
  destroyContextEditorView(context, view) { return this.mutate(context, "object_destroy", { handle: this.handle(context, view) }) }
  contextEditBufferSetText(context, edit, bytes, preserveHistory = false) { return this.mutate(context, "edit_set_text", { ...this.edit(context, edit), bytes: encodeBytes(bytes), preserve_history: preserveHistory }) }
  contextEditBufferInsertText(context, edit, bytes) { return this.mutate(context, "edit_insert_text", { ...this.edit(context, edit), bytes: encodeBytes(bytes) }) }
  contextEditBufferDeleteRange(context, edit, startRow, startCol, endRow, endCol) {
    return this.mutate(context, "edit_delete_range", { ...this.edit(context, edit), start_row: startRow, start_col: startCol, end_row: endRow, end_col: endCol })
  }
  contextEditBufferSetCursor(context, edit, row, col) { return this.mutate(context, "edit_set_cursor", { ...this.edit(context, edit), row, col }) }
  contextEditBufferGetText(context, edit) { return this.decoder.decode(Buffer.from(this.call(context, "edit_get_text", this.edit(context, edit)), "base64")) }
  contextEditBufferGetInfo(context, edit) {
    const value = this.call(context, "edit_info", this.edit(context, edit))
    return {
      contentEpoch: BigInt(value.content_epoch), byteLength: value.byte_count, lineCount: value.line_count,
      cursor: { row: value.cursor_row, col: value.cursor_col, offset: value.cursor_offset }, canUndo: value.can_undo !== 0, canRedo: value.can_redo !== 0, tabWidth: value.tab_width,
    }
  }
  contextEditBufferSetTabWidth(context, edit, width) { return this.mutate(context, "edit_tab_width", { ...this.edit(context, edit), width }) }
  contextEditBufferCommand(context, edit, command, argument = 0) { return this.mutate(context, "edit_command", { ...this.edit(context, edit), command, argument }) }
  contextEditBufferHistory(context, edit, redo) {
    const value = this.mutate(context, "edit_history", { ...this.edit(context, edit), redo })
    return value === "" ? null : this.decoder.decode(Buffer.from(value, "base64"))
  }
  contextEditBufferGetPosition(context, edit, query, a = 0, b = 0) {
    const value = this.call(context, "edit_position", { ...this.edit(context, edit), query, a, b })
    return value.valid === 0 ? null : { row: value.row, col: value.col, offset: value.offset }
  }
  contextEditBufferGetRange(context, edit, byCoords, startRow, startCol, endRow, endCol) {
    return this.decoder.decode(Buffer.from(this.call(context, "edit_range", { ...this.edit(context, edit), by_coords: byCoords, start_row: startRow, start_col: startCol, end_row: endRow, end_col: endCol }), "base64"))
  }
  contextEditBufferMeasureText(context, edit, bytes) { return this.call(context, "edit_measure_text", { ...this.edit(context, edit), bytes: encodeBytes(bytes) }) }
  editMeasureText(bytes, widthMethod, tabWidth) {
    this.editMeasureContext ??= this.createContext({ objectCapacity: 1, renderCellsMax: 1 })
    return this.call(this.editMeasureContext, "edit_measure", { bytes: encodeBytes(bytes), width_method: this.helpers.widthMethodId(widthMethod, "editor"), tab_width: tabWidth })
  }
  contextEditBufferSetDefaults(context, edit, mask, style) { return this.mutate(context, "edit_defaults", { ...this.edit(context, edit), mask, record: encodeBytes(this.helpers.encodeEditorStyle(style)) }) }
  contextEditBufferSetSyntaxStyle(context, edit, style) { return this.mutate(context, "edit_set_style", { ...this.edit(context, edit), style: style === null ? null : this.handle(context, style) }) }
  contextEditBufferHighlight(context, edit, operation, argument = 0, highlight) {
    const record = this.helpers.encodeContextHighlight(highlight)
    return this.mutate(context, "edit_highlight", { ...this.edit(context, edit), operation, argument, record: record === null ? null : encodeBytes(record) })
  }
  contextEditBufferGetHighlights(context, edit, line) {
    return this.call(context, "edit_highlights", { ...this.edit(context, edit), line }).map((value) => ({ start: value.start, end: value.end, styleId: value.style_id, priority: value.priority, hlRef: value.ref }))
  }

  onContextEditEvent(context, edit, handler) {
    this.getYogaHost().assertMutable()
    if (typeof handler !== "function") throw new TypeError("Edit event handler must be a function")
    this.contextEditBufferGetInfo(context, edit)
    let buffers = this.editEvents.get(context)
    if (!buffers) {
      this.call(context, "edit_event_enable", {})
      buffers = new Map()
      this.editEvents.set(context, buffers)
    }
    let entry = buffers.get(edit.slot)
    if (!entry || entry.handle.contextId !== edit.contextId || entry.handle.generation !== edit.generation) {
      entry = { handle: edit, listeners: new Set() }
      buffers.set(edit.slot, entry)
    }
    const listener = { handler }
    entry.listeners.add(listener)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size === 0 && buffers.get(edit.slot) === entry) buffers.delete(edit.slot)
    }
  }
  drainEditEvents(context, owner) {
    const buffers = this.editEvents.get(context)
    if (!buffers) return
    const events = this.invoke(owner.transport, "edit_events", {})
    const names = { 1: "cursor-changed", 2: "content-changed", 4: "cursorChanged" }
    for (const event of events) {
      this.getYogaHost().invokeCallback(() => {
        const entry = buffers.get(event.slot)
        if (!entry || entry.handle.contextId !== BigInt(event.context) || entry.handle.generation !== event.generation) return
        const name = names[event.event]
        if (name === undefined) throw new Error("Native editor returned an unknown event")
        const listeners = [...entry.listeners]
        queueMicrotask(() => {
          for (const listener of listeners) {
            if (!this.contexts.has(context) || buffers.get(event.slot) !== entry) return
            if (entry.listeners.has(listener)) listener.handler(name)
          }
        })
      })
    }
  }

  contextEditorViewSetViewport(context, view, viewport, sizeOnly = false, moveCursor = false) { return this.mutate(context, "editor_set_viewport", { ...this.view(context, view), viewport, size_only: sizeOnly, move_cursor: moveCursor }) }
  contextEditorViewGetViewport(context, view) {
    const value = this.call(context, "editor_viewport", this.view(context, view))
    return { x: value.x, y: value.y, width: value.width, height: value.height }
  }
  contextEditorViewSetScrollMargin(context, view, margin) { return this.mutate(context, "editor_scroll_margin", { ...this.view(context, view), margin }) }
  contextEditorViewCommand(context, view, command, argument = 0) { return this.mutate(context, "editor_command", { ...this.view(context, view), command, argument }) }
  contextEditorViewReplaceSelection(context, view, bytes) {
    const value = this.mutate(context, "editor_replace_selection", { ...this.view(context, view), bytes: encodeBytes(bytes) })
    return { deleted: (value & 1) !== 0, inserted: (value & 2) !== 0 }
  }
  contextEditorViewSetTabColor(context, view, color) { return this.mutate(context, "editor_tab_color", { ...this.view(context, view), color: color === null ? null : Array.from(color.buffer) }) }
  contextEditorViewSelect(context, view, selection) { return this.mutate(context, "editor_select", { ...this.view(context, view), record: encodeBytes(this.helpers.encodeEditorSelection(selection)) }) }
  contextEditorViewGetInfo(context, view, followCursor = false) {
    return editorInfo(this.call(context, "editor_info", { ...this.view(context, view), follow_cursor: followCursor }))
  }
  contextEditorViewGetSelection(context, view) {
    const value = editorInfo(this.call(context, "editor_selection", this.view(context, view)))
    return { selection: value.selection, selectionOccupancy: value.selectionOccupancy }
  }
  contextEditorViewGetSelectedText(context, view) { return this.decoder.decode(Buffer.from(this.call(context, "editor_selected_text", this.view(context, view)), "base64")) }
  contextEditorViewGetPosition(context, view, query) {
    const value = this.call(context, "editor_position", { ...this.view(context, view), query })
    return { visualRow: value.visual_row, visualCol: value.visual_col, logicalRow: value.logical_row, logicalCol: value.logical_col, offset: value.offset }
  }
  contextEditorViewGetLines(context, view, logical = false) {
    const value = this.call(context, "editor_lines", { ...this.view(context, view), logical })
    return {
      lineStartCols: value.lines.map((line) => line.start_cols), lineWidthCols: value.lines.map((line) => line.width_cols),
      lineSources: value.lines.map((line) => line.source_line), lineWraps: value.lines.map((line) => line.wrap_index), lineWidthColsMax: value.width_cols_max,
    }
  }
  contextEditorViewMeasure(context, view, width, height) {
    const value = this.call(context, "editor_measure", { ...this.view(context, view), width, height })
    return { lineCount: value.line_count, widthColsMax: value.width_cols_max }
  }
  contextEditorViewSetPlaceholder(context, view, content) {
    const encoded = this.helpers.encodeStyledText.call(this, content, false)
    const records = encoded.records.subarray(0, encoded.count * this.helpers.nativeLayouts.ot_styled_text_chunk.size / Uint32Array.BYTES_PER_ELEMENT)
    return this.mutate(context, "editor_placeholder", { ...this.view(context, view), bytes: encodeBytes(encoded.bytes), records: encodeBytes(records), count: encoded.count })
  }

  createContextSyntaxStyle(context) { return this.issued(context, this.mutate(context, "syntax_create", {})) }
  destroyContextSyntaxStyle(context, style) { return this.mutate(context, "object_destroy", { handle: this.handle(context, style) }) }
  contextSyntaxStyleRegister(context, style, name, definition) {
    if (typeof name !== "string") throw new TypeError("Syntax style name must be a string")
    return this.mutate(context, "syntax_register", { style: this.handle(context, style), name, record: encodeBytes(this.helpers.encodeEditorStyle(definition)) })
  }
  contextSyntaxStyleResolveByName(context, style, name) {
    if (typeof name !== "string") throw new TypeError("Syntax style name must be a string")
    return this.call(context, "syntax_resolve", { style: this.handle(context, style), name }) || null
  }
  contextSyntaxStyleGetStyleCount(context, style) { return this.call(context, "syntax_count", { style: this.handle(context, style) }) }
}

function encodeBytes(value) { return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") }

function editorInfo(value) {
  return {
    virtualLineCount: value.virtual_line_count, totalVirtualLineCount: value.total_virtual_line_count,
    selection: value.selection_present === 0 ? null : { start: value.selection_start, end: value.selection_end },
    selectionOccupancy: value.selection_occupancy === 0 ? "cell" : "boundary",
  }
}
