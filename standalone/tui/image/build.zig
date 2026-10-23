const std = @import("std");

pub fn add(b: *std.Build) void {
    const step = b.step("images", "Build the checked image resource reactor and native oracle");
    const target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const wasm_module = module(b, target, b.path("image/proof-bridge.zig"));
    const wasm = b.addExecutable(.{ .name = "opentui-images", .root_module = wasm_module });
    wasm.entry = .disabled;
    wasm.wasi_exec_model = .reactor;
    wasm.root_module.strip = true;
    wasm.max_memory = 64 * 1024 * 1024;
    wasm.root_module.export_symbol_names = &.{ "imageInputPointer", "imageInputCapacity", "imageOutputPointer", "imageOutputLength", "imageCall" };
    step.dependOn(&b.addInstallArtifact(wasm, .{}).step);
    const native_module = module(b, b.graph.host, b.path("image/native.zig"));
    native_module.addCSourceFile(.{ .file = b.path("image/native.c"), .flags = @import("../renderer-build.zig").sourceFlags(b, &.{"-std=c17"}) });
    const native = b.addExecutable(.{ .name = "opentui-images-reference", .root_module = native_module });
    step.dependOn(&b.addInstallArtifact(native, .{}).step);
}

fn module(b: *std.Build, target: std.Build.ResolvedTarget, root: std.Build.LazyPath) *std.Build.Module {
    const result = @import("../renderer-build.zig").moduleWithSource(b, target, root, ".cache/image-source");
    const upstream = result.import_table.get("opentui").?;
    codecs(b, upstream, target, ".cache/image-source");
    const image = b.createModule(.{ .root_source_file = b.path("factory-image.zig"), .target = target, .optimize = .ReleaseSafe });
    image.addImport("opentui", upstream);
    result.addImport("factory_image", image);
    return result;
}

// Register the exact vendored decoder, color-management and resize sources.
// WebAssembly uses their portable C implementations. The native comparison
// executable retains the upstream x64/arm64 SIMD dispatch where applicable.
pub fn codecs(b: *std.Build, upstream: *std.Build.Module, target: std.Build.ResolvedTarget, source: []const u8) void {
    // LittleCMS defaults its suballocator to sizeof(void*), but wasm32 f64
    // fields still require eight-byte alignment. Keep the real library's own
    // supported allocator alignment setting instead of disabling the trap.
    const flags = @import("../renderer-build.zig").sourceFlags(b, &.{ "-std=c99", "-ffp-contract=off", "-fvisibility=hidden", "-DCMS_PTR_ALIGNMENT=8" });
    upstream.addCSourceFile(.{ .file = b.path(b.pathJoin(&.{ source, "src/image-shim.c" })), .flags = flags });
    upstream.addIncludePath(b.path(b.pathJoin(&.{ source, "src/vendor/lcms2/include" })));
    upstream.addIncludePath(b.path(b.pathJoin(&.{ source, "src/vendor/lcms2/src" })));
    upstream.addCSourceFiles(.{ .root = b.path(b.pathJoin(&.{ source, "src/vendor/lcms2" })), .files = &.{
        "src/cmsalpha.c", "src/cmscam02.c", "src/cmscgats.c", "src/cmscnvrt.c", "src/cmserr.c", "src/cmsgamma.c", "src/cmsgmt.c", "src/cmshalf.c", "src/cmsintrp.c", "src/cmsio0.c", "src/cmsio1.c", "src/cmslut.c", "src/cmsmd5.c", "src/cmsmtrx.c", "src/cmsnamed.c", "src/cmsopt.c", "src/cmspack.c", "src/cmspcs.c", "src/cmsplugin.c", "src/cmsps2.c", "src/cmssamp.c", "src/cmssm.c", "src/cmstypes.c", "src/cmsvirt.c", "src/cmswtpnt.c", "src/cmsxform.c",
    }, .flags = flags });
    // Preserve the existing upstream exception for the resize unit's bounded
    // pre-table pointer idiom; all other C units retain their normal checks.
    upstream.addCSourceFile(.{ .file = b.path(b.pathJoin(&.{ source, "src/image-resize-shim.c" })), .flags = @import("../renderer-build.zig").sourceFlags(b, &.{ "-std=c99", "-ffp-contract=off", "-fvisibility=hidden", "-fno-sanitize=bounds" }) });
    const webp_flags = @import("../renderer-build.zig").sourceFlags(b, &.{ "-std=c99", "-fvisibility=hidden", "-DWEBP_EXTERN=extern" });
    const dispatch_flags = if (target.result.cpu.arch == .x86_64) @import("../renderer-build.zig").sourceFlags(b, &.{ "-std=c99", "-fvisibility=hidden", "-DWEBP_EXTERN=extern", "-DWEBP_HAVE_SSE2", "-DWEBP_HAVE_SSE41", "-DWEBP_HAVE_AVX2" }) else webp_flags;
    const webp = b.path(b.pathJoin(&.{ source, "src/vendor/libwebp" }));
    upstream.addIncludePath(webp);
    upstream.addCSourceFile(.{ .file = b.path(b.pathJoin(&.{ source, "src/image-webp-config.c" })), .flags = dispatch_flags });
    upstream.addCSourceFiles(.{ .root = webp, .files = &.{
        "src/dec/alpha_dec.c", "src/dec/buffer_dec.c", "src/dec/frame_dec.c", "src/dec/idec_dec.c", "src/dec/io_dec.c", "src/dec/quant_dec.c", "src/dec/tree_dec.c", "src/dec/vp8_dec.c", "src/dec/vp8l_dec.c", "src/dec/webp_dec.c", "src/dsp/alpha_processing.c", "src/dsp/cpu.c", "src/dsp/dec.c", "src/dsp/dec_clip_tables.c", "src/dsp/filters.c", "src/dsp/lossless.c", "src/dsp/rescaler.c", "src/dsp/upsampling.c", "src/dsp/yuv.c", "src/utils/bit_reader_utils.c", "src/utils/color_cache_utils.c", "src/utils/filters_utils.c", "src/utils/huffman_utils.c", "src/utils/palette.c", "src/utils/quant_levels_dec_utils.c", "src/utils/random_utils.c", "src/utils/rescaler_utils.c", "src/utils/thread_utils.c", "src/utils/utils.c",
    }, .flags = dispatch_flags });
    switch (target.result.cpu.arch) {
        .x86_64 => {
            upstream.addCSourceFiles(.{ .root = webp, .files = &.{ "src/dsp/alpha_processing_sse2.c", "src/dsp/dec_sse2.c", "src/dsp/filters_sse2.c", "src/dsp/lossless_sse2.c", "src/dsp/rescaler_sse2.c", "src/dsp/upsampling_sse2.c", "src/dsp/yuv_sse2.c" }, .flags = webp_flags });
            upstream.addCSourceFile(.{ .file = b.path(b.pathJoin(&.{ source, "src/image-webp-sse41.c" })), .flags = webp_flags });
            upstream.addCSourceFile(.{ .file = b.path(b.pathJoin(&.{ source, "src/image-webp-avx2.c" })), .flags = webp_flags });
        },
        .aarch64 => upstream.addCSourceFiles(.{ .root = webp, .files = &.{ "src/dsp/alpha_processing_neon.c", "src/dsp/dec_neon.c", "src/dsp/filters_neon.c", "src/dsp/lossless_neon.c", "src/dsp/rescaler_neon.c", "src/dsp/upsampling_neon.c", "src/dsp/yuv_neon.c" }, .flags = webp_flags }),
        else => {},
    }
}
