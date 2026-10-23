const std = @import("std");
const upstream = @import("opentui");
const checked = upstream.checked;
const text = upstream.text_checked;
const c = upstream.abi;

pub var native_status: i32 = 0;

const WireHandle = struct {
    context: []const u8,
    slot: u32,
    generation: u32,
    fn native(self: WireHandle) !c.ot_handle {
        return checked.handleToC(.{ .context_id = try std.fmt.parseInt(u64, self.context, 10), .slot = self.slot, .generation = self.generation });
    }
};
const BufferArg = struct { buffer: WireHandle };
const ViewArg = struct { view: WireHandle };
const BytesArg = struct { buffer: WireHandle, bytes: []const u8 };
const StyledArg = struct { buffer: WireHandle, bytes: []const u8, records: []const u8, count: u32, url_bytes: []const u8 };
const Replacement = struct { buffer: WireHandle, view: WireHandle, bytes: []const u8, records: []const u8, count: u32, url_bytes: []const u8 };
const WireFrame = struct {
    session: WireHandle,
    root: WireHandle,
    node: WireHandle,
    frame_id: []const u8,
    request_id: []const u8,
    layout_epoch: []const u8,
    hook_generation: []const u8,
    kind: u32,
    num: u32,
    width: u32,
    height: u32,
    fn native(self: WireFrame) !c.ot_scene_frame_request {
        var value = record(c.ot_scene_frame_request);
        value.session = try self.session.native();
        value.root = try self.root.native();
        value.node = try self.node.native();
        value.frame_id = try std.fmt.parseInt(u64, self.frame_id, 10);
        value.request_id = try std.fmt.parseInt(u64, self.request_id, 10);
        value.layout_epoch = try std.fmt.parseInt(u64, self.layout_epoch, 10);
        value.hook_generation = try std.fmt.parseInt(u64, self.hook_generation, 10);
        value.kind = self.kind;
        value.num = self.num;
        value.width = self.width;
        value.height = self.height;
        return value;
    }
};

pub const Request = union(enum) {
    create: struct { width_method: u32 },
    destroy: BufferArg,
    view_create: BufferArg,
    view_destroy: ViewArg,
    set_text: BytesArg,
    append: BytesArg,
    clear: struct { buffer: WireHandle, reset: bool },
    styled: StyledArg,
    replace_batch: struct { replacements: []const Replacement },
    set_style: struct { buffer: WireHandle, style: ?WireHandle },
    info: BufferArg,
    get_text: BufferArg,
    range: struct { buffer: WireHandle, start: u32, end: u32 },
    defaults: struct { buffer: WireHandle, mask: u32, record: []const u8 },
    tab_width: struct { buffer: WireHandle, width: u32 },
    highlight: struct { buffer: WireHandle, operation: u32, argument: u32, record: ?[]const u8 },
    highlights: struct { buffer: WireHandle, line: u32 },
    viewport: struct { view: WireHandle, x: u32, y: u32, width: u32, height: u32, size_only: bool },
    command: struct { view: WireHandle, command: u32, argument: u32 },
    tab_color: struct { view: WireHandle, color: ?[4]u16 },
    select: struct { view: WireHandle, record: []const u8 },
    view_info: ViewArg,
    selected_text: ViewArg,
    lines: struct { view: WireHandle, logical: bool, first_line: u32, count: u32 },
    measure: struct { view: WireHandle, width: u32, height: u32 },
    scene_view: struct { node: WireHandle, view: ?WireHandle },
    scene_paint: struct { node: WireHandle, enabled: bool },
    draw: struct { target: WireHandle, frame: ?WireFrame, view: WireHandle, x: i32, y: i32 },
};

pub fn call(owner: *upstream.checked.ContextHandle, scratch: std.mem.Allocator, request: Request, writer: *std.Io.Writer) !void {
    switch (request) {
        .create => |options| {
            var settings = record(c.ot_edit_buffer_options);
            settings.width_method = options.width_method;
            var output: c.ot_handle = undefined;
            try status(text.ot_text_buffer_create(owner, &settings, &output));
            return json(try wire(scratch, output), writer);
        },
        .destroy => |options| {
            const handle = try options.buffer.native();
            try status(text.ot_text_buffer_destroy(owner, &handle));
        },
        .view_create => |options| {
            const handle = try options.buffer.native();
            var output: c.ot_handle = undefined;
            try status(text.ot_text_buffer_view_create(owner, &handle, &output));
            return json(try wire(scratch, output), writer);
        },
        .view_destroy => |options| {
            const handle = try options.view.native();
            try status(text.ot_text_buffer_view_destroy(owner, &handle));
        },
        .set_text, .append => |options| {
            const handle = try options.buffer.native();
            const bytes = try decode(scratch, options.bytes);
            try status(if (request == .set_text)
                text.ot_text_buffer_set_text(owner, &handle, bytes.ptr, @intCast(bytes.len))
            else
                text.ot_text_buffer_append(owner, &handle, bytes.ptr, @intCast(bytes.len)));
        },
        .clear => |options| {
            const handle = try options.buffer.native();
            try status(text.ot_text_buffer_clear(owner, &handle, @intFromBool(options.reset)));
        },
        .styled => |options| {
            const handle = try options.buffer.native();
            const bytes = try decode(scratch, options.bytes);
            const urls = try decode(scratch, options.url_bytes);
            const chunks = try records(c.ot_styled_text_chunk, scratch, options.records, options.count);
            try status(text.ot_text_buffer_set_styled_text(owner, &handle, bytes.ptr, @intCast(bytes.len), chunks.ptr, options.count, urls.ptr, @intCast(urls.len)));
        },
        .replace_batch => |options| return replaceBatch(owner, scratch, options.replacements, writer),
        .set_style => |options| {
            const handle = try options.buffer.native();
            const style = if (options.style) |value| try value.native() else null;
            try status(text.ot_text_buffer_set_syntax_style(owner, &handle, if (style) |*value| value else null));
        },
        .info => |options| {
            const handle = try options.buffer.native();
            var output = record(c.ot_text_buffer_info);
            try status(text.ot_text_buffer_get_info(owner, &handle, &output));
            return json(.{ .content_epoch = try std.fmt.allocPrint(scratch, "{d}", .{output.content_epoch}), .byte_count = output.byte_count, .text_length = output.text_length, .line_count = output.line_count, .highlight_count = output.highlight_count, .tab_width = output.tab_width }, writer);
        },
        .get_text => |options| return readText(owner, scratch, .text, try options.buffer.native(), 0, 0, writer),
        .range => |options| return readText(owner, scratch, .range, try options.buffer.native(), options.start, options.end, writer),
        .defaults => |options| {
            const handle = try options.buffer.native();
            const style = try records(c.ot_editor_style, scratch, options.record, 1);
            try status(text.ot_text_buffer_set_defaults(owner, &handle, options.mask, &style[0]));
        },
        .tab_width => |options| {
            const handle = try options.buffer.native();
            try status(text.ot_text_buffer_set_tab_width(owner, &handle, options.width));
        },
        .highlight => |options| {
            const handle = try options.buffer.native();
            const highlight = if (options.record) |value| &(try records(c.ot_edit_highlight, scratch, value, 1))[0] else null;
            try status(text.ot_text_buffer_highlight(owner, &handle, options.operation, options.argument, highlight));
        },
        .highlights => |options| {
            const handle = try options.buffer.native();
            var count: u32 = 0;
            try status(text.ot_text_buffer_get_highlights(owner, &handle, options.line, null, 0, &count));
            if (count > 65536) return error.ObjectLimit;
            const output = try scratch.alloc(c.ot_edit_highlight, count);
            try status(text.ot_text_buffer_get_highlights(owner, &handle, options.line, output.ptr, count, &count));
            return json(output, writer);
        },
        .viewport => |options| {
            const handle = try options.view.native();
            var viewport = record(c.ot_editor_viewport);
            viewport.x = options.x;
            viewport.y = options.y;
            viewport.width = options.width;
            viewport.height = options.height;
            try status(text.ot_text_buffer_view_set_viewport(owner, &handle, &viewport, @intFromBool(options.size_only)));
        },
        .command => |options| {
            const handle = try options.view.native();
            try status(text.ot_text_buffer_view_command(owner, &handle, options.command, options.argument));
        },
        .tab_color => |options| {
            const handle = try options.view.native();
            try status(text.ot_text_buffer_view_set_tab_color(owner, &handle, if (options.color) |*value| value else null));
        },
        .select => |options| {
            const handle = try options.view.native();
            const selection = try records(c.ot_editor_selection, scratch, options.record, 1);
            var changed: u32 = 0;
            try status(text.ot_text_buffer_view_select(owner, &handle, &selection[0], &changed));
            return json(changed != 0, writer);
        },
        .view_info => |options| {
            const handle = try options.view.native();
            var output = record(c.ot_editor_view_info);
            try status(text.ot_text_buffer_view_get_info(owner, &handle, &output));
            return json(output, writer);
        },
        .selected_text => |options| return readText(owner, scratch, .selection, try options.view.native(), 0, 0, writer),
        .lines => |options| {
            const handle = try options.view.native();
            var info = record(c.ot_editor_measure);
            try status(text.ot_text_buffer_view_get_lines(owner, &handle, @intFromBool(options.logical), 0, null, 0, &info));
            const start = @min(options.first_line, info.line_count);
            const count = @min(options.count, info.line_count - start);
            if (count > 65536) return error.ObjectLimit;
            const output = try scratch.alloc(c.ot_scene_text_line, count);
            try status(text.ot_text_buffer_view_get_lines(owner, &handle, @intFromBool(options.logical), start, output.ptr, count, &info));
            return json(.{ .lines = output, .width_cols_max = info.width_cols_max }, writer);
        },
        .measure => |options| {
            const handle = try options.view.native();
            var output = record(c.ot_editor_measure);
            try status(text.ot_text_buffer_view_measure(owner, &handle, options.width, options.height, &output));
            return json(.{ .line_count = output.line_count, .width_cols_max = output.width_cols_max }, writer);
        },
        .scene_view => |options| {
            const node = try options.node.native();
            const view = if (options.view) |value| try value.native() else null;
            try status(text.ot_scene_set_text_view(owner, &node, if (view) |*value| value else null));
        },
        .scene_paint => |options| {
            const node = try options.node.native();
            try status(text.ot_scene_set_text_view_paint(owner, &node, @intFromBool(options.enabled)));
        },
        .draw => |options| {
            const target = try options.target.native();
            const source = try options.view.native();
            const frame = if (options.frame) |value| try value.native() else null;
            try status(text.ot_buffer_draw_text_view(owner, &target, if (frame) |*value| value else null, &source, options.x, options.y));
        },
    }
    return json(null, writer);
}

fn readText(owner: *checked.ContextHandle, scratch: std.mem.Allocator, kind: enum { text, range, selection }, handle: c.ot_handle, start: u32, end: u32, writer: *std.Io.Writer) !void {
    var count: u32 = 0;
    try status(switch (kind) {
        .text => text.ot_text_buffer_get_text(owner, &handle, null, 0, &count),
        .range => text.ot_text_buffer_get_range(owner, &handle, start, end, null, 0, &count),
        .selection => text.ot_text_buffer_view_get_selected_text(owner, &handle, null, 0, &count),
    });
    if (count > 4 * 1024 * 1024) return error.ObjectLimit;
    const bytes = try scratch.alloc(u8, count);
    try status(switch (kind) {
        .text => text.ot_text_buffer_get_text(owner, &handle, bytes.ptr, count, &count),
        .range => text.ot_text_buffer_get_range(owner, &handle, start, end, bytes.ptr, count, &count),
        .selection => text.ot_text_buffer_view_get_selected_text(owner, &handle, bytes.ptr, count, &count),
    });
    return json(try encode(scratch, bytes), writer);
}

fn replaceBatch(owner: *checked.ContextHandle, scratch: std.mem.Allocator, replacements: []const Replacement, writer: *std.Io.Writer) !void {
    if (replacements.len > c.OT_TEXT_REPLACEMENT_COUNT_MAX) return error.InvalidOptions;
    const Decoded = struct { bytes: []u8, urls: []u8, chunks: []c.ot_styled_text_chunk };
    const decoded = try scratch.alloc(Decoded, replacements.len);
    var byte_count: usize = 0;
    var url_count: usize = 0;
    var chunk_count: usize = 0;
    for (replacements, decoded) |replacement, *value| {
        value.* = .{ .bytes = try decode(scratch, replacement.bytes), .urls = try decode(scratch, replacement.url_bytes), .chunks = try records(c.ot_styled_text_chunk, scratch, replacement.records, replacement.count) };
        byte_count += value.bytes.len;
        url_count += value.urls.len;
        chunk_count += value.chunks.len;
        if (byte_count > c.OT_TEXT_REPLACEMENT_BYTES_MAX or url_count > c.OT_TEXT_REPLACEMENT_URL_BYTES_MAX or chunk_count > c.OT_TEXT_REPLACEMENT_CHUNKS_MAX) return error.InvalidOptions;
    }
    const bytes = try scratch.alloc(u8, byte_count);
    const urls = try scratch.alloc(u8, url_count);
    const chunks = try scratch.alloc(c.ot_styled_text_chunk, chunk_count);
    const input = try scratch.alloc(c.ot_text_buffer_replacement, replacements.len);
    const output = try scratch.alloc(c.ot_text_buffer_replacement_info, replacements.len);
    byte_count = 0;
    url_count = 0;
    chunk_count = 0;
    for (replacements, decoded, input) |replacement, value, *item| {
        item.* = record(c.ot_text_buffer_replacement);
        item.buffer = try replacement.buffer.native();
        item.view = try replacement.view.native();
        item.byte_offset = @intCast(byte_count);
        item.byte_count = @intCast(value.bytes.len);
        item.chunk_offset = @intCast(chunk_count);
        item.chunk_count = @intCast(value.chunks.len);
        @memcpy(bytes[byte_count..][0..value.bytes.len], value.bytes);
        @memcpy(urls[url_count..][0..value.urls.len], value.urls);
        @memcpy(chunks[chunk_count..][0..value.chunks.len], value.chunks);
        for (chunks[chunk_count..][0..value.chunks.len]) |*chunk| {
            if (chunk.flags & c.OT_SCENE_TEXT_LINK != 0) chunk.link_offset = std.math.add(u32, chunk.link_offset, @intCast(url_count)) catch return error.InvalidOptions;
        }
        byte_count += value.bytes.len;
        url_count += value.urls.len;
        chunk_count += value.chunks.len;
    }
    try status(text.ot_text_buffer_replace_styled_batch(owner, input.ptr, @intCast(input.len), bytes.ptr, @intCast(bytes.len), chunks.ptr, @intCast(chunks.len), urls.ptr, @intCast(urls.len), output.ptr));
    return json(output, writer);
}

fn record(comptime T: type) T {
    var value = std.mem.zeroes(T);
    value.struct_size = @sizeOf(T);
    value.abi_version = c.OT_CONTEXT_ABI_VERSION;
    return value;
}
fn status(value: i32) !void {
    if (value == c.OT_OK) return;
    native_status = value;
    return error.CheckedOperationFailed;
}
fn json(value: anytype, writer: *std.Io.Writer) !void {
    return std.json.Stringify.value(value, .{}, writer);
}
fn wire(scratch: std.mem.Allocator, value: c.ot_handle) !WireHandle {
    const handle = checked.handleFromC(value);
    return .{ .context = try std.fmt.allocPrint(scratch, "{d}", .{handle.context_id}), .slot = handle.slot, .generation = handle.generation };
}
fn decode(scratch: std.mem.Allocator, encoded: []const u8) ![]u8 {
    const bytes = try scratch.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(encoded));
    try std.base64.standard.Decoder.decode(bytes, encoded);
    return bytes;
}
fn encode(scratch: std.mem.Allocator, bytes: []const u8) ![]const u8 {
    const encoded = try scratch.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len));
    return std.base64.standard.Encoder.encode(encoded, bytes);
}
fn records(comptime T: type, scratch: std.mem.Allocator, encoded: []const u8, count: u32) ![]T {
    const bytes = try decode(scratch, encoded);
    const length = std.math.mul(usize, @sizeOf(T), count) catch return error.InvalidOptions;
    if (bytes.len != length) return error.InvalidOptions;
    const values = try scratch.alloc(T, count);
    @memcpy(std.mem.sliceAsBytes(values), bytes);
    return values;
}
