const std = @import("std");

const yoga_sources = [_][]const u8{
    "yoga/YGConfig.cpp",                 "yoga/YGEnums.cpp",            "yoga/YGNode.cpp",          "yoga/YGNodeLayout.cpp",              "yoga/YGNodeStyle.cpp",        "yoga/YGPixelGrid.cpp",         "yoga/YGValue.cpp",
    "yoga/algorithm/AbsoluteLayout.cpp", "yoga/algorithm/Baseline.cpp", "yoga/algorithm/Cache.cpp", "yoga/algorithm/CalculateLayout.cpp", "yoga/algorithm/FlexLine.cpp", "yoga/algorithm/PixelGrid.cpp", "yoga/config/Config.cpp",
    "yoga/debug/AssertFatal.cpp",        "yoga/debug/Log.cpp",          "yoga/event/event.cpp",     "yoga/node/LayoutResults.cpp",        "yoga/node/Node.cpp",
};

pub fn add(b: *std.Build) void {
    const step = b.step("renderer", "Build the upstream computational renderer and native parity oracle");
    const target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const wasm = b.addExecutable(.{ .name = "opentui-renderer", .root_module = module(b, target, b.path("renderer-bridge.zig")) });
    wasm.entry = .disabled;
    wasm.wasi_exec_model = .reactor;
    wasm.root_module.strip = true;
    wasm.max_memory = 64 * 1024 * 1024;
    wasm.root_module.export_symbol_names = &.{ "rendererInputPointer", "rendererInputCapacity", "rendererOutputPointer", "rendererOutputLength", "rendererCall" };
    const install_wasm = b.addInstallArtifact(wasm, .{});
    step.dependOn(&install_wasm.step);
    const native_module = module(b, b.graph.host, b.path("renderer-native.zig"));
    native_module.addCSourceFile(.{ .file = b.path("renderer-native.c"), .flags = &.{"-std=c17"} });
    const native = b.addExecutable(.{ .name = "opentui-renderer-reference", .root_module = native_module });
    const install_native = b.addInstallArtifact(native, .{});
    step.dependOn(&install_native.step);
}

pub fn module(b: *std.Build, target: std.Build.ResolvedTarget, root: std.Build.LazyPath) *std.Build.Module {
    return moduleWithSource(b, target, root, ".cache/renderer-source");
}

pub fn moduleWithSource(b: *std.Build, target: std.Build.ResolvedTarget, root: std.Build.LazyPath, source_dir: []const u8) *std.Build.Module {
    const result = b.createModule(.{ .root_source_file = root, .target = target, .optimize = .ReleaseSafe, .single_threaded = true, .link_libc = true, .link_libcpp = true });
    const computation_target = if (target.result.cpu.arch == .wasm32) b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi, .cpu_features_add = std.Target.wasm.featureSet(&.{ .exception_handling, .reference_types }) }) else target;
    const upstream = b.createModule(.{ .root_source_file = b.path(b.pathJoin(&.{ source_dir, "src/entry.zig" })), .target = computation_target, .optimize = .ReleaseSafe, .single_threaded = true, .link_libc = true, .link_libcpp = true });
    const options = b.addOptions();
    options.addOption(bool, "gpa_safe_stats", false);
    options.addOption(bool, "computational_only", true);
    options.addOption(bool, "debug", false);
    upstream.addOptions("build_options", options);
    const ghostty = b.addOptions();
    ghostty.addOption(bool, "available", false);
    upstream.addOptions("ghostty_vt_options", ghostty);
    const unicode = b.dependency("uucode", .{
        .target = target,
        .optimize = .ReleaseSafe,
        .fields = @as([]const []const u8, &.{ "grapheme_break", "east_asian_width", "general_category", "is_emoji_presentation" }),
        .fields_1 = @as([]const []const u8, &.{"wcwidth_zero_in_grapheme"}),
    });
    upstream.addImport("uucode", unicode.module("uucode"));
    const yoga = b.path(".cache/upstream/zig-deps/yoga");
    const yoga_header = b.addTranslateC(.{ .root_source_file = b.path(b.pathJoin(&.{ source_dir, "src/yoga-bridge.h" })), .target = target, .optimize = .ReleaseSafe });
    yoga_header.addIncludePath(yoga);
    upstream.addImport("yoga", yoga_header.createModule());
    const api = b.addTranslateC(.{ .root_source_file = b.path(b.pathJoin(&.{ source_dir, "include/opentui.h" })), .target = target, .optimize = .ReleaseSafe });
    upstream.addImport("context_abi_c", api.createModule());
    const audio = b.addTranslateC(.{ .root_source_file = b.path(b.pathJoin(&.{ source_dir, "src/vendor/miniaudio/miniaudio.h" })), .target = target, .optimize = .ReleaseSafe });
    upstream.addImport("miniaudio", audio.createModule());
    const flags: []const []const u8 = if (target.result.cpu.arch == .wasm32) &.{ "-std=c++20", "-fexceptions", "-frtti", "-fwasm-exceptions" } else &.{ "-std=c++20", "-fexceptions", "-frtti" };
    upstream.addIncludePath(yoga);
    upstream.addCSourceFiles(.{ .root = yoga, .files = &yoga_sources, .flags = flags });
    upstream.addCSourceFile(.{ .file = b.path(b.pathJoin(&.{ source_dir, "src/yoga-bridge.cpp" })), .flags = flags });
    upstream.addCSourceFile(.{ .file = b.path("renderer-exceptions.cpp"), .flags = flags });
    if (target.result.cpu.arch == .wasm32) {
        // Zig 0.16's WASI libc++abi deliberately omits C++ exceptions. Compile
        // its matching real exception runtime and WASM unwinder, rather than
        // discarding Yoga's catch/throw and allocation-error contracts.
        const lib = b.graph.zig_lib_directory.path.?;
        const abi_flags = [_][]const u8{ "-std=c++20", "-fexceptions", "-fwasm-exceptions", "-frtti", "-DNDEBUG", "-D_LIBCPP_ABI_VERSION=1", "-D_LIBCPP_ABI_NAMESPACE=__1", "-D_LIBCPP_HAS_THREADS=0", "-D_LIBCXXABI_HAS_NO_THREADS", "-D_LIBCPP_BUILDING_LIBRARY", "-D_LIBCXXABI_BUILDING_LIBRARY", "-D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS", "-D_LIBCXXABI_DISABLE_VISIBILITY_ANNOTATIONS", "-D_LIBCPP_HAS_VENDOR_AVAILABILITY_ANNOTATIONS=0", "-D_LIBCPP_HAS_FILESYSTEM=0" };
        upstream.addIncludePath(.{ .cwd_relative = b.pathJoin(&.{ lib, "libcxxabi/include" }) });
        upstream.addIncludePath(.{ .cwd_relative = b.pathJoin(&.{ lib, "libcxx/src" }) });
        upstream.addIncludePath(.{ .cwd_relative = b.pathJoin(&.{ lib, "libunwind/include" }) });
        upstream.addCSourceFiles(.{ .root = .{ .cwd_relative = lib }, .files = &.{ "libcxxabi/src/cxa_exception.cpp", "libcxxabi/src/cxa_personality.cpp" }, .flags = &abi_flags });
        // Select these real exception-enabled allocation operators over Zig's
        // default weak, no-exceptions definitions in the WASI C++ runtime.
        upstream.addCSourceFile(.{ .file = .{ .cwd_relative = b.pathJoin(&.{ lib, "libcxxabi/src/stdlib_new_delete.cpp" }) }, .flags = &(abi_flags ++ .{"-D_LIBCPP_WEAK="}) });
        upstream.addCSourceFile(.{ .file = .{ .cwd_relative = b.pathJoin(&.{ lib, "libunwind/src/Unwind-wasm.c" }) }, .flags = &.{ "-std=c23", "-fwasm-exceptions", "-DNDEBUG", "-D_LIBUNWIND_HIDE_SYMBOLS" } });
    }
    result.addImport("opentui", upstream);
    return result;
}
