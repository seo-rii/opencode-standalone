# Host clipboard

The original OpenTUI `createHostClipboard` validation, destination policies,
remote-host rules and operation tracking remain unchanged. `../clipboard.mjs`
adapts its pinned backend factory to the standalone providers. Linux host
operations prefer Wayland and fall back to X11 only for unsupported operations.
Missing desktop services return `unsupported`, leaving the original OSC 52 copy
policy available.

`x11.mjs` uses Node sockets to speak the X11 wire protocol, including display
setup, MIT-MAGIC-COOKIE authentication, selection ownership, target negotiation
and incremental transfers. It supports local Unix and TCP displays. No libX11,
libxcb, xclip or xsel is loaded or executed at runtime.

`wayland.mjs` implements ext-data-control-v1 and wlr-data-control-unstable-v1.
`wayland-io.mjs` uses Node's built-in FFI with system libc for Unix sockets,
SCM_RIGHTS descriptor passing and bounded transfer pipes. It does not load
libwayland or run wl-copy/wl-paste. An explicit `waylandSeat` takes priority over
XDG_SEAT; otherwise the display must have one unambiguous seat.

Both providers read clipboard and primary selections, write Unicode text and
clear selections. Supported read preferences are text/plain, image/png,
image/jpeg, image/webp and image/gif. Image bytes retain their original MIME and
encoding, including ICC metadata. Direct reads do not decode images or apply
renderer pixel/conversion limits. Requesting PNG does not convert JPEG or BMP;
BMP-only reads remain unsupported, matching the original Linux provider.

The dispatcher bounds concurrent operations and orders writes/clears separately
for each selection. Deadlines include initialization, queued mutations and the
transfer. Cancellation and disposal abort pending operations and close owned
connections, windows and file descriptors. An idle provider does not keep the
process alive. Selection ownership lasts for the provider lifetime, as in the
original native service.

The qualified runtime is Linux x64, Node 26.4+. Wayland needs a compositor that
exposes one of the data-control protocols. WSL's separate core-data-device/BMP
compatibility path and macOS/Windows host clipboard providers remain unsupported.
The existing single-file launcher enables experimental FFI when needed.

## Development verification

Run these commands from `standalone`, using the prepared development packages:

```sh
node tui/clipboard/wayland-fixture-prepare.mjs
node --experimental-ffi --test --test-concurrency=1 tui/clipboard.test.mjs tui/clipboard/*.test.mjs
```

X11 tests need a C compiler, Xlib development headers and Xvfb on the development
PATH. `CC` and `OPENCODE_TEST_XVFB` can select those tools. The fixture creates its
own display and private authentication cookie; it never accesses the user's
desktop clipboard. Its C/Xlib client independently checks actual selection data
and ownership.

The Wayland preparation script verifies and extracts pinned development packages
under `tui/.cache/wayland-fixture`. Tests use an isolated headless Sway/wlroots
compositor and independent wl-copy/wl-paste clients. These tools stay outside the
runtime bundle. Tests do not download missing fixtures or skip missing coverage.

The clipboard controller and protocol code belong to the compiled application
graph. Renderer-only `--repack` cannot update that code. The build records a hash
of all four clipboard sources and rejects an incompatible application cache or
source changes during compilation. After changing clipboard runtime code, rebuild
the application without `--repack`; a qualified preview cache can then be packed
with `--from-tui-preview --repack`.

`host.test.mjs` copies one bundled JS into an empty directory, empties PATH and
disables native addons. It exercises the published OpenTUI APIs and the original
application clipboard adapter, actual text/images, INCR, limits, queued writes,
cancellation, deadlines and disposal. The original Session produces the OSC 52
output. `test/tui-cli.test.ts` additionally checks Ctrl+V in the actual copied CLI
through a real PTY, followed by Korean input rendering, resize and submission.
