const std = @import("std");
const upstream = @import("opentui");
const Context = upstream.context.Context;
const Handle = upstream.context.Handle;

pub const io = std.Io.failing;
const allocator = if (@import("builtin").cpu.arch == .wasm32) std.heap.wasm_allocator else std.heap.page_allocator;
extern fn rendererExceptionProbe(kind: u32) u32;

var owner: ?*Context = null;
var input: [64 * 1024]u8 = undefined;
var output: [8 * 1024 * 1024]u8 = undefined;
var output_length: u32 = 0;

// Strings preserve every bit of the upstream u64 context identity across JSON.
const WireHandle = struct {
    context: []const u8,
    slot: u32,
    generation: u32,

    fn native(self: WireHandle) !Handle {
        return .{ .context_id = try std.fmt.parseInt(u64, self.context, 10), .slot = self.slot, .generation = self.generation };
    }
};
const Request = union(enum) {
    create_context: struct { object_capacity: u32 = 1024, render_cells_max: u32 = 16384 },
    destroy_context: void,
    exception_probe: u32,
    create_session: struct { width: u32, height: u32 },
    create_node: struct { session: WireHandle, kind: u32, num: u32 },
    move_node: struct { node: WireHandle, parent: ?WireHandle = null, index: u32 = 0 },
    destroy_node: WireHandle,
    style: struct { node: WireHandle, group: u32, kind: u32, edge: u32 = 0, unit: u32 = 0, value: f32, flags: u32 = 0 },
    paint: struct { node: WireHandle, options: upstream.scene.Paint },
    box_details: struct { node: WireHandle, options: upstream.scene.BoxDetails },
    text: struct { node: WireHandle, text: []const u8 },
    text_options: struct { node: WireHandle, options: upstream.scene.TextOptions },
    measure: struct { session: WireHandle, root: WireHandle },
    layout: struct { node: WireHandle, raw_yoga: bool = false },
    text_info: WireHandle,
    resize: struct { session: WireHandle, width: u32, height: u32 },
    capture: struct { session: WireHandle, background: upstream.buffer.RGBA = .{ 0, 0, 0, 255 }, use_mouse: bool = false },
};

export fn rendererInputPointer() [*]u8 {
    return &input;
}
export fn rendererInputCapacity() u32 {
    return input.len;
}
export fn rendererOutputPointer() [*]const u8 {
    return &output;
}
export fn rendererOutputLength() u32 {
    return output_length;
}

export fn rendererCall(length: u32) u32 {
    var writer: std.Io.Writer = .fixed(&output);
    call(length, &writer) catch |err| {
        writer.end = 0;
        std.json.Stringify.value(.{ .err = @errorName(err) }, .{}, &writer) catch unreachable;
        output_length = @intCast(writer.end);
        return 1;
    };
    output_length = @intCast(writer.end);
    return 0;
}

fn call(length: u32, writer: *std.Io.Writer) !void {
    if (length > input.len) return error.InputTooLarge;
    var scratch = std.heap.ArenaAllocator.init(allocator);
    defer scratch.deinit();
    const request = try std.json.parseFromSlice(Request, scratch.allocator(), input[0..length], .{});
    defer request.deinit();
    switch (request.value) {
        .create_context => |options| {
            if (owner != null) return error.ContextAlreadyCreated;
            if (options.object_capacity > 4096 or options.render_cells_max > 16384) return error.ProofLimit;
            const current = try Context.init(allocator, io, .{ .object_capacity = options.object_capacity, .render_cells_max = options.render_cells_max });
            current.objects.slot_count_max = options.object_capacity;
            owner = current;
        },
        .destroy_context => {
            try (try context()).deinit();
            owner = null;
        },
        .exception_probe => |kind| return std.json.Stringify.value(rendererExceptionProbe(kind), .{}, writer),
        .create_session => |options| {
            const current = try context();
            const handle = try current.createSession(.{ .chunk_size = 4096, .chunk_count = 2, .span_capacity = 2 });
            errdefer current.destroy(handle) catch unreachable;
            try current.attachSessionRenderer(handle, options.width, options.height, .{ .remote_mode = .remote, .forwarded_env = &.{} });
            return writeHandle(handle, writer);
        },
        .create_node => |options| {
            // This checkpoint exposes only real Root/Box/Text computation. Other
            // node types need their own resource and host contracts before export.
            if (options.kind > 2) return error.UnsupportedResource;
            return writeHandle(try (try context()).sceneCreateNode(try options.session.native(), options.kind, options.num), writer);
        },
        .move_node => |options| try (try context()).sceneMoveNode(try options.node.native(), if (options.parent) |parent| try parent.native() else null, options.index),
        .destroy_node => |handle| try (try context()).sceneDestroyNode(try handle.native()),
        .style => |options| try (try context()).sceneSetStyle(try options.node.native(), options.group, options.kind, options.edge, options.unit, options.value, options.flags),
        .paint => |options| try (try context()).sceneSetPaint(try options.node.native(), options.options),
        .box_details => |options| try (try context()).sceneSetBoxDetails(try options.node.native(), options.options),
        .text => |options| try (try context()).sceneSetText(try options.node.native(), options.text),
        .text_options => |options| try (try context()).sceneSetTextOptions(try options.node.native(), options.options),
        .measure => |options| try (try context()).sceneMeasureLayout(try options.session.native(), try options.root.native()),
        .layout => |options| return std.json.Stringify.value(try (try context()).sceneGetLayout(try options.node.native(), options.raw_yoga), .{}, writer),
        .text_info => |handle| return std.json.Stringify.value(try (try context()).sceneGetTextInfo(try handle.native()), .{}, writer),
        .resize => |options| try (try context()).resizeSessionRenderer(try options.session.native(), options.width, options.height),
        .capture => |options| {
            const current = try context();
            const session = try options.session.native();
            const frame = try current.scenePaint(session, options.background, options.use_mouse, 0);
            defer current.sceneFrameCancel(session, frame.frame_id) catch unreachable;
            const lease = try current.sceneFrameAcquireBufferLease(session, frame, .next);
            defer current.releaseBufferLease(lease) catch unreachable;
            const snapshot = try current.bufferLeaseSnapshot(lease);
            const text = try scratch.allocator().alloc(u8, try snapshot.getRealCharSize(true));
            const count = try snapshot.writeResolvedChars(text, true);
            return std.json.Stringify.value(.{
                .width = snapshot.width,
                .height = snapshot.height,
                .chars = snapshot.buffer.char,
                .foreground = snapshot.buffer.fg,
                .background = snapshot.buffer.bg,
                .attributes = snapshot.buffer.attributes,
                .text = text[0..count],
            }, .{}, writer);
        },
    }
    try writer.writeAll("null");
}

fn context() !*Context {
    return owner orelse error.ContextNotCreated;
}

fn writeHandle(handle: Handle, writer: *std.Io.Writer) !void {
    var identity: [20]u8 = undefined;
    try std.json.Stringify.value(WireHandle{ .context = try std.fmt.bufPrint(&identity, "{d}", .{handle.context_id}), .slot = handle.slot, .generation = handle.generation }, .{}, writer);
}
