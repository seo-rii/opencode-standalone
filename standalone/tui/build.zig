const std = @import("std");

pub fn build(b: *std.Build) void {
    if (b.option(bool, "renderer", "Build the experimental renderer port") orelse false) {
        @import("renderer-build.zig").add(b);
    }
    if (b.option(bool, "factory", "Build the checked memory renderer factory") orelse false) {
        @import("factory-build.zig").add(b);
    }
    if (b.option(bool, "images", "Build the checked image resource proof") orelse false) {
        @import("image/build.zig").add(b);
    }
    const wasm_target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding });
    const wasm_module = bridge(b, wasm_target);
    wasm_module.strip = true;
    const wasm = b.addExecutable(.{
        .name = "opentui-unicode",
        .root_module = wasm_module,
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    b.installArtifact(wasm);

    // Compile the exact same upstream source for native execution as a parity
    // oracle. This artifact is only used during development, never bundled.
    const native = b.addLibrary(.{
        .name = "opentui-unicode-reference",
        .root_module = bridge(b, b.graph.host),
        .linkage = .dynamic,
    });
    b.installArtifact(native);
}

fn bridge(b: *std.Build, target: std.Build.ResolvedTarget) *std.Build.Module {
    const unicode = b.dependency("uucode", .{
        .target = target,
        .optimize = .ReleaseSafe,
        // Match packages/native/build.zig in the pinned OpenTUI source.
        .fields = @as([]const []const u8, &.{
            "grapheme_break",
            "east_asian_width",
            "general_category",
            "is_emoji_presentation",
        }),
        .fields_1 = @as([]const []const u8, &.{"wcwidth_zero_in_grapheme"}),
    });
    const upstream = b.createModule(.{
        .root_source_file = b.path(".cache/upstream/utf8.zig"),
        .target = target,
        .optimize = .ReleaseSafe,
    });
    upstream.addImport("uucode", unicode.module("uucode"));
    const module = b.createModule(.{
        .root_source_file = b.path("bridge.zig"),
        .target = target,
        .optimize = .ReleaseSafe,
    });
    module.addImport("utf8", upstream);
    return module;
}
