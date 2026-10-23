const std = @import("std");
const upstream = @import("opentui");
const checked = upstream.checked;
const image = upstream.image_checked;
const scene = @import("image/scene.zig");
const c = upstream.abi;
const root = @import("root");
const binary_enabled = @hasDecl(root, "factory_binary");
// The independent 64MiB codec proof retains its original base64 wire format.
// Only the image-capable factory declares this bounded binary transfer module.
const Bytes = if (binary_enabled) root.factory_binary.Span else []const u8;

pub var native_status: i32 = 0;

pub const WireHandle = struct {
    context: []const u8,
    slot: u32,
    generation: u32,
    pub fn native(self: WireHandle) !c.ot_handle {
        return checked.handleToC(.{ .context_id = try std.fmt.parseInt(u64, self.context, 10), .slot = self.slot, .generation = self.generation });
    }
};
const ImageArg = struct { image: WireHandle };
const Snapshot = struct {
    metadata: c.ot_image_info,
    pixels: Bytes,
    encoded_png: ?Bytes,
    png_color_type: u8,
    iccp_compressed_offset: u32,
    iccp_compressed_len: u32,
    lazy_pixel_len: u32,
};

pub const Request = union(enum) {
    inspect: struct { bytes: Bytes },
    decode: struct { bytes: Bytes },
    create: struct { bytes: Bytes, width: u32, height: u32, stride: u32, format: u32 = 0, alpha: u32 = 0 },
    update: struct { image: WireHandle, bytes: Bytes, stride: u32, format: u32 = 0, alpha: u32 = 0 },
    destroy: ImageArg,
    retain: ImageArg,
    clone: ImageArg,
    snapshot: ImageArg,
    restore: Snapshot,
    info: ImageArg,
    resize: struct { image: WireHandle, width: u32, height: u32, filter: u32 },
    extract: struct { image: WireHandle, left: u32, top: u32, width: u32, height: u32 },
    extend: struct { image: WireHandle, top: u32, right: u32, bottom: u32, left: u32, background: [4]u8 },
    transform: struct { image: WireHandle, operation: u32 },
    composite: struct { base: WireHandle, overlay: WireHandle, left: i32, top: i32, blend: u32, opacity: u8 },
    copy_pixels: struct { image: WireHandle, capacity: u32, stride: u32, format: u32 = 0 },
    png_size: ImageArg,
    copy_png: struct { image: WireHandle, capacity: u32 },
    take_pixels: ImageArg,
    release_pixels: struct { lease: WireHandle },
    icc_retain: struct {},
    icc_release: struct {},
    icc_stats: struct {},
    scene: scene.Scene(WireHandle),
    draw: scene.Draw(WireHandle),
};

// The checked ABI owns every resource, argument check, handle generation and
// error code. The JSON transport only copies bytes and publishes successful out
// parameters; it never manufactures a codec result or ignores a color profile.
pub fn call(owner: *checked.ContextHandle, scratch: std.mem.Allocator, request: Request, writer: *std.Io.Writer) !void {
    switch (request) {
        .inspect => |options| {
            const bytes = try decode(scratch, options.bytes);
            var output: c.ot_image_info = undefined;
            try status(image.ot_image_inspect(owner, bytes.ptr, bytes.len, &output));
            return json(output, writer);
        },
        .decode => |options| {
            const bytes = try decode(scratch, options.bytes);
            var output: c.ot_handle = undefined;
            try status(image.ot_image_decode(owner, bytes.ptr, bytes.len, &output));
            return json(try wire(scratch, output), writer);
        },
        .create => |options| {
            const bytes = try decode(scratch, options.bytes);
            var output: c.ot_handle = undefined;
            try status(image.ot_image_create_pixels(owner, bytes.ptr, bytes.len, options.width, options.height, options.stride, options.format, options.alpha, &output));
            return json(try wire(scratch, output), writer);
        },
        .update => |options| {
            const handle = try options.image.native();
            const bytes = try decode(scratch, options.bytes);
            try status(image.ot_image_update_pixels(owner, &handle, bytes.ptr, bytes.len, options.stride, options.format, options.alpha));
        },
        .destroy => |options| {
            const handle = try options.image.native();
            try status(checked.ot_image_destroy(owner, &handle));
        },
        .retain => |options| {
            const handle = try options.image.native();
            var output: c.ot_handle = undefined;
            try status(image.ot_image_retain(owner, &handle, &output));
            return json(try wire(scratch, output), writer);
        },
        .clone => |options| return clone(owner, owner, scratch, options.image, writer),
        .snapshot => |options| {
            const handle = try options.image.native();
            var info: c.ot_image_info = undefined;
            try status(image.ot_image_get_info(owner, &handle, &info));
            const source = try owner.core.raw().getImage(checked.handleFromC(handle));
            if (!binary_enabled and source.pixels.len + (if (source.encoded_png) |bytes| bytes.len else @as(usize, 0)) > 4 * 1024 * 1024) return error.OutputLimit;
            return json(Snapshot{
                .metadata = info,
                .pixels = try encode(scratch, source.pixels),
                .encoded_png = if (source.encoded_png) |bytes| try encode(scratch, bytes) else null,
                .png_color_type = source.png_color_type,
                .iccp_compressed_offset = @intCast(source.iccp_compressed_offset),
                .iccp_compressed_len = @intCast(source.iccp_compressed_len),
                .lazy_pixel_len = @intCast(source.lazy_pixel_len),
            }, writer);
        },
        .restore => |options| {
            try status(checked.sessionContextStatus(owner));
            const pixels = try decode(scratch, options.pixels);
            const encoded = if (options.encoded_png) |bytes| try decode(scratch, bytes) else null;
            const metadata = options.metadata;
            if (!upstream.image.dimensionsWithinLimits(metadata.width, metadata.height) or
                !upstream.image.dimensionsWithinLimits(metadata.source_width, metadata.source_height) or
                metadata.format < c.OT_IMAGE_FORMAT_PNG or metadata.format > c.OT_IMAGE_FORMAT_GIF or
                metadata.orientation < 1 or metadata.orientation > 8 or metadata.has_alpha > 1 or metadata.color_status > 1)
                return status(c.OT_INVALID_ARGUMENT);
            const expected = @as(u64, metadata.width) * metadata.height * 4;
            if (pixels.len != expected and !(pixels.len == 0 and metadata.format == c.OT_IMAGE_FORMAT_PNG and encoded != null and options.lazy_pixel_len == expected)) return status(c.OT_INVALID_ARGUMENT);
            if (options.lazy_pixel_len != 0 and options.lazy_pixel_len != expected) return status(c.OT_INVALID_ARGUMENT);
            if (@as(u64, options.iccp_compressed_offset) + options.iccp_compressed_len > (if (encoded) |bytes| bytes.len else @as(usize, 0))) return status(c.OT_INVALID_ARGUMENT);
            // A raw image's cached PNG can exceed the decoder's encoded-input
            // limit. Its cross-Context clone must preserve that cache just as
            // Image.cloneOwned does. Lazy PNGs still obey the decode limit.
            if ((!binary_enabled or pixels.len == 0) and (if (encoded) |bytes| bytes.len else @as(usize, 0)) > 64 * 1024 * 1024) return status(c.OT_IMAGE_MEMORY_LIMIT);
            const source: upstream.image.Image = .{
                .allocator = scratch,
                .pixels = pixels,
                .metadata = @bitCast(metadata),
                .encoded_png = encoded,
                .png_color_type = options.png_color_type,
                .iccp_compressed_offset = options.iccp_compressed_offset,
                .iccp_compressed_len = options.iccp_compressed_len,
                .lazy_pixel_len = options.lazy_pixel_len,
            };
            const imported = try owner.core.importImage(&source);
            return json(try wire(scratch, checked.handleToC(imported)), writer);
        },
        .info => |options| {
            const handle = try options.image.native();
            var output: c.ot_image_info = undefined;
            try status(image.ot_image_get_info(owner, &handle, &output));
            return json(output, writer);
        },
        .resize => |options| {
            const handle = try options.image.native();
            var output: c.ot_handle = undefined;
            try status(image.ot_image_resize(owner, &handle, options.width, options.height, options.filter, &output));
            return json(try wire(scratch, output), writer);
        },
        .extract => |options| {
            const handle = try options.image.native();
            var output: c.ot_handle = undefined;
            try status(image.ot_image_extract(owner, &handle, options.left, options.top, options.width, options.height, &output));
            return json(try wire(scratch, output), writer);
        },
        .extend => |options| {
            const handle = try options.image.native();
            var output: c.ot_handle = undefined;
            try status(image.ot_image_extend(owner, &handle, options.top, options.right, options.bottom, options.left, &options.background, &output));
            return json(try wire(scratch, output), writer);
        },
        .transform => |options| {
            const handle = try options.image.native();
            var output: c.ot_handle = undefined;
            try status(image.ot_image_transform(owner, &handle, options.operation, &output));
            return json(try wire(scratch, output), writer);
        },
        .composite => |options| {
            const base = try options.base.native();
            const overlay = try options.overlay.native();
            var output: c.ot_handle = undefined;
            try status(image.ot_image_composite(owner, &base, &overlay, options.left, options.top, options.blend, options.opacity, &output));
            return json(try wire(scratch, output), writer);
        },
        .copy_pixels => |options| {
            const handle = try options.image.native();
            if (comptime binary_enabled) return copyBinaryPixels(owner, handle, options.capacity, options.stride, options.format, writer);
            if (options.capacity > 4 * 1024 * 1024) return error.OutputLimit;
            const bytes = try scratch.alloc(u8, options.capacity);
            @memset(bytes, 0);
            try status(image.ot_image_copy_pixels(owner, &handle, bytes.ptr, bytes.len, options.stride, options.format));
            return json(try encode(scratch, bytes), writer);
        },
        .png_size => |options| {
            const handle = try options.image.native();
            var count: u64 = 0;
            try status(image.ot_image_copy_png(owner, &handle, null, 0, &count));
            return json(count, writer);
        },
        .copy_png => |options| {
            const handle = try options.image.native();
            if (comptime binary_enabled) return copyBinaryPng(owner, scratch, handle, options.capacity, writer);
            if (options.capacity > 4 * 1024 * 1024) return error.OutputLimit;
            const bytes = try scratch.alloc(u8, options.capacity);
            var count: u64 = 0;
            try status(image.ot_image_copy_png(owner, &handle, bytes.ptr, bytes.len, &count));
            if (count > bytes.len) return error.OutputLimit;
            return json(try encode(scratch, bytes[0..@intCast(count)]), writer);
        },
        .take_pixels => |options| {
            const handle = try options.image.native();
            var output: c.ot_image_pixels = undefined;
            try status(image.ot_image_take_pixels(owner, &handle, &output));
            errdefer _ = image.ot_image_pixels_release(owner, &output.lease);
            return json(.{ .lease = try wire(scratch, output.lease), .pixels = output.pixels, .byte_count = output.byte_count }, writer);
        },
        .release_pixels => |options| {
            const handle = try options.lease.native();
            try status(image.ot_image_pixels_release(owner, &handle));
        },
        .icc_retain => upstream.image.retainIccCache(),
        .icc_release => upstream.image.releaseIccCache(),
        .icc_stats => return json(upstream.image.getIccCacheStats(), writer),
        .scene => |options| try status(try scene.set(owner, options)),
        .draw => |options| {
            const result = try scene.draw(owner, scratch, options);
            try status(result.status);
            return json(result.drawn, writer);
        },
    }
    try writer.writeAll("null");
}

pub fn clone(owner: *checked.ContextHandle, source: *checked.ContextHandle, scratch: std.mem.Allocator, handle: WireHandle, writer: *std.Io.Writer) !void {
    const id = try handle.native();
    var output: c.ot_handle = undefined;
    try status(image.ot_image_clone(owner, source, &id, &output));
    return json(try wire(scratch, output), writer);
}

fn status(value: i32) !void {
    if (value == c.OT_OK) return;
    native_status = value;
    return error.CheckedOperationFailed;
}
fn wire(scratch: std.mem.Allocator, value: c.ot_handle) !WireHandle {
    return .{ .context = try std.fmt.allocPrint(scratch, "{d}", .{value.context_id}), .slot = value.slot, .generation = value.generation };
}
fn json(value: anytype, writer: *std.Io.Writer) !void {
    return std.json.Stringify.value(value, .{}, writer);
}
fn decode(scratch: std.mem.Allocator, value: Bytes) ![]u8 {
    if (comptime binary_enabled) {
        return root.binary_transfer.inputSpan(value) catch |err| return transferError(err);
    } else {
        const bytes = try scratch.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(value));
        try std.base64.standard.Decoder.decode(bytes, value);
        return bytes;
    }
}
fn encode(scratch: std.mem.Allocator, value: []const u8) !Bytes {
    if (comptime binary_enabled) {
        return root.binary_transfer.publish(value) catch |err| return transferError(err);
    } else {
        const bytes = try scratch.alloc(u8, std.base64.standard.Encoder.calcSize(value.len));
        return std.base64.standard.Encoder.encode(bytes, value);
    }
}

fn transferError(err: anyerror) anyerror {
    native_status = root.binaryStatus(err) orelse c.OT_INVALID_ARGUMENT;
    return err;
}

fn copyBinaryPixels(owner: *checked.ContextHandle, handle: c.ot_handle, capacity: u32, stride: u32, format: u32, writer: *std.Io.Writer) !void {
    try status(checked.sessionContextStatus(owner));
    if (std.enums.fromInt(upstream.image.PixelFormat, format) == null) {
        try status(image.ot_image_copy_pixels(owner, &handle, null, 0, stride, format));
        unreachable;
    }
    var info: c.ot_image_info = undefined;
    try status(image.ot_image_get_info(owner, &handle, &info));
    const row_bytes = @as(u64, info.width) * 4;
    const required = @as(u64, stride) * (info.height - 1) + row_bytes;
    if (stride < row_bytes or capacity < required) {
        // The actual checked operation supplies the original stride/short-buffer
        // error, without allocating a potentially enormous caller capacity.
        try status(image.ot_image_copy_pixels(owner, &handle, null, 0, stride, format));
        unreachable;
    }
    if (required > root.factory_binary.limit) return status(c.OT_IMAGE_MEMORY_LIMIT);
    const bytes = root.binary_transfer.allocateOutput(@intCast(required)) catch |err| return transferError(err);
    @memset(bytes, 0);
    try status(image.ot_image_copy_pixels(owner, &handle, bytes.ptr, bytes.len, stride, format));
    return json(.{ .bytes = root.binary_transfer.publish(bytes) catch |err| return transferError(err), .width = info.width, .height = info.height, .stride = stride }, writer);
}

fn copyBinaryPng(owner: *checked.ContextHandle, scratch: std.mem.Allocator, handle: c.ot_handle, capacity: u32, writer: *std.Io.Writer) !void {
    var count: u64 = 0;
    try status(image.ot_image_copy_png(owner, &handle, null, 0, &count));
    if (capacity == 0) return json(try encode(scratch, &.{}), writer);
    if (capacity < count) {
        // Any nonempty short destination reaches the same checked ABI branch.
        // A single byte suffices and avoids reserving unused caller capacity.
        var short: [1]u8 = undefined;
        try status(image.ot_image_copy_png(owner, &handle, &short, short.len, &count));
        unreachable;
    }
    const source = try owner.core.raw().getImage(checked.handleFromC(handle));
    const bytes = source.encoded_png orelse return error.InvalidOptions;
    if (count != bytes.len) return error.InvalidOptions;
    return json(try encode(scratch, bytes), writer);
}
