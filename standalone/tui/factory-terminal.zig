const std = @import("std");
const upstream = @import("opentui");
const checked = upstream.checked;
const terminal = upstream.terminal_checked;
const c = upstream.abi;
const root = @import("root");
const Span = root.factory_binary.Span;

pub var native_status: i32 = 0;

const WireHandle = struct {
    context: []const u8,
    slot: u32,
    generation: u32,
    fn native(self: WireHandle) !c.ot_handle {
        return checked.handleToC(.{ .context_id = try std.fmt.parseInt(u64, self.context, 10), .slot = self.slot, .generation = self.generation });
    }
};
const TerminalArg = struct { terminal: WireHandle };
const KeyOptions = struct { action: u32 = 1, composing: u32 = 0, mods: u32 = 0, consumed_mods: u32 = 0, unshifted_codepoint: u32 = 0 };
const MouseOptions = struct { action: u32, button: i32 = -1, mods: u32 = 0, any_button_pressed: u32 = 0, x: f32, y: f32 };

pub const Request = union(enum) {
    create: struct { cols: u32, rows: u32, max_scrollback: u32 = 10_000 },
    destroy: TerminalArg,
    write: struct { terminal: WireHandle, bytes: Span },
    resize: struct { terminal: WireHandle, cols: u32, rows: u32 },
    command: struct { terminal: WireHandle, command: u32, argument: i32 = 0 },
    selection: struct { terminal: WireHandle, start_x: u32, start_y: u32, end_x: u32, end_y: u32 },
    selected_text: TerminalArg,
    compose: struct { terminal: WireHandle, target: WireHandle, frame: ?root.WireFrame = null, x: i32, y: i32 },
    cursor: TerminalArg,
    encode_key: struct { terminal: WireHandle, options: KeyOptions = .{}, key: Span, text: Span },
    encode_mouse: struct { terminal: WireHandle, options: MouseOptions },
    encode_paste: struct { terminal: WireHandle, bytes: Span },
    encode_focus: struct { terminal: WireHandle, focused: u32 },
    drain_responses: TerminalArg,
};

// The published OpenTUI controller, resource admission, and Ghostty VT engine
// stay intact. Only the C pointer transport is replaced with checked byte spans.
pub fn call(owner: *checked.ContextHandle, scratch: std.mem.Allocator, request: Request, writer: *std.Io.Writer) !void {
    switch (request) {
        .create => |options| {
            var record = header(c.ot_embedded_terminal_options);
            record.cols = options.cols;
            record.rows = options.rows;
            record.max_scrollback = options.max_scrollback;
            var output: c.ot_handle = undefined;
            try status(terminal.ot_embedded_terminal_create(owner, &record, &output));
            return json(.{ .context = try std.fmt.allocPrint(scratch, "{d}", .{output.context_id}), .slot = output.slot, .generation = output.generation }, writer);
        },
        .destroy => |options| {
            const handle = try options.terminal.native();
            try status(terminal.ot_embedded_terminal_destroy(owner, &handle));
        },
        .write => |options| {
            const handle = try options.terminal.native();
            const bytes = try root.binary_transfer.inputSpan(options.bytes);
            try status(terminal.ot_embedded_terminal_write(owner, &handle, bytes.ptr, @intCast(bytes.len)));
        },
        .resize => |options| {
            const handle = try options.terminal.native();
            try status(terminal.ot_embedded_terminal_resize(owner, &handle, options.cols, options.rows));
        },
        .command => |options| {
            const handle = try options.terminal.native();
            try status(terminal.ot_embedded_terminal_command(owner, &handle, options.command, options.argument));
        },
        .selection => |options| {
            const handle = try options.terminal.native();
            try status(terminal.ot_embedded_terminal_set_selection(owner, &handle, options.start_x, options.start_y, options.end_x, options.end_y));
        },
        .selected_text => |options| {
            const handle = try options.terminal.native();
            return json(try readOutput(terminal.ot_embedded_terminal_get_selected_text, .{ owner, &handle }), writer);
        },
        .compose => |options| {
            const handle = try options.terminal.native();
            const target = try options.target.native();
            const frame = if (options.frame) |value| checked.frameRequestToC(try value.native()) else null;
            try status(terminal.ot_embedded_terminal_compose(owner, &handle, &target, if (frame) |*value| value else null, options.x, options.y));
        },
        .cursor => |options| {
            const handle = try options.terminal.native();
            var record = header(c.ot_embedded_terminal_cursor);
            try status(terminal.ot_embedded_terminal_cursor_get(owner, &handle, &record));
            return json(record, writer);
        },
        .encode_key => |options| {
            const handle = try options.terminal.native();
            const key = try root.binary_transfer.inputSpan(options.key);
            const text = try root.binary_transfer.inputSpan(options.text);
            var record = header(c.ot_embedded_terminal_key);
            inline for (@typeInfo(KeyOptions).@"struct".fields) |field| @field(record, field.name) = @field(options.options, field.name);
            return json(try readOutput(terminal.ot_embedded_terminal_encode_key, .{ owner, &handle, &record, key.ptr, @as(u32, @intCast(key.len)), text.ptr, @as(u32, @intCast(text.len)) }), writer);
        },
        .encode_mouse => |options| {
            const handle = try options.terminal.native();
            var record = header(c.ot_embedded_terminal_mouse);
            inline for (@typeInfo(MouseOptions).@"struct".fields) |field| @field(record, field.name) = @field(options.options, field.name);
            // Like the published host, make one fixed-size call so successful
            // motion encoding advances Ghostty's duplicate-motion state once.
            const bytes = try root.binary_transfer.allocateOutput(128);
            var count: u32 = 0;
            try status(terminal.ot_embedded_terminal_encode_mouse(owner, &handle, &record, bytes.ptr, @intCast(bytes.len), &count));
            return json(try root.binary_transfer.publish(bytes[0..count]), writer);
        },
        .encode_paste => |options| {
            const handle = try options.terminal.native();
            const bytes = try root.binary_transfer.inputSpan(options.bytes);
            return json(try readOutput(terminal.ot_embedded_terminal_encode_paste, .{ owner, &handle, bytes.ptr, @as(u32, @intCast(bytes.len)) }), writer);
        },
        .encode_focus => |options| {
            const handle = try options.terminal.native();
            return json(try readOutput(terminal.ot_embedded_terminal_encode_focus, .{ owner, &handle, options.focused }), writer);
        },
        .drain_responses => |options| {
            const handle = try options.terminal.native();
            // A sizing call would consume no bytes and clear a queued overflow
            // error. Let the published JS controller own its one retry policy.
            const bytes = try root.binary_transfer.allocateOutput(upstream.context.terminal_input_bytes_max);
            var count: u32 = 0;
            try status(terminal.ot_embedded_terminal_drain_responses(owner, &handle, bytes.ptr, @intCast(bytes.len), &count));
            return json(try root.binary_transfer.publish(bytes[0..count]), writer);
        },
    }
    return json(null, writer);
}

fn readOutput(comptime method: anytype, args: anytype) !Span {
    var count: u32 = 0;
    try status(@call(.auto, method, args ++ .{ null, 0, &count }));
    const bytes = try root.binary_transfer.allocateOutput(count);
    if (bytes.len != 0) try status(@call(.auto, method, args ++ .{ bytes.ptr, @as(u32, @intCast(bytes.len)), &count }));
    return root.binary_transfer.publish(bytes[0..count]);
}

fn header(comptime T: type) T {
    var record = std.mem.zeroes(T);
    record.struct_size = @sizeOf(T);
    record.abi_version = c.OT_CONTEXT_ABI_VERSION;
    return record;
}

fn status(value: i32) !void {
    if (value == c.OT_OK) return;
    native_status = value;
    return error.NativeCallFailed;
}

fn json(value: anytype, writer: *std.Io.Writer) !void {
    return std.json.Stringify.value(value, .{}, writer);
}
