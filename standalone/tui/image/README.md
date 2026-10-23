# Embedded OpenTUI image resources

The image port compiles the pinned OpenTUI 0.6.6 implementation and its vendored
Wuffs PNG/GIF decoder, strict stb JPEG decoder, libwebp decoder, LittleCMS2 color
management and stb resize code into WebAssembly. The shipped factory uses Node
built-ins and embedded WASM bytes. It loads no codec shared library, addon,
executable, extracted WASM file or runtime npm package.

`factory-image.zig` adapts the original checked Context image ABI. It preserves
format and color errors, handle owners and generations, retained-image update
exclusivity, pixel leases, PNG encoding and the original transform/composite
implementations. Separate Context reactors clone an actual image snapshot through
`Context.importImage`, preserving its source format, dimensions, lazy pixels,
original encoded PNG and ICC offsets. Re-encoding a JPEG as PNG is not used to
implement cloning.

The published `NativeImage`, `NativeImagePool`, `ImageRenderable` and
`OwnedRawImageImpl` JavaScript classes remain upstream. Their native factory is
replaced with the WASM adapter. The one additional memory seam in `takeRaw()`
constructs a Uint8Array at the actual checked pixel lease's WASM offset. It keeps
the upstream ownership and release behavior and writes through to linear memory.

Two small native portability corrections retain the real color math and runtime
checks:

- LittleCMS's supported `CMS_PTR_ALIGNMENT=8` setting aligns its internal double
  fields on wasm32, where `sizeof(void*)` is four bytes.
- A checked source adapter replaces one incompatible interpolation function
  pointer cast with a correctly typed forwarding function. Native function-type
  instrumentation otherwise traps on grayscale ICC transforms. The forwarding
  function calls the same original interpolation routine with the same data.

`image/build.zig` registers all decoder, color and resize C sources. Native x64
and arm64 builds retain their upstream WebP SIMD dispatch. The WASM build uses
the portable implementations. The source archive's SHA-256 is checked against
`tui/sources.json`; image implementations and vendors are re-extracted into the
isolated `.cache/image-source` overlay. `LICENSES.txt` contains the image vendor
notices and is also included in the generated factory module.

Build and validate from `standalone/` with the project's Node executable:

```sh
../.tools/node/bin/node tui/image/build.mjs
../.tools/node/bin/node tui/image/proof.mjs
../.tools/node/bin/node tui/image/parity.mjs
../.tools/node/bin/node --test --test-concurrency=1 tui/image/image.test.mjs tui/backend/image.test.mjs
```

The computation proof covers real raw-pixel and PNG round trips, padded BGRA and
opaque imports, all seven resize kernels, transformations, extraction, extension,
compositing, stale and foreign handles, retained-image exclusivity and pixel-lease
teardown. Seventeen pinned PNG/JPEG/GIF/WebP/ICC fixtures include exact upstream
Display-P3 and sRGB golden pixel values and rejection of a CMYK ICC profile. The
native parity script replays the exact WASM request trace through a separate native
executable and compares every response, normalizing only the actual pixel lease
pointer address. Native parity needs the development oracle; the embedded runtime
does not.

The six normal tests include the published image classes and native image scene,
plus an isolated copied single JavaScript file with an empty `PATH` and
`--no-addons`. They use the generated WASM and pinned fixtures checked into this
directory and do not require the native oracle or downloaded source/build cache.

This checkpoint retains the current factory transport limits: 1 MiB JSON input,
8 MiB JSON output, 4 MiB copied pixel/PNG output and a 64 MiB WASM memory ceiling.
These are stricter than OpenTUI's 64 MiB encoded/100 MiB decoded image limits.
Large-image parity requires a checked binary transfer path and a higher image
memory ceiling. Unsupported sizes fail explicitly; ICC processing and codecs are
never silently replaced with assumed success. Platform-independent codecs do not
establish complete terminal protocol or cross-platform CLI parity.
