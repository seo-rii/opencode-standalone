// The native oracle executes outside Node so its C++ runtime stays independent.
const bridge = @import("factory-bridge.zig");
pub extern "c" fn main() c_int;
pub const factory_binary = bridge.factory_binary;
pub const binary_transfer = &bridge.binary_transfer;
pub const WireFrame = bridge.WireFrame;
pub const binaryStatus = bridge.binaryStatus;
pub const io = bridge.io;

export fn terminalOracleBinaryPointer() [*]const u8 {
    return bridge.binary_transfer.owned_output.ptr;
}
export fn terminalOracleBinaryLength() u32 {
    return @intCast(bridge.binary_transfer.output_length);
}

comptime {
    _ = bridge;
}
