const std = @import("std");

pub fn add(b: *std.Build) void {
    const step = b.step("factory", "Build the checked OpenTUI memory-renderer factory reactor");
    const target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const module = factoryModule(b, target, b.path("factory-bridge.zig")) orelse return;
    const wasm = b.addExecutable(.{ .name = "opentui-factory", .root_module = module });
    wasm.entry = .disabled;
    wasm.wasi_exec_model = .reactor;
    wasm.root_module.strip = true;
    // Initial pages remain demand-driven; actual upstream images can require
    // 100MB of pixels plus independent Context clones and codec workspaces.
    wasm.max_memory = 1024 * 1024 * 1024;
    wasm.root_module.export_symbol_names = &.{ "factoryInputPointer", "factoryInputCapacity", "factoryOutputPointer", "factoryOutputLength", "factoryCall", "factoryBinaryReserve", "factoryBinaryPointer", "factoryBinaryLength", "factoryBinaryGeneration", "factoryBinaryOutputGeneration", "factoryBinaryRelease" };
    const install = b.addInstallArtifact(wasm, .{});
    step.dependOn(&install.step);

    if (b.option(bool, "terminal-oracle", "Build the native terminal parity oracle") orelse false) {
        const native_step = b.step("terminal-oracle", "Build the native terminal parity oracle");
        const native_module = factoryModule(b, b.graph.host, b.path("factory-native.zig")) orelse return;
        native_module.addCSourceFile(.{ .file = b.path("terminal/native.c"), .flags = &.{"-std=c17"} });
        const native = b.addExecutable(.{ .name = "opentui-terminal-reference", .root_module = native_module });
        const install_native = b.addInstallArtifact(native, .{});
        native_step.dependOn(&install_native.step);
    }
}

fn factoryModule(b: *std.Build, target: std.Build.ResolvedTarget, root: std.Build.LazyPath) ?*std.Build.Module {
    const module = @import("renderer-build.zig").moduleWithSource(b, target, root, ".cache/factory-source");
    const upstream = module.import_table.get("opentui").?;
    @import("image/build.zig").codecs(b, upstream, target, ".cache/factory-source");
    const ghostty = b.lazyDependency("ghostty", .{
        .target = upstream.resolved_target.?,
        .optimize = .ReleaseSafe,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"emit-xcframework" = false,
        .@"emit-themes" = false,
        .i18n = false,
        .@"lib-version-string" = "0.1.0-dev+b988efcf",
    }) orelse return null;
    upstream.addImport("ghostty_vt", ghostty.module("ghostty-vt"));
    const ghostty_options = b.addOptions();
    ghostty_options.addOption(bool, "available", true);
    upstream.addOptions("ghostty_vt_options", ghostty_options);
    return module;
}
