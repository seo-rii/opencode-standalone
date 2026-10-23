// The development oracle runs outside Node to isolate libc++/libunwind from
// Node's libstdc++/libgcc exception runtime.
pub extern "c" fn main() c_int;

comptime {
    _ = @import("renderer-bridge.zig");
}
