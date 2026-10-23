const std = @import("std");

// JSON carries these descriptors, never a caller-supplied linear-memory pointer.
// Input offsets are relative to the reserved input window. Output offsets are
// absolute addresses borrowed only until the next call, reserve, or release.
pub const Span = struct { offset: usize, length: u32, generation: u32 };
pub const limit = 256 * 1024 * 1024;
pub const Error = error{ BinaryBusy, BinaryRange, BinaryStale, BinaryLimit, BinaryGenerationLimit, OutOfMemory };

pub const Transfer = struct {
    allocator: std.mem.Allocator,
    input: []u8 = &.{},
    input_generation: u32 = 0,
    input_serial: u32 = 0,
    owned_output: []u8 = &.{},
    output_generation: u32 = 0,
    output_serial: u32 = 0,
    output_length: usize = 0,
    depth: usize = 0,

    pub fn init(allocator: std.mem.Allocator) Transfer {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Transfer) void {
        self.clear();
        self.* = undefined;
    }

    pub fn reserve(self: *Transfer, count: u32) Error!void {
        if (self.depth != 0) return error.BinaryBusy;
        if (count > limit) return error.BinaryLimit;
        if (self.input_serial == std.math.maxInt(u32)) return error.BinaryGenerationLimit;
        self.clear();
        self.input_serial += 1;
        self.input = try self.allocator.alloc(u8, count);
        self.input_generation = self.input_serial;
    }

    pub fn release(self: *Transfer, generation: u32) Error!void {
        if (self.depth != 0) return error.BinaryBusy;
        if (generation == 0 or generation != self.input_generation) return error.BinaryStale;
        self.clear();
    }

    pub fn inputSpan(self: *Transfer, span: Span) Error![]u8 {
        if (self.depth != 1) return error.BinaryBusy;
        if (span.generation == 0 or span.generation != self.input_generation) return error.BinaryStale;
        if (span.offset > self.input.len or span.length > self.input.len - span.offset) return error.BinaryRange;
        return self.input[span.offset..][0..span.length];
    }

    pub fn enter(self: *Transfer) Error!void {
        if (self.depth == 0) {
            self.clearOutput();
            if (self.output_serial == std.math.maxInt(u32)) return error.BinaryGenerationLimit;
            self.output_serial += 1;
            self.output_generation = self.output_serial;
        }
        self.depth = std.math.add(usize, self.depth, 1) catch return error.BinaryBusy;
    }

    pub fn leave(self: *Transfer) void {
        std.debug.assert(self.depth != 0);
        self.depth -= 1;
    }

    pub fn allocateOutput(self: *Transfer, count: usize) Error![]u8 {
        if (self.depth != 1 or self.owned_output.len != 0) return error.BinaryBusy;
        if (count > limit) return error.BinaryLimit;
        self.owned_output = try self.allocator.alloc(u8, count);
        return self.owned_output;
    }

    pub fn publish(self: *Transfer, bytes: []const u8) Error!Span {
        if (self.depth != 1) return error.BinaryBusy;
        if (bytes.len > limit - self.output_length) return error.BinaryLimit;
        self.output_length += bytes.len;
        return .{ .offset = if (bytes.len == 0) 0 else @intFromPtr(bytes.ptr), .length = @intCast(bytes.len), .generation = self.output_generation };
    }

    // Successful Context teardown also invalidates staging windows. The serials
    // survive it so descriptors from an earlier Context can never become live.
    pub fn clear(self: *Transfer) void {
        self.clearOutput();
        self.allocator.free(self.input);
        self.input = &.{};
        self.input_generation = 0;
    }

    fn clearOutput(self: *Transfer) void {
        self.allocator.free(self.owned_output);
        self.owned_output = &.{};
        self.output_generation = 0;
        self.output_length = 0;
    }
};

test "reserved spans reject stale generations, relative overflow and active replacement" {
    var transfer = Transfer.init(std.testing.allocator);
    defer transfer.deinit();
    try transfer.reserve(8);
    const generation = transfer.input_generation;
    @memcpy(transfer.input, "abcdefgh");
    try transfer.enter();
    try std.testing.expectEqualStrings("cde", try transfer.inputSpan(.{ .offset = 2, .length = 3, .generation = generation }));
    try std.testing.expectError(error.BinaryRange, transfer.inputSpan(.{ .offset = std.math.maxInt(usize), .length = 1, .generation = generation }));
    try std.testing.expectError(error.BinaryRange, transfer.inputSpan(.{ .offset = 8, .length = std.math.maxInt(u32), .generation = generation }));
    try std.testing.expectError(error.BinaryStale, transfer.inputSpan(.{ .offset = 0, .length = 0, .generation = 0 }));
    try std.testing.expectError(error.BinaryBusy, transfer.reserve(0));
    try std.testing.expectError(error.BinaryBusy, transfer.release(generation));
    try transfer.enter();
    try std.testing.expectError(error.BinaryBusy, transfer.inputSpan(.{ .offset = 0, .length = 1, .generation = generation }));
    try std.testing.expectError(error.BinaryBusy, transfer.publish("x"));
    transfer.leave();
    transfer.leave();
    try transfer.release(generation);
    try std.testing.expectError(error.BinaryStale, transfer.release(generation));
    try transfer.reserve(0);
    try std.testing.expect(transfer.input_generation != generation);
    try transfer.enter();
    try std.testing.expectError(error.BinaryStale, transfer.inputSpan(.{ .offset = 0, .length = 0, .generation = generation }));
    try std.testing.expectEqual(@as(usize, 0), (try transfer.inputSpan(.{ .offset = 0, .length = 0, .generation = transfer.input_generation })).len);
    transfer.leave();
}

test "outputs survive nested reads and expire at every native operation or input release" {
    var transfer = Transfer.init(std.testing.allocator);
    defer transfer.deinit();
    try transfer.reserve(1);
    const input_generation = transfer.input_generation;
    try transfer.enter();
    const bytes = try transfer.allocateOutput(4);
    @memcpy(bytes, "rgba");
    const span = try transfer.publish(bytes);
    try std.testing.expectEqual(@intFromPtr(bytes.ptr), span.offset);
    try std.testing.expectEqual(@as(u32, 4), span.length);
    try transfer.enter();
    transfer.leave();
    try std.testing.expectEqual(span.generation, transfer.output_generation);
    transfer.leave();
    try transfer.enter();
    try std.testing.expect(transfer.output_generation != span.generation);
    try std.testing.expectEqual(@as(usize, 0), transfer.owned_output.len);
    transfer.leave();
    try transfer.release(input_generation);
    try std.testing.expectEqual(@as(u32, 0), transfer.output_generation);
    try transfer.enter();
    transfer.output_length = limit;
    try std.testing.expectError(error.BinaryLimit, transfer.publish("x"));
    try std.testing.expectError(error.BinaryLimit, transfer.allocateOutput(limit + 1));
    transfer.leave();
}

test "allocation failure and generation exhaustion cannot resurrect earlier windows" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 1 });
    var transfer = Transfer.init(failing.allocator());
    defer transfer.deinit();
    try transfer.reserve(1);
    const generation = transfer.input_generation;
    try std.testing.expectError(error.OutOfMemory, transfer.reserve(1));
    try std.testing.expectEqual(@as(u32, 0), transfer.input_generation);
    try std.testing.expectError(error.BinaryStale, transfer.release(generation));
    transfer.input_serial = std.math.maxInt(u32);
    try std.testing.expectError(error.BinaryGenerationLimit, transfer.reserve(0));
    transfer.output_serial = std.math.maxInt(u32);
    try std.testing.expectError(error.BinaryGenerationLimit, transfer.enter());
    try std.testing.expectEqual(@as(usize, 0), transfer.depth);
    try std.testing.expectEqual(@as(u32, 0), transfer.output_generation);
    try std.testing.expectError(error.BinaryLimit, transfer.reserve(limit + 1));
}
