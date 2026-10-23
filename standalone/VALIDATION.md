# Validation record

Validated on Linux x64 with Node.js **26.4.0** against OpenCode **f7577a1f65b465b35b0dcb30b23f22c14e3b5460** (2.1.2). Full upstream parity remains **false**.

The exact dist/opencode-standalone.js is **29,079,504 bytes**, 14,863,014 bytes (33.82%) smaller than the original 43,942,518-byte distribution. SHA-256:

```text
8d963c69449a2504030379ea376f86211188b701b13cf12955d73f34c395efe0
```

The matching verification receipt records **182/182 passing tests, 0 failures, 0 skips, exit 0**. Execution: 2026-10-23T12:05:14.209Z through 2026-10-23T12:07:27.982Z. Its test list includes the complete CLI, published TUI image and terminal resources, Solid component, parser, clipboard and kernel-input-flush suites. The build records 4,060 included modules and 427 public plugin/Effect module specifiers. The embedded TUI factory is 4,079,241 bytes before Brotli, 879,135 bytes compressed, SHA-256 513324093b300fcd8ac5a988dfda23d60a3b58f2208ad2533bc58bfd00926552.

Copied-artifact tests use an empty PATH, isolated HOME/XDG/database, --no-addons and no adjacent packages. They exercise:

- Both original default and mini CLI screens in a real PTY: Korean input, resizing from 100 to 44 columns, a real local streaming-provider reply and normal exit.
- The original CLI's Ctrl+V reads Korean text supplied only by an independent native Xlib clipboard owner, then resizes and submits it to the local provider.
- The default CLI's original /terminal pane opens a real shell, displays ANSI-colored Korean output, resizes from 100 to 44 columns, hides/reopens with the same shell PID and checkpoint, and cleans up after shell exit.
- Original agent/API behavior with a local provider driving read, search, edit, shell and image tools; Photon actually resizes the PNG. Server restart preserves session messages and edited files.
- Promise and Effect plugins sharing the bundled SDK/functions/schema namespaces; no installed SDK/Effect package is supplied to those fixtures.
- HTTP/WebSocket ordinary and persistent PTYs, same-PID server handoff, live/replayed Unicode, Ghostty snapshots/rows/checkpoints, resize and cleanup.
- Original browser HTML, JavaScript, CSS, service worker, fonts and WASM. Decoding this artifact's hybrid browser archive preserves every byte at all **1,688 URLs**; the historical comparison receipt and original build manifest are both checked. Brotli and identity HTTP responses are exercised through the original web handler.

Published OpenTUI classes run through real Context/Session/Scene/Yoga WASM: styled Unicode, editor history/selections/callbacks, scoped writable cell/pixel leases, native output tickets, custom paint recordings and Yoga measurements. Actual Solid components stream Markdown/code, scroll and resize, switch routes and edit the new focused input at 44/100 columns; the real parser worker is joined during cleanup. Kernel-input tests use a real PTY queue and tcflush, preserving later input.

Linux host clipboard providers use direct X11 and Wayland wire protocols. Isolated MIT-cookie Xvfb with an independent C/Xlib peer and a separate headless Sway/wlroots compositor with wl-copy/wl-paste verify actual desktop selection ownership and byte transfers; those native tools are development-only. Copied single-JS tests exercise the published clipboard APIs and original application adapter, Unicode/primary selections, image MIME preferences and ICC-preserving bytes, INCR, read limits, queued writes, operation admission, real stalled reads, deadlines, cancellation and disposal. Direct PNG/JPEG/WebP/GIF transfers preserve original bytes and are not decoded under the renderer's image limits. The original OSC 52 copy fallback remains connected through the actual Session output feed. Wayland ext/wlr data-control is implemented; WSL core-data-device compatibility remains unsupported.

macOS Pasteboard/ImageIO and Windows user32/kernel32 providers are implemented in embedded workers. On this Linux host, compiled C ABI fixtures exercise the actual FFI declarations, native memory ownership, Unicode, ordered MIME fallback, raw PNG, bounded TIFF/DIB conversion and copied-single-JS worker transport. An independent original Zig oracle matches complete PNG bytes or native errors for 161 DIB/BMP inputs. Worker regressions cover blocked calls, cancellation, full-u32 deadlines, queued mutation expiry, mutation commit and cleanup before process exit. **These fixtures do not establish actual macOS or Windows compatibility.** Native harnesses use a private named macOS pasteboard with the original ImageIO shim, or a private Windows window station; neither has been executed here. Clipboard conversion keeps upstream's 64 Mi-pixel/512 MiB limits, separate from the renderer's narrower limits. See [tui/clipboard/README.md](tui/clipboard/README.md) for platform-specific commands.

The actual EmbeddedTerminalRenderable uses OpenTUI's original EmbeddedTerminal, compositor and Ghostty VT at commit 727b8a02f8734840de664c060678dd66f01931f6, compiled into the same factory. Seventeen checked methods connect Unicode/ANSI rendering, selection, scrollback, resizing, cursor/focus, keyboard/mouse/paste encoding and terminal responses. Public widget tests run at 44/100 columns and in a copied single JS with no adjacent dependencies. Writes retain the original 1 MiB chunking and response-queue backpressure; generation-checked binary spans preserve parser state and reject stale resources. The vendor-reported version string 0.1.0-dev+b988efcf is recorded separately from its actual commit.

The image port runs the original PNG/JPEG/GIF/WebP codecs, LittleCMS ICC transforms, resize/composite operations and published NativeImage/NativeImagePool/ImageRenderable APIs. Generation-checked binary windows replace base64 image payloads; cross-reactor clones copy in 256 KiB chunks and preserve original PNG bytes, lazy state and metadata. Actual public and copied-single-file tests exercise a PNG larger than 4 MiB and 67,125,248-byte raw images, padded copies, pooled updates and memory growth with a live pixel lease. Upstream's encoded 64 MiB, decoded 100 MiB and 25-million-pixel limits remain intact. The factory grows on demand to 1 GiB with separate 256 MiB transfer windows; the independent computational proof retains its 64 MiB ceiling. See [COMPATIBILITY.md](COMPATIBILITY.md).

Persistent-terminal tests additionally verify authenticated one-use ownership, handoff/fencing/controller promotion, bounded replay, malformed inputs and actual descendant reaping with pidfds. Linux kernel 5.4+ is required; deliberately detached new sessions are outside cleanup ownership. The host's exhausted inotify quota exercises polling fallback; unconstrained native-watch behavior still needs a separate run. Git/search adapter tests do not establish full upstream equivalence.

Unicode/native computation comparisons remain development checks: 384 width cases, 6,528 wrapping cases and eight complete Context/Scene captures at widths 44/100. Native codec/ICC comparison uses a separate development oracle; no native oracle is required at runtime.

Run scoped standalone type checking and Oxlint separately. The latest canonical root bun run check completed lint with **1,250 upstream warnings and 0 errors**, then failed with unresolved @opencode/stats-core imports and a resulting Effect type error in stats-server; exit status was 1. These monorepo sources were not changed by the clipboard port. **The full upstream check has not passed.**

```sh
cd standalone
npm ci --ignore-scripts --workspaces=false
npm run build
npm run typecheck
node tui/clipboard/wayland-fixture-prepare.mjs
node tui/clipboard/image-native-prepare.mjs
npm run verify
node scripts/finalize-validation.mjs
```

The final command checks all hashes, sizes, successful counts, required test files, artifact metadata and browser-archive identity before updating these documents. It also requires .cache/size/web-equivalence.json from the historical baseline comparison and verifies each of the 1,688 decoded assets against the original build manifest. Other providers, complete browser workflows and other platforms remain unverified.
