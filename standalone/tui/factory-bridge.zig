const std = @import("std");
const upstream = @import("opentui");
const Context = upstream.context.Context;
const Handle = upstream.context.Handle;
const checked = upstream.checked;
const c = upstream.abi;
const scene = upstream.scene;
const session = upstream.session;
const editor_checked = upstream.editor_checked;
const RGBA = upstream.buffer.RGBA;
const factory_text = @import("factory-text.zig");
const factory_image = @import("factory-image.zig");
const factory_terminal = @import("factory-terminal.zig");
const allocator = if (@import("builtin").cpu.arch == .wasm32) std.heap.wasm_allocator else std.heap.page_allocator;
pub const factory_binary = @import("factory-binary.zig");
pub var binary_transfer = factory_binary.Transfer.init(allocator);

// Yoga borrows this synchronous owner-thread callback while its native provider
// is installed. The host contains exceptions and writes only the two f32 lanes.
extern "opentui_standalone" fn scene_measure(u64, u32, u32, f32, u32, f32, u32, *[2]f32) callconv(.c) void;

pub const io = std.Io.failing;
var owner: ?*checked.ContextHandle = null;
var input: [1024 * 1024]u8 = undefined;
var output: [8 * 1024 * 1024]u8 = undefined;
var output_length: u32 = 0;
var native_status: i32 = 0;
const EditNotification = struct { handle: Handle, event: upstream.context.EditEvent };
var edit_notifications: [4096]EditNotification = undefined;
var edit_notifications_count: usize = 0;
var edit_notifications_overflow = false;

const WireHandle = struct {
    context: []const u8,
    slot: u32,
    generation: u32,
    fn native(self: WireHandle) !Handle {
        return .{ .context_id = try number(self.context), .slot = self.slot, .generation = self.generation };
    }
};
const Geometry = struct { flags: u32 = 0, paint: ?scene.Layout = null, public_layout: ?scene.Layout = null };
const WirePaintSlot = struct { node: WireHandle, hook_generation: []const u8, num: u32, hooks: u32, clip: upstream.buffer.ClipRect, opacity: f32, paint_layout: scene.Layout, public_layout: ?scene.Layout };
pub const WireFrame = struct {
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
    geometry: ?Geometry = null,
    pub fn native(self: WireFrame) !scene.FrameRequest {
        return .{
            .session = try self.session.native(),
            .root = try self.root.native(),
            .node = try self.node.native(),
            .frame_id = try number(self.frame_id),
            .request_id = try number(self.request_id),
            .layout_epoch = try number(self.layout_epoch),
            .hook_generation = try number(self.hook_generation),
            .kind = self.kind,
            .num = self.num,
            .width = self.width,
            .height = self.height,
        };
    }
};
const WireTicket = struct {
    session: WireHandle,
    request_id: []const u8,
    byte_count: u32,
    fn native(self: WireTicket) !session.OutputTicket {
        return .{ .session = try self.session.native(), .request_id = try number(self.request_id), .len = self.byte_count };
    }
};
const SessionArg = struct { session: WireHandle };
const NodeArg = struct { node: WireHandle };
const LeaseArg = struct { lease: WireHandle };
const EditArg = struct { edit: WireHandle };
const ViewArg = struct { view: WireHandle };
const StyleArg = struct { style: WireHandle };
const Viewport = struct { x: u32, y: u32, width: u32, height: u32 };

// This reactor exposes real checked Context resources used by the published JS
// renderer. OS-owned resources and unimplemented tags fail explicitly.
const Request = union(enum) {
    context_create: struct { object_capacity: u32, render_cells_max: u32 },
    context_destroy: struct {},
    image: factory_image.Request,
    terminal: factory_terminal.Request,
    context_link_url: struct { link_id: u32 },
    unicode_create: struct { text: []const u8, width_method: u32 },
    unicode_get: struct { unicode: WireHandle },
    buffer_draw_unicode: struct { target: WireHandle, frame: ?WireFrame = null, unicode: WireHandle, index: u32, x: i32, y: i32, foreground: RGBA, background: RGBA, attributes: u32 },
    session_create: struct { chunk_size: u32, span_capacity: u32, max_bytes: []const u8, control_capacity: u32 = 0 },
    session_destroy: SessionArg,
    session_attach: struct { session: WireHandle, width: u32, height: u32, remote: ?bool = null, environment: []const session.EnvironmentEntry = &.{} },
    session_write_limit: SessionArg,
    session_capabilities: SessionArg,
    session_renderer_state: SessionArg,
    session_state: SessionArg,
    session_close: SessionArg,
    session_cancel: SessionArg,
    session_pump: struct { session: WireHandle, now_ns: []const u8, work_budget: u32 },
    session_read_output: struct { session: WireHandle, capacity: u32 },
    session_complete_output: struct { session: WireHandle, ticket: WireTicket, success: bool },
    session_set_screen: struct { session: WireHandle, alternate: bool, width: u32, height: u32, trailing_output: []const u8 = "" },
    session_control: struct { session: WireHandle, kind: u32, argument: u32 = 0, bytes: []const u8 = "" },
    session_split_control: struct { session: WireHandle, command: u32, arguments: []const u32 },
    session_sync_detached: struct { session: WireHandle, parent: WireHandle },
    session_resize: struct { session: WireHandle, width: u32, height: u32 },
    session_image_resolution: struct { session: WireHandle, terminal_width: u32, terminal_height: u32, pixel_width: u32, pixel_height: u32 },
    session_kitty_transport: struct { session: WireHandle, mode: u32 },
    session_palette: struct { session: WireHandle, palette: []const RGBA, foreground: RGBA, background: RGBA, epoch: u32 },
    session_update_stats: struct { session: WireHandle, overall_ms: f64, fps: u32, callback_ms: f64 },
    session_write: struct { session: WireHandle, bytes: []const u8 },
    session_debug_overlay: struct { session: WireHandle, enabled: bool, corner: u32 },
    session_memory_stats: struct { session: WireHandle, heap_used: u32, heap_total: u32, array_buffers: u32 },
    session_dump_hit_grid: SessionArg,
    session_link_id: struct { session: WireHandle, x: i32, y: i32 },
    session_setup_terminal: struct { session: WireHandle, options: session.TerminalOptions },
    session_suspend: SessionArg,
    session_resume: SessionArg,
    session_terminal_state: SessionArg,
    session_clipboard: struct { session: WireHandle, target: u32, bytes: []const u8 },
    session_notification: struct { session: WireHandle, message: []const u8, title: []const u8 = "" },
    session_kitty_status: SessionArg,
    session_kitty_poll: struct { session: WireHandle, now_ns: []const u8 },
    session_kitty_cancel: struct { session: WireHandle, failed: bool },
    session_kitty_reply: struct { session: WireHandle, bytes: []const u8 },
    session_kitty_probe: SessionArg,
    session_buffer_lease: struct { session: WireHandle, which: u32, frame: ?WireFrame = null },
    lease_validate: LeaseArg,
    lease_release: LeaseArg,
    lease_resolved: struct { lease: WireHandle, add_line_breaks: bool, include_lengths: bool = false },
    scene_create: struct { session: WireHandle, kind: u32, num: u32 },
    scene_destroy: NodeArg,
    scene_move: struct { node: WireHandle, parent: ?WireHandle = null, index: u32 = 0 },
    scene_focus: struct { node: WireHandle, focused: bool },
    scene_viewport: struct { node: WireHandle, viewport: ?WireHandle },
    scene_surface: struct { node: WireHandle, buffer: ?WireHandle },
    scene_layout: struct { node: WireHandle, raw_yoga: bool = false },
    scene_measure_layout: struct { session: WireHandle, root: WireHandle },
    scene_style: struct { node: WireHandle, group: u32, kind: u32, edge: u32 },
    scene_mark_dirty: NodeArg,
    scene_measure: struct { node: WireHandle, enabled: bool },
    scene_hooks: struct { node: WireHandle, flags: u32, generation: []const u8, initial_width: f64, initial_height: f64 },
    scene_has_measure: NodeArg,
    scene_box: struct { node: WireHandle, options: scene.BoxDetails },
    scene_slider: struct { node: WireHandle, options: scene.SliderOptions },
    scene_slider_thumb: NodeArg,
    scene_arrow: struct { node: WireHandle, options: scene.ArrowOptions },
    scene_text: struct { node: WireHandle, text: []const u8 },
    scene_styled_text: struct { node: WireHandle, bytes: []const u8, records: []const u8, count: u32, url_bytes: []const u8 },
    scene_get_text: NodeArg,
    scene_editor_view: struct { node: WireHandle, view: ?WireHandle },
    scene_editor_options: struct { node: WireHandle, options: scene.EditorOptions },
    scene_text_options: struct { node: WireHandle, options: scene.TextOptions },
    scene_text_info: NodeArg,
    scene_text_lines: struct { node: WireHandle, first_line: u32, count: u32 },
    scene_selection: struct { node: WireHandle, options: upstream.context.SceneTextSelectionOptions },
    scene_selection_state: NodeArg,
    scene_flush: struct { bytes: []const u8 },
    frame_step: struct { session: WireHandle, previous: ?WireFrame = null, options: scene.FrameOptions, max_work: u32, recording: ?[]const u8 = null },
    frame_commit: struct { session: WireHandle, frame: WireFrame, force: bool },
    frame_cancel: struct { session: WireHandle, frame_id: []const u8 },
    frame_copy_buffer: struct { session: WireHandle, frame: WireFrame, target: WireHandle },
    frame_paint_slots: struct { session: WireHandle, frame: WireFrame },
    session_render_split: struct { session: WireHandle, frame: ?WireFrame, snapshots: []const struct { buffer: WireHandle, row_columns: u32, start_on_new_line: bool, trailing_newline: bool }, pinned_render_offset: u32, force: bool },
    buffer_create: struct { width: u32, height: u32, respect_alpha: bool = false, width_method: u32 },
    buffer_resize: struct { buffer: WireHandle, width: u32, height: u32 },
    buffer_lease: struct { buffer: WireHandle },
    buffer_draw: struct { target: WireHandle, frame: ?WireFrame = null, record: []const u8, source: ?WireHandle = null, text: []const u8 = "", bottom: []const u8 = "" },
    buffer_stack: struct { target: WireHandle, frame: ?WireFrame = null, operation: u32, x: i32 = 0, y: i32 = 0, width: u32 = 0, height: u32 = 0, opacity: f32 = 1 },
    buffer_grid: struct { target: WireHandle, frame: ?WireFrame = null, options: upstream.context.BufferGrid, columns: []const i32, rows: []const i32 },
    buffer_packed: struct { target: WireHandle, frame: ?WireFrame = null, bytes: []const u8, x: i32, y: i32, width: u32, height: u32 },
    buffer_supersample: struct { target: WireHandle, frame: ?WireFrame = null, bytes: []const u8, x: i32, y: i32, format: u32, stride: u32 },
    buffer_grayscale: struct { target: WireHandle, frame: ?WireFrame = null, bytes: []const u8, x: i32, y: i32, width: u32, height: u32, foreground: ?RGBA, background: ?RGBA, supersampled: bool },
    buffer_color_matrix: struct { target: WireHandle, frame: ?WireFrame = null, matrix: []const u8, mask: ?[]const u8, strength: f32, channel: u32 },
    buffer_draw_editor: struct { target: WireHandle, frame: ?WireFrame = null, source: WireHandle, x: i32, y: i32 },
    buffer_draw_scene_text: struct { target: WireHandle, frame: ?WireFrame = null, source: WireHandle, x: i32, y: i32 },
    scene_stats: SessionArg,
    scene_cursor: SessionArg,
    scene_hit_test: struct { session: WireHandle, x: i32, y: i32 },
    object_destroy: struct { handle: WireHandle },
    edit_create: struct { width_method: u32 },
    editor_create: struct { edit: WireHandle, width: u32, height: u32 },
    edit_set_text: struct { edit: WireHandle, bytes: []const u8, preserve_history: bool = false },
    edit_insert_text: struct { edit: WireHandle, bytes: []const u8 },
    edit_get_text: EditArg,
    edit_info: EditArg,
    edit_set_cursor: struct { edit: WireHandle, row: u32, col: u32 },
    edit_delete_range: struct { edit: WireHandle, start_row: u32, start_col: u32, end_row: u32, end_col: u32 },
    edit_command: struct { edit: WireHandle, command: u32, argument: u32 = 0 },
    edit_history: struct { edit: WireHandle, redo: bool },
    edit_position: struct { edit: WireHandle, query: u32, a: u32 = 0, b: u32 = 0 },
    edit_range: struct { edit: WireHandle, by_coords: bool, start_row: u32, start_col: u32, end_row: u32, end_col: u32 },
    edit_measure_text: struct { edit: WireHandle, bytes: []const u8 },
    edit_measure: struct { bytes: []const u8, width_method: u32, tab_width: u32 },
    edit_defaults: struct { edit: WireHandle, mask: u32, record: []const u8 },
    edit_tab_width: struct { edit: WireHandle, width: u32 },
    edit_set_style: struct { edit: WireHandle, style: ?WireHandle },
    edit_highlight: struct { edit: WireHandle, operation: u32, argument: u32 = 0, record: ?[]const u8 = null },
    edit_highlights: struct { edit: WireHandle, line: u32 },
    edit_event_enable: struct {},
    edit_events: struct {},
    editor_viewport: ViewArg,
    editor_set_viewport: struct { view: WireHandle, viewport: Viewport, size_only: bool = false, move_cursor: bool = false },
    editor_scroll_margin: struct { view: WireHandle, margin: f32 },
    editor_command: struct { view: WireHandle, command: u32, argument: u32 = 0 },
    editor_tab_color: struct { view: WireHandle, color: ?RGBA },
    editor_select: struct { view: WireHandle, record: []const u8 },
    editor_info: struct { view: WireHandle, follow_cursor: bool = false },
    editor_selection: ViewArg,
    editor_selected_text: ViewArg,
    editor_position: struct { view: WireHandle, query: u32 },
    editor_lines: struct { view: WireHandle, logical: bool = false },
    editor_measure: struct { view: WireHandle, width: u32, height: u32 },
    editor_replace_selection: struct { view: WireHandle, bytes: []const u8 },
    editor_placeholder: struct { view: WireHandle, bytes: []const u8, records: []const u8, count: u32 },
    syntax_create: struct {},
    syntax_register: struct { style: WireHandle, name: []const u8, record: []const u8 },
    syntax_resolve: struct { style: WireHandle, name: []const u8 },
    syntax_count: StyleArg,
    text: factory_text.Request,
    diagnostics: struct {},
};

export fn factoryInputPointer() [*]u8 {
    return &input;
}
export fn factoryInputCapacity() u32 {
    return input.len;
}
export fn factoryOutputPointer() [*]const u8 {
    return &output;
}
export fn factoryOutputLength() u32 {
    return output_length;
}
export fn factoryBinaryReserve(count: u32) i32 {
    binary_transfer.reserve(count) catch |err| return binaryStatus(err).?;
    return c.OT_OK;
}
export fn factoryBinaryPointer() usize {
    return if (binary_transfer.input.len == 0) 0 else @intFromPtr(binary_transfer.input.ptr);
}
export fn factoryBinaryLength() u32 {
    return @intCast(binary_transfer.input.len);
}
export fn factoryBinaryGeneration() u32 {
    return binary_transfer.input_generation;
}
export fn factoryBinaryOutputGeneration() u32 {
    return binary_transfer.output_generation;
}
export fn factoryBinaryRelease(generation: u32) i32 {
    binary_transfer.release(generation) catch |err| return binaryStatus(err).?;
    return c.OT_OK;
}

pub fn binaryStatus(err: anyerror) ?i32 {
    return switch (err) {
        error.BinaryBusy => c.OT_CONTEXT_BUSY,
        error.BinaryRange => c.OT_INVALID_ARGUMENT,
        error.BinaryStale => c.OT_STALE_HANDLE,
        error.BinaryLimit => c.OT_IMAGE_MEMORY_LIMIT,
        error.BinaryGenerationLimit, error.OutOfMemory => c.OT_OUT_OF_MEMORY,
        else => null,
    };
}

export fn factoryCall(length: u32) u32 {
    var writer: std.Io.Writer = .fixed(&output);
    const previous_native_status = native_status;
    const previous_text_status = factory_text.native_status;
    const previous_image_status = factory_image.native_status;
    const previous_terminal_status = factory_terminal.native_status;
    defer {
        native_status = previous_native_status;
        factory_text.native_status = previous_text_status;
        factory_image.native_status = previous_image_status;
        factory_terminal.native_status = previous_terminal_status;
    }
    native_status = c.OT_OK;
    factory_text.native_status = c.OT_OK;
    factory_image.native_status = c.OT_OK;
    factory_terminal.native_status = c.OT_OK;
    binaryCall(length, &writer) catch |err| {
        writer.end = 0;
        const error_status = if (native_status != c.OT_OK) native_status else if (factory_text.native_status != c.OT_OK) factory_text.native_status else if (factory_image.native_status != c.OT_OK) factory_image.native_status else if (factory_terminal.native_status != c.OT_OK) factory_terminal.native_status else if (binaryStatus(err)) |value| value else if (owner) |current| checked.sessionError(current, err) else c.OT_INVALID_ARGUMENT;
        std.json.Stringify.value(.{ .err = @errorName(err), .native_status = error_status }, .{}, &writer) catch unreachable;
        output_length = @intCast(writer.end);
        return 1;
    };
    output_length = @intCast(writer.end);
    return 0;
}

fn binaryCall(length: u32, writer: *std.Io.Writer) !void {
    try binary_transfer.enter();
    defer binary_transfer.leave();
    try call(length, writer);
}

fn call(length: u32, writer: *std.Io.Writer) !void {
    if (length > input.len) return error.InputTooLarge;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const scratch = arena.allocator();
    // A legal read-only scene query may reenter during a Yoga measure callback.
    // Own every string so its request cannot overwrite the suspended outer one.
    const parsed = try std.json.parseFromSlice(Request, scratch, input[0..length], .{ .allocate = .alloc_always });
    defer parsed.deinit();
    switch (parsed.value) {
        .context_create => |options| {
            if (owner != null) return error.ContextAlreadyCreated;
            if (options.object_capacity == 0 or options.object_capacity > 65536 or options.render_cells_max == 0 or options.render_cells_max > 1000000) return error.ObjectLimit;
            const core = try Context.init(allocator, io, .{ .object_capacity = options.object_capacity, .render_cells_max = options.render_cells_max });
            errdefer core.deinit() catch unreachable;
            const created = try allocator.create(checked.ContextHandle);
            // These allocator/I/O fields are not used: checked functions borrow
            // this wrapper; Context creation and destruction stay reactor-owned.
            created.* = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = core, .owner_thread = 0 };
            owner = created;
            edit_notifications_count = 0;
            edit_notifications_overflow = false;
            return json(try decimal(scratch, core.objects.context_id), writer);
        },
        .context_destroy => {
            const current = try wrapper();
            try current.core.deinit();
            allocator.destroy(current);
            owner = null;
            binary_transfer.clear();
        },
        .image => |options| return factory_image.call(try wrapper(), scratch, options, writer),
        .terminal => |options| return factory_terminal.call(try wrapper(), scratch, options, writer),
        .context_link_url => |options| {
            const core = try context();
            const count = try core.getLinkUrl(options.link_id, &.{});
            if (count > 4 * 1024 * 1024) return error.ObjectLimit;
            const bytes = try scratch.alloc(u8, count);
            const written = try core.getLinkUrl(options.link_id, bytes);
            return json(try base64(scratch, bytes[0..written]), writer);
        },
        .unicode_create => |options| return json(try wireHandle(scratch, try (try context()).createUnicode(options.text, try checked.widthMethodFromC(options.width_method))), writer),
        .unicode_get => |options| {
            const handle = checked.handleToC(try options.unicode.native());
            var count: u32 = 0;
            try status(upstream.unicode_checked.ot_unicode_get(try wrapper(), &handle, null, 0, &count));
            if (count > 65536) return error.ObjectLimit;
            const values = try scratch.alloc(c.ot_unicode_char, count);
            try status(upstream.unicode_checked.ot_unicode_get(try wrapper(), &handle, values.ptr, count, &count));
            return json(values[0..count], writer);
        },
        .buffer_draw_unicode => |options| try (try context()).drawBufferUnicode(try options.target.native(), if (options.frame) |frame| try frame.native() else null, try options.unicode.native(), options.index, options.x, options.y, options.foreground, options.background, options.attributes),
        .session_create => |options| {
            const maximum = try number(options.max_bytes);
            if (options.chunk_size == 0 or maximum == 0 or maximum % options.chunk_size != 0 or maximum / options.chunk_size > std.math.maxInt(u32)) return error.InvalidOptions;
            return json(try wireHandle(scratch, try (try context()).createSession(.{ .chunk_size = options.chunk_size, .chunk_count = @intCast(maximum / options.chunk_size), .span_capacity = options.span_capacity, .control_capacity = options.control_capacity })), writer);
        },
        .session_destroy => |options| try (try context()).destroy(try options.session.native()),
        .session_attach => |options| try (try context()).attachSessionRenderer(try options.session.native(), options.width, options.height, .{ .remote_mode = if (options.remote) |remote| if (remote) .remote else .local else .auto, .forwarded_env = options.environment }),
        .session_write_limit => |options| {
            const current = try (try context()).raw().getSession(try options.session.native());
            return json(try decimal(scratch, @min(current.output.atomicByteLimit(), std.math.maxInt(u32))), writer);
        },
        .session_capabilities => |options| {
            var capabilities = record(c.ot_session_capabilities);
            const handle = checked.handleToC(try options.session.native());
            try status(checked.ot_session_get_capabilities(try wrapper(), &handle, &capabilities));
            return json(.{ .flags = capabilities.flags, .width_method = capabilities.width_method, .multiplexer = capabilities.multiplexer, .image_protocol = capabilities.image_protocol, .osc52_support = capabilities.osc52_support, .kitty_keyboard_flags = capabilities.kitty_keyboard_flags, .term_name = capabilities.term_name[0..capabilities.term_name_len], .term_version = capabilities.term_version[0..capabilities.term_version_len], .term_from_xtversion = capabilities.term_from_xtversion != 0 }, writer);
        },
        .session_renderer_state => |options| {
            const current = try (try context()).raw().getSession(try options.session.native());
            const renderer = current.renderer orelse return error.RendererNotAttached;
            return json(.{ .width = renderer.width, .height = renderer.height, .frame_count = try decimal(scratch, renderer.getRenderStats().frameCount), .frame_pending = current.frame_end_offset != null }, writer);
        },
        .session_state => |options| return json(@intFromEnum((try (try context()).raw().getSession(try options.session.native())).state), writer),
        .session_close => |options| try (try context()).beginSessionClose(try options.session.native()),
        .session_cancel => |options| try (try context()).cancelSession(try options.session.native()),
        .session_pump => |options| {
            const result = try (try context()).pumpSession(try options.session.native(), try number(options.now_ns), options.work_budget);
            return json(.{ .status = @intFromEnum(result.status), .deadline_ns = if (result.deadline_ns) |deadline| try decimal(scratch, deadline) else null }, writer);
        },
        .session_read_output => |options| {
            if (options.capacity > 1024 * 1024) return error.InvalidOptions;
            const bytes = try scratch.alloc(u8, options.capacity);
            const ticket = try (try context()).readOutput(try options.session.native(), bytes) orelse return json(null, writer);
            return json(.{ .ticket = WireTicket{ .session = try wireHandle(scratch, ticket.session), .request_id = try decimal(scratch, ticket.request_id), .byte_count = ticket.len }, .bytes = try base64(scratch, bytes[0..ticket.len]) }, writer);
        },
        .session_complete_output => |options| try (try context()).completeOutput(try options.session.native(), try options.ticket.native(), if (options.success) .written else .failed),
        .session_set_screen => |options| {
            const handle = checked.handleToC(try options.session.native());
            const bytes = try unbase64(scratch, options.trailing_output);
            try status(upstream.output_checked.ot_session_set_screen(try wrapper(), &handle, @intFromBool(options.alternate), options.width, options.height, bytes.ptr, @intCast(bytes.len)));
        },
        .session_control => |options| {
            const handle = checked.handleToC(try options.session.native());
            const bytes = try unbase64(scratch, options.bytes);
            var command = record(c.ot_session_control_options);
            command.kind = options.kind;
            command.argument = options.argument;
            try status(checked.ot_session_control(try wrapper(), &handle, &command, bytes.ptr, @intCast(bytes.len)));
        },
        .session_split_control => |options| {
            if (options.arguments.len > 6) return error.InvalidOptions;
            const handle = checked.handleToC(try options.session.native());
            var command = record(c.ot_split_control);
            command.command = options.command;
            @memcpy(command.arguments[0..options.arguments.len], options.arguments);
            var result: u32 = 0;
            try status(upstream.output_checked.ot_session_split_control(try wrapper(), &handle, &command, &result));
            return json(result, writer);
        },
        .session_sync_detached => |options| {
            const handle = checked.handleToC(try options.session.native());
            const parent = checked.handleToC(try options.parent.native());
            try status(upstream.output_checked.ot_session_sync_detached(try wrapper(), &handle, &parent));
        },
        .session_resize => |options| try (try context()).resizeSessionRenderer(try options.session.native(), options.width, options.height),
        .session_image_resolution => |options| try (try context()).sessionSetImageResolution(try options.session.native(), options.terminal_width, options.terminal_height, options.pixel_width, options.pixel_height),
        .session_kitty_transport => |options| try (try context()).sessionSetKittyImageTransport(try options.session.native(), options.mode),
        .session_palette => |options| {
            const handle = checked.handleToC(try options.session.native());
            try status(checked.ot_session_set_palette_state(try wrapper(), &handle, options.palette.ptr, @intCast(options.palette.len), &options.foreground, &options.background, options.epoch));
        },
        .session_update_stats => |options| try (try context()).sessionUpdateStats(try options.session.native(), options.overall_ms, options.fps, options.callback_ms),
        .session_write => |options| try (try context()).writeSession(try options.session.native(), try unbase64(scratch, options.bytes)),
        .session_debug_overlay => |options| try (try context()).sessionSetDebugOverlay(try options.session.native(), options.enabled, options.corner),
        .session_memory_stats => |options| try (try context()).sessionUpdateMemoryStats(try options.session.native(), options.heap_used, options.heap_total, options.array_buffers),
        .session_dump_hit_grid => |options| try (try context()).sessionDumpHitGrid(try options.session.native()),
        .session_link_id => |options| return json(try (try context()).sessionGetLinkId(try options.session.native(), options.x, options.y), writer),
        .session_setup_terminal => |options| try (try context()).setupSessionTerminal(try options.session.native(), options.options),
        .session_suspend => |options| try (try context()).suspendSession(try options.session.native()),
        .session_resume => |options| try (try context()).resumeSession(try options.session.native()),
        .session_terminal_state => |options| {
            const state = try (try context()).getSessionTerminalState(try options.session.native());
            return json(@intFromEnum(state.phase), writer);
        },
        .session_clipboard => |options| {
            const handle = checked.handleToC(try options.session.native());
            const bytes = try unbase64(scratch, options.bytes);
            var written: u32 = 0;
            try status(checked.ot_session_clipboard(try wrapper(), &handle, options.target, bytes.ptr, @intCast(bytes.len), &written));
            return json(written != 0, writer);
        },
        .session_notification => |options| {
            const handle = checked.handleToC(try options.session.native());
            var written: u32 = 0;
            try status(checked.ot_session_notification(try wrapper(), &handle, options.message.ptr, @intCast(options.message.len), options.title.ptr, @intCast(options.title.len), &written));
            return json(written != 0, writer);
        },
        .session_kitty_status => |options| return json(try (try context()).sessionKittyImageTransportStatus(try options.session.native()), writer),
        .session_kitty_poll => |options| return json(try (try context()).sessionPollKittyImageTransport(try options.session.native(), try number(options.now_ns)), writer),
        .session_kitty_cancel => |options| try (try context()).sessionCancelKittyImageTransport(try options.session.native(), options.failed),
        .session_kitty_reply => |options| return json(try (try context()).sessionProcessKittyImageReply(try options.session.native(), try unbase64(scratch, options.bytes)), writer),
        .session_kitty_probe => |options| try (try context()).sessionStartKittyFileProbe(try options.session.native()),
        .session_buffer_lease => |options| {
            const core = try context();
            const which: upstream.context.RendererBuffer = switch (options.which) {
                0 => .current,
                1 => .next,
                else => return error.InvalidOptions,
            };
            const handle = if (options.frame) |frame| try core.sceneFrameAcquireBufferLease(try options.session.native(), try frame.native(), which) else try core.acquireSessionBufferLease(try options.session.native(), which);
            return leaseInfo(core, scratch, handle, writer);
        },
        .lease_validate => |options| {
            _ = try (try context()).bufferLeaseSnapshot(try options.lease.native());
        },
        .lease_release => |options| try (try context()).releaseBufferLease(try options.lease.native()),
        .lease_resolved => |options| {
            const snapshot = try (try context()).bufferLeaseSnapshot(try options.lease.native());
            const size = try snapshot.getRealCharSize(options.add_line_breaks);
            if (size > 4 * 1024 * 1024) return error.ObjectLimit;
            const bytes = try scratch.alloc(u8, size);
            const lengths = if (options.include_lengths) try scratch.alloc(u8, @as(usize, snapshot.width) * snapshot.height) else null;
            const written = if (lengths) |cells| try snapshot.writeResolvedCells(bytes, options.add_line_breaks, cells) else try snapshot.writeResolvedChars(bytes, options.add_line_breaks);
            return json(.{ .bytes = try base64(scratch, bytes[0..written]), .cell_lengths = if (lengths) |cells| try base64(scratch, cells) else null }, writer);
        },
        .scene_create => |options| {
            if (options.kind > 8) return error.UnsupportedResource;
            return json(try wireHandle(scratch, try (try context()).sceneCreateNode(try options.session.native(), options.kind, options.num)), writer);
        },
        .scene_destroy => |options| try (try context()).sceneDestroyNode(try options.node.native()),
        .scene_move => |options| try (try context()).sceneMoveNode(try options.node.native(), if (options.parent) |parent| try parent.native() else null, options.index),
        .scene_focus => |options| try (try context()).sceneSetFocus(try options.node.native(), options.focused),
        .scene_viewport => |options| try (try context()).sceneSetViewport(try options.node.native(), if (options.viewport) |viewport| try viewport.native() else null),
        .scene_surface => |options| try (try context()).sceneSetSurface(try options.node.native(), if (options.buffer) |buffer| try buffer.native() else null),
        .scene_layout => |options| return json(try (try context()).sceneGetLayout(try options.node.native(), options.raw_yoga), writer),
        .scene_measure_layout => |options| try (try context()).sceneMeasureLayout(try options.session.native(), try options.root.native()),
        .scene_style => |options| {
            const value = try (try context()).sceneGetStyle(try options.node.native(), options.group, options.kind, options.edge);
            return json(.{ .unit = value.unit, .value_bits = @as(u32, @bitCast(value.value)) }, writer);
        },
        .scene_mark_dirty => |options| try (try context()).sceneMarkDirty(try options.node.native()),
        .scene_measure => |options| try (try context()).sceneSetMeasure(try options.node.native(), if (options.enabled) @ptrCast(&scene_measure) else null),
        .scene_hooks => |options| try (try context()).sceneSetHooks(try options.node.native(), options.flags, try number(options.generation), options.initial_width, options.initial_height),
        .scene_has_measure => |options| return json(try (try context()).sceneHasMeasure(try options.node.native()), writer),
        .scene_box => |options| try (try context()).sceneSetBoxDetails(try options.node.native(), options.options),
        .scene_slider => |options| try (try context()).sceneSetSlider(try options.node.native(), options.options),
        .scene_slider_thumb => |options| return json(try (try context()).sceneGetSliderThumb(try options.node.native()), writer),
        .scene_arrow => |options| try (try context()).sceneSetArrow(try options.node.native(), options.options),
        .scene_text => |options| try (try context()).sceneSetText(try options.node.native(), options.text),
        .scene_styled_text => |options| {
            const handle = checked.handleToC(try options.node.native());
            const bytes = try unbase64(scratch, options.bytes);
            const records = try recordArray(c.ot_styled_text_chunk, scratch, options.records, options.count);
            const urls = try unbase64(scratch, options.url_bytes);
            try status(checked.ot_scene_set_styled_text(try wrapper(), &handle, bytes.ptr, @intCast(bytes.len), records.ptr, options.count, urls.ptr, @intCast(urls.len)));
        },
        .scene_get_text => |options| {
            const core = try context();
            const handle = try options.node.native();
            const info = try core.sceneGetTextInfo(handle);
            if (info.byte_count > 4 * 1024 * 1024) return error.ObjectLimit;
            const bytes = try scratch.alloc(u8, info.byte_count);
            const count = try core.sceneGetText(handle, bytes);
            return json(try base64(scratch, bytes[0..count]), writer);
        },
        .scene_editor_view => |options| try (try context()).sceneSetEditorView(try options.node.native(), if (options.view) |view| try view.native() else null),
        .scene_editor_options => |options| try (try context()).sceneSetEditorOptions(try options.node.native(), options.options),
        .scene_text_options => |options| try (try context()).sceneSetTextOptions(try options.node.native(), options.options),
        .scene_text_info => |options| return json(try (try context()).sceneGetTextInfo(try options.node.native()), writer),
        .scene_text_lines => |options| {
            if (options.count > 65536) return error.ObjectLimit;
            const lines = try scratch.alloc(scene.TextLine, options.count);
            const total = try (try context()).sceneGetTextLines(try options.node.native(), options.first_line, lines);
            return json(lines[0..@min(options.count, total - @min(options.first_line, total))], writer);
        },
        .scene_selection => |options| return json(try (try context()).sceneSetTextSelection(try options.node.native(), options.options), writer),
        .scene_selection_state => |options| return json(try decimal(scratch, try (try context()).sceneGetTextSelection(try options.node.native())), writer),
        .scene_flush => |options| {
            const bytes = try unbase64(scratch, options.bytes);
            var applied: u32 = 0;
            const result = checked.ot_scene_flush(try wrapper(), bytes.ptr, @intCast(bytes.len), &applied);
            return json(.{ .status = result, .applied = applied }, writer);
        },
        .frame_step => |options| {
            const core = try context();
            const bytes = if (options.recording) |encoded| try unbase64(scratch, encoded) else null;
            // The checked C ABI treats an absent RECORD reply as an empty
            // recording, and a zero-length recording elsewhere as no payload.
            const recording: ?[]const u8 = if (options.previous != null and options.previous.?.kind == c.OT_SCENE_FRAME_RECORD)
                bytes orelse &.{}
            else if (bytes) |payload|
                if (payload.len != 0) return error.InvalidOptions else null
            else
                null;
            const frame = try core.sceneFrameStepWithRecording(try options.session.native(), if (options.previous) |previous| try previous.native() else null, options.options, options.max_work, recording);
            var wire = try wireFrame(scratch, frame);
            if (frame.kind != c.OT_SCENE_FRAME_DONE and frame.kind != c.OT_SCENE_FRAME_YIELD and frame.kind != c.OT_SCENE_FRAME_RECORD) {
                var geometry: Geometry = .{};
                if (core.sceneGetPaintLayout(frame.node)) |layout| {
                    geometry.paint = layout;
                    geometry.flags |= c.OT_SCENE_GEOMETRY_PAINT;
                } else |_| {}
                if (core.sceneGetLayout(frame.node, false)) |layout| {
                    geometry.public_layout = layout;
                    geometry.flags |= c.OT_SCENE_GEOMETRY_PUBLIC;
                } else |_| {}
                wire.geometry = geometry;
            }
            return json(wire, writer);
        },
        .frame_commit => |options| return json(@intFromEnum(try (try context()).sceneFrameCommit(try options.session.native(), try options.frame.native(), options.force)), writer),
        .frame_cancel => |options| try (try context()).sceneFrameCancel(try options.session.native(), try number(options.frame_id)),
        .frame_copy_buffer => |options| {
            const handle = checked.handleToC(try options.session.native());
            const target = checked.handleToC(try options.target.native());
            const frame = checked.frameRequestToC(try options.frame.native());
            try status(upstream.output_checked.ot_scene_frame_copy_buffer(try wrapper(), &handle, &frame, &target));
        },
        .frame_paint_slots => |options| {
            const native = try (try context()).sceneFramePaintSlots(try options.session.native(), try options.frame.native());
            const slots = try scratch.alloc(WirePaintSlot, native.len);
            for (native, slots) |slot, *wire| wire.* = .{ .node = try wireHandle(scratch, slot.node), .hook_generation = try decimal(scratch, slot.hook_generation), .num = slot.num, .hooks = slot.hooks, .clip = slot.clip, .opacity = slot.opacity, .paint_layout = slot.layout, .public_layout = slot.public_layout };
            return json(slots, writer);
        },
        .session_render_split => |options| {
            if (options.snapshots.len > session.split_snapshots_max) return error.InvalidOptions;
            const handle = checked.handleToC(try options.session.native());
            const frame = if (options.frame) |frame| checked.frameRequestToC(try frame.native()) else null;
            const snapshots = try scratch.alloc(c.ot_split_snapshot, options.snapshots.len);
            for (options.snapshots, snapshots) |wire, *snapshot| snapshot.* = .{ .buffer = checked.handleToC(try wire.buffer.native()), .row_columns = wire.row_columns, .flags = @as(u32, @intFromBool(wire.start_on_new_line)) | (@as(u32, @intFromBool(wire.trailing_newline)) << 1) };
            var result: u32 = 0;
            try status(upstream.output_checked.ot_session_render_split(try wrapper(), &handle, if (frame) |*value| value else null, snapshots.ptr, @intCast(snapshots.len), options.pinned_render_offset, @intFromBool(options.force), &result));
            return json(result, writer);
        },
        .buffer_create => |options| return json(try wireHandle(scratch, try (try context()).createBuffer(options.width, options.height, .{ .respect_alpha = options.respect_alpha, .width_method = try checked.widthMethodFromC(options.width_method) })), writer),
        .buffer_resize => |options| try (try context()).resizeBuffer(try options.buffer.native(), options.width, options.height),
        .buffer_lease => |options| {
            const core = try context();
            return leaseInfo(core, scratch, try core.acquireOwnedBufferLease(try options.buffer.native()), writer);
        },
        .buffer_draw => |options| {
            const target = checked.handleToC(try options.target.native());
            const frame = if (options.frame) |frame| checked.frameRequestToC(try frame.native()) else null;
            const source = if (options.source) |source| checked.handleToC(try source.native()) else null;
            const encoded = try unbase64(scratch, options.record);
            if (encoded.len < @sizeOf(c.ot_buffer_draw_header) or encoded.len > 4096) return error.InvalidOptions;
            const aligned = try scratch.alloc(u64, std.math.divCeil(usize, encoded.len, @sizeOf(u64)) catch unreachable);
            const storage = std.mem.sliceAsBytes(aligned);
            @memset(storage, 0);
            @memcpy(storage[0..encoded.len], encoded);
            const header: *const c.ot_buffer_draw_header = @ptrCast(aligned.ptr);
            if (header.struct_size != encoded.len) return error.InvalidOptions;
            const text = try unbase64(scratch, options.text);
            const bottom = try unbase64(scratch, options.bottom);
            try status(checked.ot_buffer_draw(try wrapper(), &target, if (frame) |*value| value else null, header, if (source) |*value| value else null, text.ptr, @intCast(text.len), bottom.ptr, @intCast(bottom.len)));
        },
        .buffer_stack => |options| {
            const target = checked.handleToC(try options.target.native());
            const frame = if (options.frame) |frame| checked.frameRequestToC(try frame.native()) else null;
            var opacity: f32 = 0;
            try status(checked.ot_buffer_stack(try wrapper(), &target, if (frame) |*value| value else null, options.operation, options.x, options.y, options.width, options.height, &options.opacity, &opacity));
            return json(opacity, writer);
        },
        .buffer_grid => |options| try (try context()).drawGrid(try options.target.native(), if (options.frame) |frame| try frame.native() else null, options.options, options.columns, options.rows),
        .buffer_packed => |options| try (try context()).drawPackedBuffer(try options.target.native(), if (options.frame) |frame| try frame.native() else null, try unbase64(scratch, options.bytes), options.x, options.y, options.width, options.height),
        .buffer_supersample => |options| try (try context()).drawSuperSampleBuffer(try options.target.native(), if (options.frame) |frame| try frame.native() else null, try unbase64(scratch, options.bytes), options.x, options.y, options.format, options.stride),
        .buffer_grayscale => |options| {
            const bytes = try unbase64(scratch, options.bytes);
            if (bytes.len % @sizeOf(f32) != 0) return error.InvalidOptions;
            try (try context()).drawGrayscaleBuffer(try options.target.native(), if (options.frame) |frame| try frame.native() else null, std.mem.bytesAsSlice(f32, bytes), options.x, options.y, options.width, options.height, options.foreground, options.background, options.supersampled);
        },
        .buffer_color_matrix => |options| {
            const matrix = try unbase64(scratch, options.matrix);
            const mask = if (options.mask) |value| try unbase64(scratch, value) else null;
            if (matrix.len % @sizeOf(f32) != 0 or (mask != null and mask.?.len % @sizeOf(f32) != 0)) return error.InvalidOptions;
            try (try context()).colorMatrixBuffer(try options.target.native(), if (options.frame) |frame| try frame.native() else null, std.mem.bytesAsSlice(f32, matrix), if (mask) |value| std.mem.bytesAsSlice(f32, value) else null, options.strength, options.channel);
        },
        .buffer_draw_editor => |options| {
            const target = checked.handleToC(try options.target.native());
            const frame = if (options.frame) |frame| checked.frameRequestToC(try frame.native()) else null;
            const source = checked.handleToC(try options.source.native());
            try status(checked.ot_buffer_draw_editor_view(try wrapper(), &target, if (frame) |*value| value else null, &source, options.x, options.y));
        },
        .buffer_draw_scene_text => |options| {
            const target = checked.handleToC(try options.target.native());
            const frame = if (options.frame) |frame| checked.frameRequestToC(try frame.native()) else null;
            const source = checked.handleToC(try options.source.native());
            try status(checked.ot_buffer_draw_scene_text(try wrapper(), &target, if (frame) |*value| value else null, &source, options.x, options.y));
        },
        .scene_stats => |options| return json(try (try context()).sceneGetStats(try options.session.native()), writer),
        .scene_cursor => |options| return json(try (try context()).sceneGetCursorState(try options.session.native()), writer),
        .scene_hit_test => |options| return json(try (try context()).sceneHitTest(try options.session.native(), options.x, options.y), writer),
        .object_destroy => |options| try (try context()).destroy(try options.handle.native()),
        .edit_create => |options| return json(try wireHandle(scratch, try (try context()).createEditBuffer(try checked.widthMethodFromC(options.width_method))), writer),
        .editor_create => |options| return json(try wireHandle(scratch, try (try context()).createEditorView(try options.edit.native(), options.width, options.height)), writer),
        .edit_set_text => |options| try (try context()).editSetText(try options.edit.native(), try unbase64(scratch, options.bytes), options.preserve_history),
        .edit_insert_text => |options| try (try context()).editInsertText(try options.edit.native(), try unbase64(scratch, options.bytes)),
        .edit_get_text => |options| return json(try readText(scratch, checked.ot_edit_buffer_get_text, options.edit), writer),
        .edit_info => |options| {
            const handle = checked.handleToC(try options.edit.native());
            var info = record(c.ot_edit_buffer_info);
            try status(checked.ot_edit_buffer_get_info(try wrapper(), &handle, &info));
            return json(.{ .content_epoch = try decimal(scratch, info.content_epoch), .byte_count = info.byte_count, .line_count = info.line_count, .cursor_row = info.cursor_row, .cursor_col = info.cursor_col, .cursor_offset = info.cursor_offset, .can_undo = info.can_undo, .can_redo = info.can_redo, .tab_width = info.tab_width }, writer);
        },
        .edit_set_cursor => |options| try (try context()).editSetCursor(try options.edit.native(), options.row, options.col),
        .edit_delete_range => |options| {
            const handle = checked.handleToC(try options.edit.native());
            try status(checked.ot_edit_buffer_delete_range(try wrapper(), &handle, options.start_row, options.start_col, options.end_row, options.end_col));
        },
        .edit_command => |options| {
            const handle = checked.handleToC(try options.edit.native());
            try status(editor_checked.ot_edit_buffer_command(try wrapper(), &handle, options.command, options.argument));
        },
        .edit_history => |options| return json(try base64(scratch, try (try context()).editHistory(try options.edit.native(), options.redo)), writer),
        .edit_position => |options| {
            const handle = checked.handleToC(try options.edit.native());
            var position = record(c.ot_edit_position);
            try status(editor_checked.ot_edit_buffer_get_position(try wrapper(), &handle, options.query, options.a, options.b, &position));
            return json(position, writer);
        },
        .edit_range => |options| {
            const handle = checked.handleToC(try options.edit.native());
            var count: u32 = 0;
            try status(editor_checked.ot_edit_buffer_get_range(try wrapper(), &handle, @intFromBool(options.by_coords), options.start_row, options.start_col, options.end_row, options.end_col, null, 0, &count));
            if (count > 4 * 1024 * 1024) return error.ObjectLimit;
            const bytes = try scratch.alloc(u8, count);
            try status(editor_checked.ot_edit_buffer_get_range(try wrapper(), &handle, @intFromBool(options.by_coords), options.start_row, options.start_col, options.end_row, options.end_col, bytes.ptr, count, &count));
            return json(try base64(scratch, bytes[0..count]), writer);
        },
        .edit_measure_text => |options| return json(try (try context()).editMeasureText(try options.edit.native(), try unbase64(scratch, options.bytes)), writer),
        .edit_measure => |options| {
            const bytes = try unbase64(scratch, options.bytes);
            var width: u32 = 0;
            try status(editor_checked.ot_edit_measure_text(try wrapper(), bytes.ptr, @intCast(bytes.len), options.width_method, options.tab_width, &width));
            return json(width, writer);
        },
        .edit_defaults => |options| {
            const handle = checked.handleToC(try options.edit.native());
            const style = try recordArray(c.ot_editor_style, scratch, options.record, 1);
            try status(editor_checked.ot_edit_buffer_set_defaults(try wrapper(), &handle, options.mask, &style[0]));
        },
        .edit_tab_width => |options| {
            const handle = checked.handleToC(try options.edit.native());
            try status(editor_checked.ot_edit_buffer_set_tab_width(try wrapper(), &handle, options.width));
        },
        .edit_set_style => |options| try (try context()).editSetSyntaxStyle(try options.edit.native(), if (options.style) |style| try style.native() else null),
        .edit_highlight => |options| {
            const handle = checked.handleToC(try options.edit.native());
            const highlight = if (options.record) |encoded| &(try recordArray(c.ot_edit_highlight, scratch, encoded, 1))[0] else null;
            try status(editor_checked.ot_edit_buffer_highlight(try wrapper(), &handle, options.operation, options.argument, highlight));
        },
        .edit_highlights => |options| {
            const handle = checked.handleToC(try options.edit.native());
            var count: u32 = 0;
            try status(editor_checked.ot_edit_buffer_get_highlights(try wrapper(), &handle, options.line, null, 0, &count));
            if (count > 65536) return error.ObjectLimit;
            const values = try scratch.alloc(c.ot_edit_highlight, count);
            try status(editor_checked.ot_edit_buffer_get_highlights(try wrapper(), &handle, options.line, values.ptr, count, &count));
            return json(values[0..count], writer);
        },
        .edit_event_enable => try (try context()).setEditEventCallback(receiveEditEvent, null),
        .edit_events => {
            _ = try context();
            if (edit_notifications_overflow) return error.EditEventOverflow;
            const Event = struct { context: []const u8, slot: u32, generation: u32, event: u32 };
            const events = try scratch.alloc(Event, edit_notifications_count);
            for (events, edit_notifications[0..edit_notifications_count]) |*event, native| event.* = .{ .context = try decimal(scratch, native.handle.context_id), .slot = native.handle.slot, .generation = native.handle.generation, .event = @intFromEnum(native.event) };
            try json(events, writer);
            edit_notifications_count = 0;
            return;
        },
        .editor_viewport => |options| {
            const handle = checked.handleToC(try options.view.native());
            var viewport = record(c.ot_editor_viewport);
            try status(editor_checked.ot_editor_view_get_viewport(try wrapper(), &handle, &viewport));
            return json(viewport, writer);
        },
        .editor_set_viewport => |options| {
            const handle = checked.handleToC(try options.view.native());
            var viewport = record(c.ot_editor_viewport);
            viewport.x = options.viewport.x;
            viewport.y = options.viewport.y;
            viewport.width = options.viewport.width;
            viewport.height = options.viewport.height;
            try status(editor_checked.ot_editor_view_set_viewport(try wrapper(), &handle, &viewport, @intFromBool(options.size_only), @intFromBool(options.move_cursor)));
        },
        .editor_scroll_margin => |options| try (try context()).editorSetScrollMargin(try options.view.native(), options.margin),
        .editor_command => |options| {
            const handle = checked.handleToC(try options.view.native());
            try status(editor_checked.ot_editor_view_command(try wrapper(), &handle, options.command, options.argument));
        },
        .editor_tab_color => |options| try (try context()).editorSetTabColor(try options.view.native(), options.color),
        .editor_select => |options| {
            const handle = checked.handleToC(try options.view.native());
            const selection = try recordArray(c.ot_editor_selection, scratch, options.record, 1);
            var changed: u32 = 0;
            try status(editor_checked.ot_editor_view_select(try wrapper(), &handle, &selection[0], &changed));
            return json(changed != 0, writer);
        },
        .editor_info => |options| {
            const handle = checked.handleToC(try options.view.native());
            var info = record(c.ot_editor_view_info);
            try status(editor_checked.ot_editor_view_get_info(try wrapper(), &handle, @intFromBool(options.follow_cursor), &info));
            return json(info, writer);
        },
        .editor_selection => |options| {
            const handle = checked.handleToC(try options.view.native());
            var info = record(c.ot_editor_view_info);
            try status(editor_checked.ot_editor_view_get_selection(try wrapper(), &handle, &info));
            return json(info, writer);
        },
        .editor_selected_text => |options| return json(try readText(scratch, editor_checked.ot_editor_view_get_selected_text, options.view), writer),
        .editor_position => |options| {
            const handle = checked.handleToC(try options.view.native());
            var position = record(c.ot_editor_position);
            try status(editor_checked.ot_editor_view_get_position(try wrapper(), &handle, options.query, &position));
            return json(position, writer);
        },
        .editor_lines => |options| {
            const handle = checked.handleToC(try options.view.native());
            var info = record(c.ot_editor_measure);
            try status(editor_checked.ot_editor_view_get_lines(try wrapper(), &handle, @intFromBool(options.logical), null, 0, &info));
            if (info.line_count > 65536) return error.ObjectLimit;
            const lines = try scratch.alloc(c.ot_scene_text_line, info.line_count);
            try status(editor_checked.ot_editor_view_get_lines(try wrapper(), &handle, @intFromBool(options.logical), lines.ptr, @intCast(lines.len), &info));
            return json(.{ .lines = lines, .line_count = info.line_count, .width_cols_max = info.width_cols_max }, writer);
        },
        .editor_measure => |options| {
            const handle = checked.handleToC(try options.view.native());
            var info = record(c.ot_editor_measure);
            try status(editor_checked.ot_editor_view_measure(try wrapper(), &handle, options.width, options.height, &info));
            return json(info, writer);
        },
        .editor_replace_selection => |options| return json(try (try context()).editorReplaceSelection(try options.view.native(), try unbase64(scratch, options.bytes)), writer),
        .editor_placeholder => |options| {
            const handle = checked.handleToC(try options.view.native());
            const bytes = try unbase64(scratch, options.bytes);
            const chunks = try recordArray(c.ot_styled_text_chunk, scratch, options.records, options.count);
            try status(editor_checked.ot_editor_view_set_placeholder(try wrapper(), &handle, bytes.ptr, @intCast(bytes.len), chunks.ptr, options.count));
        },
        .syntax_create => return json(try wireHandle(scratch, try (try context()).createSyntaxStyle()), writer),
        .syntax_register => |options| {
            const handle = checked.handleToC(try options.style.native());
            const style = try recordArray(c.ot_editor_style, scratch, options.record, 1);
            var id: u32 = 0;
            try status(editor_checked.ot_syntax_style_register(try wrapper(), &handle, options.name.ptr, @intCast(options.name.len), &style[0], &id));
            return json(id, writer);
        },
        .syntax_resolve => |options| {
            const handle = checked.handleToC(try options.style.native());
            var id: u32 = 0;
            try status(editor_checked.ot_syntax_style_resolve(try wrapper(), &handle, options.name.ptr, @intCast(options.name.len), &id));
            return json(id, writer);
        },
        .syntax_count => |options| {
            const handle = checked.handleToC(try options.style.native());
            var count: u32 = 0;
            try status(editor_checked.ot_syntax_style_get_count(try wrapper(), &handle, &count));
            return json(count, writer);
        },
        .text => |options| return factory_text.call(try wrapper(), scratch, options, writer),
        .diagnostics => {
            const records = try scratch.alloc(c.ot_diagnostic, 64);
            var drain = record(c.ot_diagnostic_drain);
            try status(checked.ot_context_drain_diagnostics(try wrapper(), records.ptr, @intCast(records.len), &drain));
            const Message = struct { level: u32, flags: u32, message: []const u8 };
            const messages = try scratch.alloc(Message, drain.count);
            for (messages, records[0..drain.count]) |*message, *source| message.* = .{ .level = source.level, .flags = source.flags, .message = source.message[0..source.message_len] };
            return json(.{ .records = messages, .remaining = drain.remaining, .dropped = drain.dropped }, writer);
        },
    }
    try writer.writeAll("null");
}

fn wrapper() !*checked.ContextHandle {
    return owner orelse error.ContextNotCreated;
}
fn leaseInfo(core: *Context, scratch: std.mem.Allocator, handle: Handle, writer: *std.Io.Writer) !void {
    errdefer core.releaseBufferLease(handle) catch unreachable;
    const snapshot = try core.bufferLeaseSnapshot(handle);
    try json(.{ .handle = try wireHandle(scratch, handle), .width = snapshot.width, .height = snapshot.height, .generation = try decimal(scratch, snapshot.generation), .char = @intFromPtr(snapshot.buffer.char.ptr), .fg = @intFromPtr(snapshot.buffer.fg.ptr), .bg = @intFromPtr(snapshot.buffer.bg.ptr), .attributes = @intFromPtr(snapshot.buffer.attributes.ptr) }, writer);
}
fn receiveEditEvent(_: ?*anyopaque, handle: Handle, event: upstream.context.EditEvent) void {
    if (edit_notifications_count == edit_notifications.len) {
        edit_notifications_overflow = true;
        return;
    }
    edit_notifications[edit_notifications_count] = .{ .handle = handle, .event = event };
    edit_notifications_count += 1;
}
fn readText(scratch: std.mem.Allocator, comptime operation: anytype, wire: WireHandle) ![]const u8 {
    const handle = checked.handleToC(try wire.native());
    var count: u32 = 0;
    try status(operation(try wrapper(), &handle, null, 0, &count));
    if (count > 4 * 1024 * 1024) return error.ObjectLimit;
    const bytes = try scratch.alloc(u8, count);
    try status(operation(try wrapper(), &handle, bytes.ptr, count, &count));
    if (count > bytes.len) return error.InvalidOptions;
    return base64(scratch, bytes[0..count]);
}
fn context() !*Context {
    return (try wrapper()).core;
}
fn number(value: []const u8) !u64 {
    return std.fmt.parseInt(u64, value, 10);
}
fn decimal(scratch: std.mem.Allocator, value: u64) ![]const u8 {
    return std.fmt.allocPrint(scratch, "{d}", .{value});
}
fn json(value: anytype, writer: *std.Io.Writer) !void {
    return std.json.Stringify.value(value, .{}, writer);
}
fn wireHandle(scratch: std.mem.Allocator, value: Handle) !WireHandle {
    return .{ .context = try decimal(scratch, value.context_id), .slot = value.slot, .generation = value.generation };
}
fn wireFrame(scratch: std.mem.Allocator, value: scene.FrameRequest) !WireFrame {
    return .{ .session = try wireHandle(scratch, value.session), .root = try wireHandle(scratch, value.root), .node = try wireHandle(scratch, value.node), .frame_id = try decimal(scratch, value.frame_id), .request_id = try decimal(scratch, value.request_id), .layout_epoch = try decimal(scratch, value.layout_epoch), .hook_generation = try decimal(scratch, value.hook_generation), .kind = value.kind, .num = value.num, .width = value.width, .height = value.height };
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
fn unbase64(scratch: std.mem.Allocator, value: []const u8) ![]u8 {
    // Checked scene records carry u64 fields and require an eight-byte base.
    // JSON parsing can leave the arena cursor at any byte offset.
    const bytes = try scratch.alignedAlloc(u8, .@"8", try std.base64.standard.Decoder.calcSizeForSlice(value));
    try std.base64.standard.Decoder.decode(bytes, value);
    return bytes;
}
fn recordArray(comptime T: type, scratch: std.mem.Allocator, encoded: []const u8, count: u32) ![]T {
    const size = std.math.mul(usize, @sizeOf(T), count) catch return error.InvalidOptions;
    const bytes = try unbase64(scratch, encoded);
    if (bytes.len != size) return error.InvalidOptions;
    const values = try scratch.alloc(T, count);
    @memcpy(std.mem.sliceAsBytes(values), bytes);
    return values;
}
fn base64(scratch: std.mem.Allocator, value: []const u8) ![]const u8 {
    const bytes = try scratch.alloc(u8, std.base64.standard.Encoder.calcSize(value.len));
    return std.base64.standard.Encoder.encode(bytes, value);
}
