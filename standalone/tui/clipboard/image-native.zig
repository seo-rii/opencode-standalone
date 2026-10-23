const std = @import("std");
const dib = @import("clipboard_dib");

pub const io = std.Io.failing;
pub extern "c" fn main() c_int;

export fn convertClipboardImage(
    bytes: [*]const u8,
    length: u32,
    bmp: u32,
    max_output_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    result: *?[*]u8,
    result_length: *u32,
) u32 {
    const options = dib.ConvertOptions{
        .max_output_bytes = max_output_bytes,
        .max_image_pixels = max_image_pixels,
        .max_conversion_bytes = max_conversion_bytes,
        .deadline_ns = std.math.maxInt(i128),
    };
    const converted = (if (bmp == 0)
        dib.convertToPng(std.heap.c_allocator, bytes[0..length], options)
    else
        dib.convertBmpToPng(std.heap.c_allocator, bytes[0..length], options)) catch |err| return switch (err) {
        error.InvalidData => 1,
        error.Unsupported => 2,
        error.LimitExceeded => 3,
        error.OutOfMemory => 4,
        error.Cancelled => 5,
        error.TimedOut => 6,
    };
    result.* = converted.ptr;
    result_length.* = @intCast(converted.len);
    return 0;
}

export fn freeClipboardImage(bytes: [*]u8, length: u32) void {
    std.heap.c_allocator.free(bytes[0..length]);
}
