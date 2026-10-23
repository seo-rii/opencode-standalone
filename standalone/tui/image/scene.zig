const std = @import("std");
const upstream = @import("opentui");
const checked = upstream.checked;
const c = upstream.abi;

pub fn Scene(comptime Wire: type) type {
    return struct { node: Wire, image: ?Wire, fit: u32, protocol: u32, buffer: ?Wire };
}
pub fn Draw(comptime Wire: type) type {
    return struct { target: Wire, image: Wire, frame: ?Frame(Wire), record: []const u8 };
}
fn Frame(comptime Wire: type) type {
    return struct {
        session: Wire,
        root: Wire,
        node: Wire,
        frame_id: []const u8,
        request_id: []const u8,
        layout_epoch: []const u8,
        hook_generation: []const u8,
        kind: u32,
        num: u32,
        width: u32,
        height: u32,
        geometry: ?std.json.Value = null,
        fn native(self: @This()) !c.ot_scene_frame_request {
            var output = std.mem.zeroes(c.ot_scene_frame_request);
            output.struct_size = @sizeOf(c.ot_scene_frame_request);
            output.abi_version = c.OT_CONTEXT_ABI_VERSION;
            output.session = try self.session.native();
            output.root = try self.root.native();
            output.node = try self.node.native();
            output.frame_id = try std.fmt.parseInt(u64, self.frame_id, 10);
            output.request_id = try std.fmt.parseInt(u64, self.request_id, 10);
            output.layout_epoch = try std.fmt.parseInt(u64, self.layout_epoch, 10);
            output.hook_generation = try std.fmt.parseInt(u64, self.hook_generation, 10);
            output.kind = self.kind;
            output.num = self.num;
            output.width = self.width;
            output.height = self.height;
            return output;
        }
    };
}

pub fn set(owner: *checked.ContextHandle, options: anytype) !i32 {
    const node = try options.node.native();
    const image = if (options.image) |handle| try handle.native() else null;
    const buffer = if (options.buffer) |handle| try handle.native() else null;
    return checked.ot_scene_set_image(owner, &node, if (image) |*handle| handle else null, options.fit, options.protocol, if (buffer) |*handle| handle else null);
}

pub fn draw(owner: *checked.ContextHandle, scratch: std.mem.Allocator, options: anytype) !struct { status: i32, drawn: bool } {
    const target = try options.target.native();
    const image = try options.image.native();
    const frame = if (options.frame) |value| try value.native() else null;
    const bytes = try scratch.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(options.record));
    try std.base64.standard.Decoder.decode(bytes, options.record);
    if (bytes.len != @sizeOf(c.ot_image_draw_options)) return .{ .status = c.OT_INVALID_ARGUMENT, .drawn = false };
    var record: c.ot_image_draw_options = undefined;
    @memcpy(std.mem.asBytes(&record), bytes);
    var drawn: u32 = 0;
    const status = checked.ot_buffer_draw_image(owner, &target, if (frame) |*value| value else null, &image, &record, &drawn);
    return .{ .status = status, .drawn = drawn != 0 };
}
