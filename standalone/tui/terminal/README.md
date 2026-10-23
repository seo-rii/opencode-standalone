# Embedded terminal

The factory reactor compiles OpenTUI 0.6.6's actual `EmbeddedTerminal`, checked
Context ABI, Ghostty VT engine, input encoders, and cell compositor. The original
published `EmbeddedTerminalRenderable` remains responsible for its scene paint,
selection, focus, resize, and input callbacks. PTY process ownership stays in the
existing standalone ordinary and persistent PTY implementations.

`sources.json` records Ghostty commit
`727b8a02f8734840de664c060678dd66f01931f6`, its upstream archive checksum, the
separate Ghostty uucode pin, and the verified OpenTUI vendored archive checksum.
`source.mjs` checks both source archives and the pin declarations in OpenTUI's
`update-zig-deps.sh` before extracting into the separate `.cache/factory-deps`
directory. OpenTUI's reported lib-vt version `0.1.0-dev+b988efcf` differs from the
actual source commit; it is retained as version metadata.

Ghostty is enabled only in `factory-build.zig`. The independent computational
renderer keeps its original disabled terminal profile and 64 MiB memory limit.
The one platform adaptation extends Ghostty's existing `UnsupportedMedium`
branch to WASM for POSIX shared memory. OpenTUI already permits only direct Kitty
image transmission. Its existing null PNG decoder and cell compositor behavior
remain unchanged.

Binary input and returned bytes use the factory's checked spans. Returned bytes
are copied before the transport invalidates its temporary output. The original
1 MiB write chunks, paste admission, response queue, and single response-overflow
retry are preserved. Ghostty retains its native default text-width modes; an
application can request grapheme clustering with DEC mode 2027.

From `standalone`, with Node 26.4 or newer and the prepared pinned renderer:

```sh
node tui/factory-build.mjs
node tui/terminal/build-native.mjs
node tui/terminal/parity.mjs
```

The separate native executable is a development oracle and is never distributed.
The parity driver replays the actual production WASM transport's requests through
the same checked native Context API. It compares all four cell planes (u32
characters, two 8-byte RGBA planes, and u32 attributes), resolved text, cursors,
input encodings, responses, resource lifetimes, and errors at 20, 44, and 100
columns. Only native pointer addresses are normalized. A successful comparison
writes `.cache/terminal-native-parity.json`, including the checked factory payload
hash and runtime information. The published API and copied single-file CLI have
their separate tests under `tui/backend/terminal.test.mjs` and
`test/tui-cli.test.ts`.

The verified Linux x64 / Node 26.4.0 run compared 369 requests, 42 complete cell
captures, 42 binary outputs, and 18 checked failures at all three widths with no
differences. Its receipt SHA-256 is
`c5f9132fb7de39b821d5ac2d64b2503e561a0214fab3c146f549ac6e14bf1b4c`.
