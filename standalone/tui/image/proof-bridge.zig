const std = @import("std");
const upstream = @import("opentui");
const checked = upstream.checked;
const images = @import("factory_image");
const allocator = if (@import("builtin").cpu.arch == .wasm32) std.heap.wasm_allocator else std.heap.page_allocator;
pub const io = std.Io.failing;
var owners: [8]?*checked.ContextHandle = @splat(null);
var input: [1024 * 1024]u8 = undefined;
var output: [8 * 1024 * 1024]u8 = undefined;
var output_length: u32 = 0;

const Request = union(enum) {
    context_create: struct { object_capacity: u32 = 128 },
    context_destroy: struct { context: u32 },
    image: struct { context: u32, operation: images.Request },
    clone: struct { context: u32, source: u32, image: images.WireHandle },
};

export fn imageInputPointer() [*]u8 { return &input; }
export fn imageInputCapacity() u32 { return input.len; }
export fn imageOutputPointer() [*]const u8 { return &output; }
export fn imageOutputLength() u32 { return output_length; }
export fn imageCall(length: u32) u32 {
    var writer: std.Io.Writer = .fixed(&output);
    images.native_status = 0;
    call(length, &writer) catch |err| {
        writer.end = 0;
        std.json.Stringify.value(.{ .err = @errorName(err), .native_status = images.native_status }, .{}, &writer) catch unreachable;
        output_length = @intCast(writer.end);
        return 1;
    };
    output_length = @intCast(writer.end);
    return 0;
}

fn call(length: u32, writer: *std.Io.Writer) !void {
    if (length > input.len) return error.InputTooLarge;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const scratch = arena.allocator();
    const parsed = try std.json.parseFromSlice(Request, scratch, input[0..length], .{});
    defer parsed.deinit();
    switch (parsed.value) {
        .context_create => |options| {
            if (options.object_capacity == 0 or options.object_capacity > 4096) return error.ObjectLimit;
            for (&owners, 0..) |*slot, index| {
                if (slot.* != null) continue;
                const core = try upstream.context.Context.init(allocator, io, .{ .object_capacity = options.object_capacity, .render_cells_max = 1 });
                errdefer core.deinit() catch unreachable;
                const owner = try allocator.create(checked.ContextHandle);
                owner.* = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = core, .owner_thread = 0 };
                slot.* = owner;
                return std.json.Stringify.value(index, .{}, writer);
            }
            return error.ContextLimit;
        },
        .context_destroy => |options| {
            const owner = try context(options.context);
            try owner.core.deinit();
            allocator.destroy(owner);
            owners[options.context] = null;
            try writer.writeAll("null");
        },
        .image => |options| return images.call(try context(options.context), scratch, options.operation, writer),
        .clone => |options| return images.clone(try context(options.context), try context(options.source), scratch, options.image, writer),
    }
}
fn context(index: u32) !*checked.ContextHandle {
    if (index >= owners.len) return error.InvalidContext;
    return owners[index] orelse error.ContextNotCreated;
}
