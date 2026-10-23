# Host clipboard

The original OpenTUI `createHostClipboard` validation, destination policies,
remote-host rules and operation tracking remain unchanged. `../clipboard.mjs`
adapts its pinned backend factory to the standalone providers. Linux host
operations prefer Wayland and fall back to X11 only for unsupported operations.
Missing desktop services return `unsupported`, leaving the original OSC 52 copy
policy available.

The dispatcher also selects `macos.mjs` on macOS and `windows.mjs` on Windows.
These providers call OS system libraries through built-in Node FFI in an embedded
worker. No pbcopy/pbpaste, PowerShell, native addon or extracted helper is needed.

| Platform | Native implementation | Verification performed here |
| --- | --- | --- |
| Linux | X11 and Wayland clipboard/primary, text and PNG/JPEG/WebP/GIF bytes | Actual isolated desktop servers, independent clients and CLI Ctrl+V |
| macOS x64/arm64 | Pasteboard text/PNG, bounded ImageIO TIFF→PNG, text write/clear | Real FFI against a compiled C ABI fixture on Linux; native macOS run pending |
| Windows x64/arm64 | Win32 Unicode/CRLF, registered PNG, bounded DIB/DIBV5→PNG, text write/clear | Real FFI against a compiled C ABI fixture on Linux; native Windows run pending |

macOS/Windows follow the original provider's text/plain and image/png preferences;
PRIMARY is unsupported there. Clipboard conversion retains the original 64 Mi-pixel
and 512 MiB conversion limits. Direct PNG bytes bypass conversion limits, as in
upstream. `image.mjs` ports the original DIB/BMP converter, including its supported
headers, RGB/bitfields/alpha, orientation, padding and explicit unsupported formats.
It matches the original Zig converter's whole PNG bytes or error for 161 inputs.

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
compatibility path remains unsupported. macOS/Windows clipboard implementations
still need actual OS qualification; the complete application also retains other
platform gaps, including ordinary and persistent PTYs.
The existing single-file launcher enables experimental FFI when needed.

`native-worker.mjs` bounds queued and retained native calls and serializes them on
one native thread. Shared atomic state arbitrates cancellation/deadlines against
the mutation commit point. A write committed before cancellation reports its
actual result. An OS call that is already blocked may finish later; its slot stays
occupied until the reply, and disposal awaits native cleanup. Idle workers are
unreferenced only while no disposal is pending. `scripts/clipboard-workers.mjs`
bundles all worker code into strings inside the one JS, with only Node built-ins
external.

## Development verification

Run these commands from `standalone`, using the prepared development packages:

```sh
node tui/clipboard/wayland-fixture-prepare.mjs
node tui/clipboard/image-native-prepare.mjs
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
of the providers, native worker engines, converter and embedding code, and rejects an incompatible application cache or
source changes during compilation. After changing clipboard runtime code, rebuild
the application without `--repack`; a qualified preview cache can then be packed
with `--from-tui-preview --repack`.

`host.test.mjs` copies one bundled JS into an empty directory, empties PATH and
disables native addons. It exercises the published OpenTUI APIs and the original
application clipboard adapter, actual text/images, INCR, limits, queued writes,
cancellation, deadlines and disposal. The original Session produces the OSC 52
output. `test/tui-cli.test.ts` additionally checks Ctrl+V in the actual copied CLI
through a real PTY, followed by Korean input rendering, resize and submission.

The macOS and Windows Linux tests compile small C libraries that implement the
native ABI and enforce memory/handle ownership. The actual FFI declarations and
bundled worker execute against those libraries. These are ABI fixtures, not a
substitute for the real OS. They are development-only and are never embedded.

For native qualification, run from `standalone` on the matching OS after preparing
development dependencies and the pinned upstream source:

```sh
# macOS: requires the Xcode command-line tools for the independent ObjC oracle.
node --experimental-ffi tui/clipboard/macos-native-proof.mjs

# Windows: bundles and runs the actual Win32 proof in a private window station.
node --experimental-ffi --test tui/clipboard/windows.test.mjs
```

The macOS harness uses a private named pasteboard and compares TIFF conversion
with the pinned original Objective-C shim. Windows uses a private window station
and desktop with an independent Win32 owner. Both avoid the user's clipboard.
Neither native harness has been executed in this Linux environment.
