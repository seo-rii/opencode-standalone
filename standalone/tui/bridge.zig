const utf8 = @import("utf8");

// A bounded, caller-owned input window keeps this proof independent of libc,
// WASI, allocation callbacks, and native process pointers.
var input: [1024 * 1024]u8 = undefined;
var result: [3]u32 = undefined;

export fn inputPointer() [*]u8 {
    return &input;
}

export fn inputCapacity() u32 {
    return input.len;
}

export fn resultPointer() [*]const u32 {
    return &result;
}

export fn textWidth(length: u32, method: u8, tab_width: u8, notation: u8) u32 {
    const text = input[0..length];
    return utf8.calculateTextWidth(text, tab_width, @enumFromInt(notation), utf8.isAsciiOnly(text), @enumFromInt(method));
}

export fn wrapPosition(length: u32, columns: u32, method: u8, tab_width: u8, notation: u8) void {
    const text = input[0..length];
    const wrapped = utf8.findWrapPosByWidthGraphemeSafe(text, columns, tab_width, @enumFromInt(notation), utf8.isAsciiOnly(text), @enumFromInt(method));
    result = .{ wrapped.byte_offset, wrapped.grapheme_count, wrapped.columns_used };
}
