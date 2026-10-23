pub extern "c" fn main() c_int;
pub const io = @import("std").Io.failing;
comptime { _ = @import("proof-bridge.zig"); }
