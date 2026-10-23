# OpenTUI WASM implementation

This directory contains **actual OpenTUI code** compiled to WASM: freestanding Unicode measurement/wrapping, an independent Context/Scene/Box/Text/cell-buffer proof, and a checked factory for the published JavaScript renderer. The CLI build connects the original default and mini TUI through this factory. Qualification of the exact distribution is recorded in `standalone/dist/verification.json`; complete upstream parity remains unachieved.

The [published renderer adapter](backend/README.md) runs the original `createTestRenderer`, renderable classes and SyntaxStyle through real WASM contexts, frame/output tickets, editable text and writable buffer leases. Image resources use the original codecs, ICC transforms and scoped pixel storage. The [parser adapter](parser/README.md) embeds the actual published TreeSitterClient, worker and six default grammars. Actual Solid components exercise streaming Markdown, highlighting, scrolling, route changes and editing; copied default/mini CLI tests exercise real terminal input, resize, replies and cleanup. These integrations are separate from the computational/native-parity proofs below. A preview under `standalone/.cache/tui-integration` keeps the previous verified artifact available during integration.

The input is unmodified `packages/native/src/utf8.zig` from OpenTUI **0.6.6**, commit `212eb27da4adf5b907031ad153fc6a5b9f713fbf`, with the exact vendored `uucode` and Unicode table configuration used by that commit. `sources.json` pins download hashes. `bridge.zig` adds a bounded 1 MiB UTF-8 input window and exports width/wrap operations; it adds no filesystem, terminal, allocation, or FFI imports. The generated `unicode-wasm.mjs` embeds the resulting WASM and license notices.

From this directory:

```sh
# Runs the checked-in embedded computation with Node alone.
node demo.mjs

# Assemble a self-contained demo from the checked-in WASM; no Zig required.
node bundle-demo.mjs

# Rebuilds both the WASM and the native development-only parity oracle.
node build.mjs

# Tests the JS boundary, real Unicode behavior, and isolated one-file execution.
node --test unicode.test.mjs

# Node >=26.4.0: compare against the same upstream code compiled natively.
node --experimental-ffi parity.mjs

# Inspect the installed OpenTUI package, or pass a published package directory.
node audit.mjs
```

The build needs `tar` and Zig 0.16.0. It automatically downloads the pinned Linux x64 compiler into `.cache/zig`; other build hosts can set `OPENCODE_ZIG` to their Zig 0.16.0 executable. All dependency sources and compiler/build caches stay under `.cache`. The initial cold build can take several minutes. No compiler or native reference library is needed to run the generated JavaScript.

The regular Node tests also run from a fresh checkout with no `.cache` directory: they assemble the standalone proof from the checked-in embedded WASM. Unicode native parity requires the build and Node's experimental FFI flag. Validation so far covers Linux x64 with Node 24.1.0/26.4.0; other build hosts are not yet validated.

`build.mjs` also writes **`.cache/opentui-unicode-demo.mjs`**, a self-contained JavaScript file containing the runtime, WASM, license notices, and small terminal-output demo. Copy only that file to another directory and run it with Node. The proof intentionally labels itself as Unicode computation; the box is written through `process.stdout`, and does not claim to exercise OpenTUI's renderer, widgets, keyboard handling, resize, or terminal restoration.

`parity.mjs` exercises Hangul, combining marks, joined emoji, regional flags, Indic text, Arabic, CJK, ambiguous-width characters, controls, and tabs across all four upstream width modes. It compares widths and wrap offsets/grapheme counts/columns against the native compilation of the same source. This establishes cross-target parity for those fixtures; it is not a complete Unicode or TUI conformance suite.

## Context, scene, buffer, and Yoga checkpoint

`renderer-build.mjs` prepares a fresh source overlay from the same pinned OpenTUI commit, verifies the archive hash in `sources.json`, and compiles the bridge twice: a WASM reactor and a native development oracle. The actual upstream `Context`, session renderer, `Scene`, `OptimizedBuffer`, Unicode/grapheme storage, text measurement/wrapping, and patched Yoga C++ code perform all computation. The demo prints the text resolved from the rendered cell buffer; its box and text are painted by OpenTUI.

```sh
# Run the checked-in embedded computational renderer with Node alone.
node renderer-demo.mjs

# Rebuild WASM and the same implementation as a native parity oracle.
node renderer-build.mjs

# Exercise real layout, painting, resize, mutation, checked handles, and isolation.
node --test renderer.test.mjs

# Compare full cell arrays, colors, attributes, text, layouts, and C++ exceptions.
node renderer-parity.mjs

# Copy the resulting single file anywhere; no compiler, FFI, or sidecar is needed.
node renderer-bundle.mjs
node .cache/opentui-renderer-demo.mjs
```

`renderer.mjs` instantiates the embedded reactor and initializes its C++ runtime. Its API exposes context creation/cleanup, session attachment, Root/Box/Text node creation and destruction, ancestry, Yoga styles, Box paint/title details, text/options, measurement/layout queries, resize, and frame capture. Capture runs real scene painting, acquires a checked buffer lease, resolves the buffer's grapheme cells, copies the resulting arrays/text through JSON, releases the lease, and cancels the draft. It does not present a terminal frame or emit terminal setup/restoration bytes.

The bridge has a 64 KiB request window, an 8 MiB response window, at most 4,096 checked object handles per context, at most 16,384 cells per renderer, and a 64 MiB WASM memory ceiling. Handles retain the upstream context ID, slot, and generation; context IDs cross JSON as decimal strings to preserve all 64 bits. Calls recreate views after allocation because WASM memory may grow. The native oracle uses the same bridge, generated source overlay, single-owner configuration, and C++ sources. It runs as a separate executable with bounded JSON-lines input and output, so its C++ exception runtime stays isolated from Node's runtime. The parity driver records the exact WASM requests, runs them through the native process, then compares complete traces. Regular tests need only the checked-in WASM; native parity additionally needs the native development build, without FFI.

The tracked build driver applies the following explicit portability changes to the cached source; it validates every patch against the pinned source before compiling:

- Use a synchronous allocator/runtime and `std.Io.failing` in place of process-wide native I/O. No worker threads, environment, or terminal are started by the exported interface.
- Preserve 64-bit non-wrapping context IDs with ordinary loads/increments under the single-owner contract, since baseline wasm32 cannot compile the upstream u64 atomics.
- Widen recording-size arithmetic to u64 so importing `Scene` does not assert that pointers are 64-bit. Recording playback and image painting return `UnsupportedResource` in this checkpoint.
- Exclude audio/clipboard worker teardown and buffered-output worker joins under the computational profile. These objects cannot be created through this bridge; an internal encounter is an invariant violation. The same exclusions apply to the native oracle.
- Keep raw native-pointer Yoga and Stream functions internal, and export only the bounded bridge plus reactor initialization/memory.
- Compile the matching LLVM exception/personality/new-allocation helpers and WASM unwinder with real C++ exceptions. [Zig 0.16's default WASI runtime omits those exception sources](https://codeberg.org/ziglang/zig/src/tag/0.16.0/src/libs/libcxx.zig). Compile the full exception-enabled allocation operators as strong definitions so they replace Zig's default weak, no-exceptions operators. Keep the root reactor target at baseline while enabling exception/reference features on the computational module; this avoids selecting Zig's incompatible internal WASI setjmp build. A small diagnostic throws `std::bad_alloc` and `std::logic_error` into typed catches on both targets. It also requests 128 MiB beyond the reactor's 64 MiB ceiling to verify that real throwing allocation fails with `bad_alloc` and nothrow allocation returns null; native verification uses a near-`SIZE_MAX` request without allocating it.

The source overlay is regenerated under `.cache/renderer-source`; hand-editing ignored cached source is unnecessary. Yoga is fetched only by the renderer driver, so the original Unicode build remains independent. Embedded notices include OpenTUI, uucode/Unicode, Yoga, and the pinned Zig/C++/WASI runtime licenses.

This is a computational checkpoint. It does not implement the generated 235-function native ABI, JavaScript callback/lifetime adaptation, `createTestRenderer`, Solid renderables, keyboard/mouse input, terminal presentation, clipboard/audio, images, syntax-parser workers, or Ghostty's embedded terminal. Unknown operations and unsupported node kinds fail; they do not report fabricated success.

## Remaining full-renderer work

`audit-baseline.json` is the reproducible package audit. OpenTUI 0.6.6 exposes **235 generated native ABI functions**, in addition to legacy and Yoga bindings, and publishes eight platform-specific native packages. The Node entry uses `node:ffi`, checks for an on-disk native library, and calls `dlopen`. Its bundled parser WASM assets provide syntax parsing, not a renderer backend.

The published factory now covers checked memory/callback adaptation, layout, editing, image resources, embedded terminals and terminal presentation. These boundaries remain:

| Boundary | Concrete upstream evidence | Required implementation |
| --- | --- | --- |
| Host services | Linux host clipboard uses direct X11/Wayland protocols; Session output, terminal OSC 52 and kernel input flushing are connected. | Audio devices, macOS/Windows clipboard providers and WSL core-data-device compatibility remain unimplemented. Wayland requires ext/wlr data-control. |
| Image memory | Images use generation-checked binary windows, 256 KiB cross-Context copies and a reactor that grows on demand. The original per-image codec limits remain intact. | Qualify workloads near the 256 MiB transfer and 1 GiB aggregate reactor budgets; explicit allocation failures remain possible. Independent computational proofs keep their 64 MiB ceiling. |
| Embedded terminal | The factory compiles the actual EmbeddedTerminal/compositor and pinned Ghostty VT on WASM, with checked binary transfer and the original published widget. | Unicode/ANSI, selection, scrollback, resize, key/mouse/paste/focus/responses and actual /terminal shell lifecycle are tested. Original direct-only Kitty restrictions and compositor behavior remain unchanged. |
| Full UI/platform compatibility | Actual production components and copied CLI input/render/cleanup are tested on Linux x64. | Extend workflow and platform coverage; the existing tests do not establish complete parity. |

The original Context/Scene checkpoint remains an independent computational subset. Interactive OpenCode uses the extended published factory; missing operations fail explicitly. Host services, aggregate image memory and platform coverage remain separate compatibility work.

## Published JavaScript factory

The published JS package does **not** expose a backend-object injection point. In `packages/core/src/zig.ts`, `RenderLib` is `Pick<FFIRenderLib, keyof FFIRenderLib>`; `resolveRenderLib()` constructs `FFIRenderLib`, and the public `setRenderLibPath()` changes only the native library filename. Passing a `.wasm` path to it would still call `dlopen`. `NativeSession` also resolves this singleton in a field initializer, so supplying `CliRendererConfig.nativeSession` alone does not bypass the native backend.

`backend/package.mjs` verifies the pinned published JavaScript before adapting the backend factory, four cell-array constructors and the raw image lease view. `factory-bridge.zig` wraps the real checked native implementation behind bounded JSON control requests and generation-checked binary image/terminal windows, with one reactor per public Context and decimal 64-bit ticket fields. Frame commits feed the actual Session; its original JavaScript driver pumps and acknowledges output. Scoped array views alias real WASM storage and preserve original lifetime guards. Tests cover editor events/history/selections, custom measurement and painting, shared highlighted text, large image/ICC resources, the actual EmbeddedTerminalRenderable and Solid TUI. Missing operations continue to fail explicitly.

`terminal/sources.json` records the Ghostty and Unicode revisions from the pinned OpenTUI vendor script. `terminal/source.mjs` validates the source archive hashes before preparing factory-only dependencies. The factory selects the actual terminal implementation without changing the independent computation/image profiles. The WASM portability branch rejects unavailable shared-memory graphics access; the original widget already permits only direct Kitty media. Terminal code and licenses stay inside the single JS artifact. Native comparison tools under `terminal/` are only needed for development.

`clipboard.mjs` retains the original published clipboard validation and destination policy, routing host operations through the direct X11/Wayland implementations under `clipboard/`. These use Node sockets and, for Wayland descriptor passing, built-in FFI and system libc. Neither external clipboard commands nor libX11/libwayland are runtime dependencies. Isolated desktop servers and independent native clients verify actual selection ownership, Unicode/images, bounded transfers and cleanup; the copied CLI also exercises Ctrl+V. See [clipboard/README.md](clipboard/README.md) for the development fixtures and remaining platform boundaries.

Pinned upstream source: [OpenTUI commit](https://github.com/anomalyco/opentui/tree/212eb27da4adf5b907031ad153fc6a5b9f713fbf), [native build](https://github.com/anomalyco/opentui/blob/212eb27da4adf5b907031ad153fc6a5b9f713fbf/packages/native/build.zig), [Unicode implementation](https://github.com/anomalyco/opentui/blob/212eb27da4adf5b907031ad153fc6a5b9f713fbf/packages/native/src/utf8.zig).
