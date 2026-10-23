import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { brotliDecompressSync } from "node:zlib"
import { alphabet, decodePayload } from "./encoding.mjs"
import { archiveFormat, decodeAssetArchive } from "../web/runtime.mjs"

const directory = fileURLToPath(new URL("../", import.meta.url))
const repository = resolve(directory, "..")
const baseline = { bytes: 43_942_518, sha256: "09793cdadc6642dd48e343d67bbbe9a4320c407e151a5901115ea7555ba2ecb8" }
const headlessBytes = 35_628_036
const publishedBytes = 37_595_298
const requiredTests = ["test/tui-cli.test.ts", "test/browser-pty.test.mjs", "test/encoding-memory.test.mjs", "test/pack.test.mjs", "web/archive.test.mjs", "tui/backend/image.test.mjs", "tui/backend/terminal.test.mjs", "tui/backend/binary.test.mjs", "tui/image/image.test.mjs", "tui/backend/production.test.mjs", "tui/backend/host.test.mjs", "tui/clipboard.test.mjs", "tui/clipboard/host.test.mjs", "tui/clipboard/x11.test.mjs", "tui/clipboard/wayland.test.mjs", "tui/clipboard/native-worker.test.mjs", "tui/clipboard/image.test.mjs", "tui/clipboard/macos.test.mjs", "tui/clipboard/windows.test.mjs", "tui/parser/parser.test.mjs"]

/** Publish documentation only after the exact complete artifact has a green receipt. */
export async function finalizeValidation() {
  const artifact = join(directory, "dist/opencode-standalone.js")
  const [upstream, report, verification, equivalence, terminalSources, webManifest, bytes] = await Promise.all([
    json("UPSTREAM.json"), json("dist/build-report.json"), json("dist/verification.json"), json(".cache/size/web-equivalence.json"), json("tui/terminal/sources.json"), json(".cache/web/manifest.json"), readFile(artifact),
  ])
  assert.match(upstream.commit, /^[a-f0-9]{40}$/, "UPSTREAM.json must pin a complete source commit")
  for (const field of ["repository", "sourceVersion", "distributionVersion"]) assert.ok(typeof upstream[field] === "string" && upstream[field].length > 0, `UPSTREAM.json is missing ${field}`)
  assert.equal(report.upstream, upstream.commit, "Build source does not match UPSTREAM.json")
  assert.equal(report.artifact, basename(artifact), "Build receipt names a different artifact")
  assert.equal(verification.artifact, basename(artifact), "Verification names a different artifact")
  const sha256 = hash(bytes)
  assert.equal(report.sha256, sha256, "Actual artifact SHA-256 differs from the build receipt")
  assert.equal(verification.sha256, sha256, "Actual artifact SHA-256 differs from verification")
  assert.equal(report.bytes, bytes.length, "Actual artifact size differs from the build receipt")
  assert.equal(verification.bytes, bytes.length, "Actual artifact size differs from verification")
  assert.equal(verification.exitCode, 0, "Verification must exit successfully")
  assert.equal(verification.signal, null, "Verification must finish without a terminating signal")
  const counts = verification.counts
  assert.ok(Number.isSafeInteger(counts?.tests) && counts.tests > 0, "Verification must execute tests")
  assert.equal(counts.pass, counts.tests, "Every executed test must pass")
  assert.equal(counts.fail, 0, "Verification contains failures")
  assert.equal(counts.skipped, 0, "Verification contains skipped tests")
  assert.equal(verification.fullParity, false, "The receipt must preserve the incomplete-parity status")
  assert.equal(verification.platform, "linux", "These documents describe validation on Linux")
  assert.equal(verification.arch, "x64", "These documents describe validation on x64")
  assert.match(verification.node, /^v\d+\.\d+\.\d+/, "Verification must identify its Node runtime")
  assert.ok(Number.isFinite(Date.parse(verification.started)) && Date.parse(verification.finished) >= Date.parse(verification.started), "Verification timestamps are incomplete")
  assert.ok(Array.isArray(verification.tests), "Verification must list its test files")
  for (const file of requiredTests) assert.ok(verification.tests.includes(file), `Verification did not run ${file}`)
  assert.ok(Array.isArray(report.modules) && report.modules.length > 0, "Build must list its included modules")
  assert.ok(Array.isArray(report.pluginModules) && report.pluginModules.length > 0, "Build must list its public plugin modules")
  assert.equal(report.external, "Node.js built-in modules only", "Build contains a different runtime dependency profile")
  const factory = report.tui?.factoryWasm
  assert.ok(Number.isSafeInteger(factory?.bytes) && factory.bytes > 0, "Build must contain the actual TUI factory WASM")
  assert.ok(Number.isSafeInteger(factory.compressedBytes) && factory.compressedBytes > 0, "Build must record the compressed TUI factory")
  assert.match(factory.sha256, /^[a-f0-9]{64}$/, "Build must record the TUI factory SHA-256")
  assert.deepEqual(report.tui.embeddedTerminal, terminalSources, "Embedded terminal source pins differ from the build receipt")
  assert.deepEqual(report.tui.hostClipboard, { platforms: { linux: ["x11", "wayland"], darwin: ["macos"], win32: ["windows"] }, nativeWorkerEmbedded: true }, "Build does not record the desktop clipboard providers")
  assert.match(report.compilation?.hostClipboardSourceSha256, /^[a-f0-9]{64}$/, "Build must identify the compiled host clipboard sources")
  const webSources = await Promise.all(["web/assets.ts", "web/runtime.mjs"].map(async (file) => [file, hash(await readFile(join(directory, file)))]))
  assert.equal(report.compilation?.webAssetSourceSha256, hash(JSON.stringify(webSources)), "Browser archive decoder changed after compilation")
  for (const name of ["app", "pty", "daemon", "tui", "licenses", "web"]) {
    const record = report.payloads?.[name]
    for (const field of ["offset", "length", "storedBytes", "bytes"]) assert.ok(Number.isSafeInteger(record?.[field]) && record[field] >= 0, `Invalid ${name} payload ${field}`)
    assert.ok(record.bytes > 0 && record.length > 0, `Empty ${name} payload`)
    assert.equal(record.encoding, `base${alphabet.length}`, `Unsupported ${name} payload encoding`)
    assert.equal(typeof record.brotli, "boolean", `Invalid ${name} compression flag`)
  }

  // The historical receipt chains every original URL and byte to the new format.
  assert.equal(equivalence.baselineSha256, baseline.sha256, "Browser comparison belongs to a different baseline")
  assert.equal(equivalence.identical, true, "Browser equivalence was not established")
  assert.equal(equivalence.format, archiveFormat, "Browser comparison uses a different archive format")
  assert.equal(webManifest.archive.format, archiveFormat, "Browser manifest uses a different archive format")
  assert.equal(equivalence.assetsCompared, 1688, "Browser equivalence must cover all original URLs")
  assert.equal(equivalence.baselineArchiveBytes, 27_101_364, "Browser comparison has a different original archive size")
  const base = bytes.subarray(0, 16_384).toString("ascii").match(/const base = Number\("(\d{10})"\);/)
  assert.ok(base, "Packed artifact does not expose its checked payload offset")
  const web = report.payloads.web
  const start = Number(base[1]) + web.offset
  assert.ok(start >= Number(base[1]) && start + web.length <= bytes.length, "Browser payload exceeds the artifact")
  const stored = decodePayload(bytes.subarray(start, start + web.length), web.storedBytes, alphabet)
  const archive = web.brotli ? brotliDecompressSync(stored) : stored
  assert.equal(archive.length, web.bytes, "Decoded browser payload size differs from the build receipt")
  assert.equal(archive.length, equivalence.newArchiveBytes, "Browser archive size differs from the comparison receipt")
  assert.equal(hash(archive), equivalence.newArchiveSha256, "Browser archive differs from the byte-preserved comparison")
  const browser = decodeAssetArchive(archive)
  assert.equal(Object.keys(browser.files).length, 1688, "Actual browser archive does not contain 1,688 URLs")
  assert.deepEqual(Object.keys(browser.files).sort(), webManifest.files.map((file) => file.path).sort(), "Browser URLs differ from the build manifest")
  for (const file of webManifest.files) {
    const body = Buffer.from(browser.files[file.path])
    assert.equal(body.length, file.bytes, `Browser byte count changed: ${file.path}`)
    assert.equal(hash(body), file.sha256, `Browser content changed: ${file.path}`)
  }

  // This header command returns before application boot, FFI or user configuration.
  const info = spawnSync(process.execPath, ["--no-addons", artifact, "--standalone-info"], {
    cwd: directory, env: { PATH: "", NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  })
  assert.equal(info.error, undefined, "Could not run artifact metadata command")
  assert.equal(info.status, 0, `Artifact metadata command failed: ${info.stderr}`)
  const metadata = JSON.parse(info.stdout)
  assert.equal(metadata.name, "opencode-standalone")
  assert.equal(metadata.upstream, upstream.commit)
  assert.equal(metadata.interactiveTui, true, "Artifact does not enable the actual interactive TUI")
  assert.equal(metadata.miniTui, true, "Artifact does not enable the actual mini TUI")
  assert.equal(metadata.embeddedTerminal, true, "Artifact does not enable the actual embedded terminal")
  assert.equal(metadata.hostClipboard, true, "Artifact does not enable the actual host clipboard")
  assert.equal(metadata.fullParity, false, "Artifact must not claim full upstream parity")
  assert.equal(metadata.browserAssets, true, "Artifact does not include the browser assets")
  assert.equal(metadata.embeddedWasm, true, "Artifact does not embed its WASM")

  const n = (value) => value.toLocaleString("en-US")
  const compared = (reference) => `${n(Math.abs(reference - bytes.length))} bytes (${(Math.abs(reference - bytes.length) / reference * 100).toFixed(2)}%) ${bytes.length <= reference ? "smaller" : "larger"}`
  const koreanSize = `${(Math.abs(baseline.bytes - bytes.length) / baseline.bytes * 100).toFixed(2)}% ${bytes.length <= baseline.bytes ? "감소" : "증가"}`
  const node = verification.node.slice(1)
  const payloadRows = Object.entries(report.payloads).map(([name, record]) => `| ${name} | ${n(record.bytes)} | ${n(record.storedBytes)} | ${n(record.length)} |`).join("\n")
  const commitURL = `${upstream.repository.replace(/\.git$/, "")}/tree/${upstream.commit}`
  const documents = new Map([
    [join(repository, "README.standalone.md"), `# opencode-standalone

OpenCode를 **런타임 npm 설치 없이 실행하는 단일 JavaScript 파일**로 만드는 실험적 포크입니다. Node.js 26.4 이상에서 실행하며, 기본 TUI·mini TUI·에이전트·HTTP API·웹 앱과 필요한 JS/WASM을 파일 안에 포함합니다.

**원본과의 완전한 기능 호환성은 아직 달성하지 못했습니다.** 검증 플랫폼은 Linux x64입니다. 지원 범위와 이미지 크기·클립보드·오디오·Git·검색 등의 제한은 [호환성 표](standalone/COMPATIBILITY.md)에 기록합니다.

기준 소스는 OpenCode [${upstream.commit.slice(0, 7)}](${commitURL}), 소스 버전 ${upstream.sourceVersion}, 배포 버전 ${upstream.distributionVersion}입니다. 업스트림 소스를 보존하고 변환과 대체 구현을 standalone/에 모았습니다.

## 빌드와 실행

\`\`\`sh
cd standalone
npm ci --ignore-scripts --workspaces=false
npm run build
node dist/opencode-standalone.js --standalone-info
node dist/opencode-standalone.js
node dist/opencode-standalone.js mini
node dist/opencode-standalone.js serve --hostname 127.0.0.1 --port 4096
node dist/opencode-standalone.js run --standalone -m provider/model "요청 내용"
\`\`\`

빌드에는 개발 의존성과 컴파일 도구가 필요합니다. 배포할 때는 dist/opencode-standalone.js 하나만 복사합니다. 모델 인증·설정은 원본 방식을 따르며, 실험적 Node 내장 FFI가 필요하면 런처가 같은 Node를 --experimental-ffi로 다시 실행합니다. --standalone-licenses로 포함된 고지를 확인할 수 있습니다.

현재 검증 파일은 **${n(bytes.length)}바이트 (${(bytes.length / 1_000_000).toFixed(2)} MB)**이며, 최초 ${n(baseline.bytes)}바이트 대비 **${koreanSize}**했습니다. 정확히 이 파일이 **${n(counts.pass)}/${n(counts.tests)}개 테스트**, 실패·건너뜀 0개를 통과했습니다. [검증 기록](standalone/VALIDATION.md)과 [용량 기록](standalone/SIZE.md)에 SHA-256과 내역을 기록합니다.

## 구현

| 원본 의존성 | 이 포크의 구현 |
| --- | --- |
| Bun·패키지 런타임 | Node 조건, 파일·스트림 변환, 임베딩된 JS 모듈 |
| SQLite | 원본 node:sqlite 어댑터와 마이그레이션 |
| tree-sitter·Photon | 실제 파서·이미지 JS/WASM을 메모리에서 초기화 |
| ripgrep·FFF·Git | JS 탐색·RE2JS·fuzzy fallback과 isomorphic-git 기반 구현 |
| 파일 감시 | 디렉터리별 fs.watch와 OS 한도 초과 시 폴링 |
| 일반·지속형 PTY | 내장 FFI·OS libc, 같은 파일의 보조 프로세스·프로토콜 7 데몬·Ghostty WASM |
| OpenTUI·Solid | 실제 배포된 JavaScript 클래스·Solid 화면·파서 작업 스레드와 원본 Context/Scene/Yoga의 WASM 연결 |
| TUI 이미지 | 실제 PNG/JPEG/GIF/WebP·ICC·리사이즈 코드를 임베딩한 WASM, NativeImage/ImageRenderable·픽셀 대여 연결 |
| TUI 내장 터미널 | 원본 OpenTUI가 고정한 Ghostty VT를 WASM으로 컴파일하고 실제 EmbeddedTerminalRenderable·지속형 PTY에 연결 |
| OS 클립보드 | Linux X11·Wayland, macOS Pasteboard·ImageIO, Windows Win32·DIB 변환으로 텍스트·이미지 읽기와 텍스트 복사·지우기; 외부 클립보드 명령 없이 동작 |
| 브라우저 자산 | 원본 웹 빌드의 ${n(equivalence.assetsCompared)}개 URL·파일 바이트를 보존한 아카이브 |

기본·mini CLI는 파일 하나를 빈 디렉터리에 복사하고 PATH를 비운 실제 PTY에서 한글 입력, 100→44열 크기 변경, 로컬 모델 응답과 정상 종료를 검증합니다. 실제 Solid 화면의 스트리밍 Markdown·코드 강조·스크롤·화면 전환 후 편집도 44/100열에서 검사합니다. 운영 API 키와 외부 모델 서비스는 테스트에 사용하지 않습니다.

기본 TUI에서 \`/terminal\`로 실제 셸을 열 수 있습니다. 같은 복사 파일의 테스트에서 한글·ANSI 색상 출력, 100→44열 크기 변경, 터미널 숨김·재열기 후 같은 셸 PID와 화면 복원, 셸 종료 후 정리까지 확인합니다.

Linux 데스크톱에서는 OS 클립보드에서 텍스트·이미지를 읽고 텍스트를 복사할 수 있습니다. X11은 직접 소켓 프로토콜을 사용하고 Wayland는 ext/wlr data-control과 내장 FFI·libc로 파일 디스크립터를 전달합니다. \`xclip\`·\`wl-copy\` 등의 추가 실행 파일은 필요하지 않습니다. 실제 CLI의 Ctrl+V 한글 붙여넣기와, 별도 X 서버·compositor 및 독립 네이티브 클라이언트 사이의 양방향 전송을 검증합니다. 디스플레이가 없는 환경에서는 원본 정책의 OSC 52 복사 경로를 유지합니다.

macOS는 Pasteboard·ImageIO, Windows는 user32·kernel32를 내장 FFI로 호출하는 클립보드 구현을 추가했습니다. 워커 코드도 JS 파일 안에 포함하며, 텍스트·PNG 읽기, 텍스트 쓰기·지우기와 TIFF/DIB→PNG 변환을 처리합니다. Linux에서 실제 FFI와 C ABI 검증 도구, 원본 Zig와의 DIB 변환 비교를 통과했습니다. **실제 macOS·Windows 실행은 아직 검증하지 않았으며**, 해당 OS에서 실행할 독립 검증 도구를 포함했습니다. 일반 PTY 등 다른 플랫폼 어댑터의 미구현 범위는 그대로 남아 있습니다.

## 검증

\`\`\`sh
cd standalone
npm run typecheck
npm test
npm run verify
\`\`\`

OS 클립보드 개발 검증에는 Xvfb·C 컴파일러·Xlib 개발 헤더가 필요하며, Wayland fixture는 \`node tui/clipboard/wayland-fixture-prepare.mjs\`로 .cache에 준비합니다. 이 도구들은 배포 파일의 런타임 의존성이 아닙니다. 자세한 절차는 [클립보드 문서](standalone/tui/clipboard/README.md)에 있습니다.

정확한 결과는 dist/build-report.json과 dist/verification.json에 있습니다. 전체 업스트림 검사인 루트 bun run check는 아직 통과하지 못했습니다. 사용자 플러그인·MCP 서버·언어 서버·포매터·셸 도구의 추가 실행 파일까지 자동으로 포함하지는 않습니다. 남은 플랫폼·기능 제한은 [호환성 표](standalone/COMPATIBILITY.md)에 기록합니다.
`],
    [join(directory, "VALIDATION.md"), `# Validation record

Validated on Linux x64 with Node.js **${node}** against OpenCode **${upstream.commit}** (${upstream.sourceVersion}). Full upstream parity remains **false**.

The exact dist/opencode-standalone.js is **${n(bytes.length)} bytes**, ${compared(baseline.bytes)} than the original ${n(baseline.bytes)}-byte distribution. SHA-256:

\`\`\`text
${sha256}
\`\`\`

The matching verification receipt records **${n(counts.pass)}/${n(counts.tests)} passing tests, 0 failures, 0 skips, exit 0**. Execution: ${verification.started} through ${verification.finished}. Its test list includes the complete CLI, published TUI image and terminal resources, Solid component, parser, clipboard and kernel-input-flush suites. The build records ${n(report.modules.length)} included modules and ${n(report.pluginModules.length)} public plugin/Effect module specifiers. The embedded TUI factory is ${n(factory.bytes)} bytes before Brotli, ${n(factory.compressedBytes)} bytes compressed, SHA-256 ${factory.sha256}.

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

The actual EmbeddedTerminalRenderable uses OpenTUI's original EmbeddedTerminal, compositor and Ghostty VT at commit ${terminalSources.ghostty.commit}, compiled into the same factory. Seventeen checked methods connect Unicode/ANSI rendering, selection, scrollback, resizing, cursor/focus, keyboard/mouse/paste encoding and terminal responses. Public widget tests run at 44/100 columns and in a copied single JS with no adjacent dependencies. Writes retain the original 1 MiB chunking and response-queue backpressure; generation-checked binary spans preserve parser state and reject stale resources. The vendor-reported version string ${terminalSources.ghostty.reportedVersion} is recorded separately from its actual commit.

The image port runs the original PNG/JPEG/GIF/WebP codecs, LittleCMS ICC transforms, resize/composite operations and published NativeImage/NativeImagePool/ImageRenderable APIs. Generation-checked binary windows replace base64 image payloads; cross-reactor clones copy in 256 KiB chunks and preserve original PNG bytes, lazy state and metadata. Actual public and copied-single-file tests exercise a PNG larger than 4 MiB and 67,125,248-byte raw images, padded copies, pooled updates and memory growth with a live pixel lease. Upstream's encoded 64 MiB, decoded 100 MiB and 25-million-pixel limits remain intact. The factory grows on demand to 1 GiB with separate 256 MiB transfer windows; the independent computational proof retains its 64 MiB ceiling. See [COMPATIBILITY.md](COMPATIBILITY.md).

Persistent-terminal tests additionally verify authenticated one-use ownership, handoff/fencing/controller promotion, bounded replay, malformed inputs and actual descendant reaping with pidfds. Linux kernel 5.4+ is required; deliberately detached new sessions are outside cleanup ownership. The host's exhausted inotify quota exercises polling fallback; unconstrained native-watch behavior still needs a separate run. Git/search adapter tests do not establish full upstream equivalence.

Unicode/native computation comparisons remain development checks: 384 width cases, 6,528 wrapping cases and eight complete Context/Scene captures at widths 44/100. Native codec/ICC comparison uses a separate development oracle; no native oracle is required at runtime.

Run scoped standalone type checking and Oxlint separately. The latest canonical root bun run check completed lint with **1,250 upstream warnings and 0 errors**, then failed with unresolved @opencode/stats-core imports and a resulting Effect type error in stats-server; exit status was 1. These monorepo sources were not changed by the clipboard port. **The full upstream check has not passed.**

\`\`\`sh
cd standalone
npm ci --ignore-scripts --workspaces=false
npm run build
npm run typecheck
node tui/clipboard/wayland-fixture-prepare.mjs
node tui/clipboard/image-native-prepare.mjs
npm run verify
node scripts/finalize-validation.mjs
\`\`\`

The final command checks all hashes, sizes, successful counts, required test files, artifact metadata and browser-archive identity before updating these documents. It also requires .cache/size/web-equivalence.json from the historical baseline comparison and verifies each of the 1,688 decoded assets against the original build manifest. Other providers, complete browser workflows and other platforms remain unverified.
`],
    [join(directory, "SIZE.md"), `# Distribution size

The complete verified file is **${n(bytes.length)} bytes**, ${compared(baseline.bytes)} than the original **${n(baseline.bytes)} bytes** (SHA-256 ${baseline.sha256}), and ${compared(publishedBytes)} than the first public **${n(publishedBytes)}-byte** distribution. Compared with the earlier **${n(headlessBytes)}-byte headless checkpoint**, it is ${compared(headlessBytes)}; it includes the actual default/mini TUI, Solid, parser worker, native image/ICC resources, embedded Ghostty terminal and desktop clipboard protocols. Its current SHA-256 is ${sha256}.

The application is minified with keepNames enabled, Brotli-compressed with a 16 MiB window and stored as comment-safe **${report.payloads.app.encoding}**. This shares repeated parser resources without changing the JavaScript or function names. The TUI factory has an independent compressed module inside the same JS file; it is not a second distribution file. Standard Node APIs decode the selected payload without extracting modules, WASM, addons or browser assets.

| Payload | Input bytes | Stored bytes | ASCII bytes |
| --- | ---: | ---: | ---: |
${payloadRows}

Input sizes describe modules or the hybrid browser archive before outer packing. Related JavaScript, text and raw fonts share Brotli quality 11 groups, each limited to 32 MiB before compression. Office WASM and already compressed media keep individual Brotli payloads. Identical assets share storage. The browser archive shrank from **${n(equivalence.baselineArchiveBytes)}** to **${n(equivalence.newArchiveBytes)} bytes**; the original ${n(equivalence.assetsCompared)} URLs and every decompressed byte were preserved. The current packed archive decodes to SHA-256 ${equivalence.newArchiveSha256}.

Groups are decompressed on demand with a 48 MiB cache. Brotli HTTP responses for grouped assets are generated at quality 4 and cached up to 8 MiB; requests without Brotli read the original bytes directly. The original web handler retains content types, CSP, caching and encoding negotiation. Web assets remain unloaded during CLI startup. Larger application windows and browser caches trade some runtime memory for the smaller distribution.

The file retains the original Office WASM, fonts, browser code and all tested runtime features. Image/ICC and embedded-terminal vendor code is embedded WASM; system libc supplies host PTYs and input flushing. Larger compressed builds can take longer; their development tools are not runtime npm dependencies.

From standalone/, scripts/size-benchmark.mjs compares application compression/encoding and web/benchmark.mjs samples browser Brotli qualities. These measurements write under .cache; use private redirected logs for long runs. [VALIDATION.md](VALIDATION.md) records the matching successful tests, and dist/build-report.json contains the exact module/payload manifest.
`],
    [join(directory, "COMPATIBILITY.md"), `# Compatibility

This experimental fork pins OpenCode ${upstream.sourceVersion} at ${upstream.commit}. **Full upstream parity is not achieved.** The validated runtime is Linux x64, Node.js ${node}; module compilation alone is not evidence of feature or platform parity.

| Area | Implementation and current limits |
| --- | --- |
| Distribution | One JS file containing compressed JS/WASM/assets, ${report.payloads.app.encoding} storage and preserved function names. Built-in graph imports only Node built-ins; no extracted addon/WASM files or runtime npm installation. |
| CLI / agent / API | Original upstream default/mini TUI, agent and server with host adapters. Actual copied-CLI Korean input/resize/local reply/exit is tested; other providers, auth methods, ACP and remote workflows need additional coverage. |
| OpenTUI / Solid / parser | Published OpenTUI 0.6.6 classes and Solid components use the real WASM Context/Session/Scene/Yoga/editor/buffers. Actual embedded tree-sitter worker/grammars, syntax highlighting, measurements, recording, selections and output tickets are exercised. |
| TUI images / ICC | Original PNG/JPEG/GIF/WebP, LittleCMS2, resize/composite and NativeImage/NativeImagePool/ImageRenderable. Generation-checked binary transfer preserves exact snapshots and scoped pixel leases; >64 MiB raw images and >4 MiB PNGs are tested. Upstream encoded 64 MiB/decoded 100 MiB, 25-million-pixel and 16,384-dimension limits remain intact. Factory memory grows on demand to 1 GiB; input/output windows are each bounded to 256 MiB. Extreme padding and aggregate memory can exceed these budgets and reject explicitly. |
| Embedded terminal | Original EmbeddedTerminalRenderable and compositor backed by OpenTUI's pinned Ghostty ${terminalSources.ghostty.commit} in factory WASM. Unicode/ANSI, selection, scrollback, cursor, resize and keyboard/mouse/paste/focus/response encoding are connected. Actual /terminal shell, same-PID hide/reopen, narrow resize and exit are tested. Original direct-only Kitty limits remain; the original compositor does not draw Kitty image placements. |
| Host clipboard | Linux X11/Wayland, macOS Pasteboard/ImageIO and Windows user32/kernel32 implementations; only Node built-ins and OS system libraries at runtime. Native worker code is embedded in the one JS. Linux desktop servers, native clients and actual CLI Ctrl+V are tested; macOS/Windows use actual FFI with C ABI fixtures on Linux and still need native OS qualification. Text/PNG read, text write/clear, limits, cancellation and mutation commit are connected. Linux additionally preserves primary and JPEG/WebP/GIF bytes. macOS TIFF and Windows DIB convert to bounded PNG; DIB matches the original Zig byte for byte. macOS/Windows primary remains unsupported as upstream. WSL core-data-device and compositors without data-control remain gaps. OSC 52 copy fallback is preserved. |
| Audio | Built-in sound bytes are embedded; native audio-device playback is unsupported. |
| Database / shell tools | Original node:sqlite adapter and embedded migrations; upstream Node v1 migration remains a no-op. Actual tree-sitter Bash/PowerShell and Photon are embedded. User shell programs remain environmental inputs. |
| Search | JS walk + RE2JS with local/global Git ignores and info/exclude. Rust-regex Unicode/syntax and FFF ranking differ; remote search rejects. Conditional Git includes and per-worktree/injected config remain incomplete. |
| Watching | Per-directory fs.watch with inode reconciliation and polling on EMFILE/ENOSPC; config watching also has a polling fallback. Large-tree and unconstrained native-event behavior need further measurements. |
| Git | SHA-1 objects/indexes, local discovery, snapshots/diff/restore and HTTP via isomorphic-git. SSH, credential helpers, SHA-256 and split/sparse indexes are unsupported; differential coverage is incomplete. |
| Ordinary PTY / host input | Actual controlling terminal, input, resize, signals/reaping and tcflush via built-in FFI and system libc. Linux x64 tested; arm64 unverified; macOS/Windows implementations reject explicitly. |
| Persistent PTY | Same-file Linux 5.4+ protocol 7 daemon with authenticated ownership/handoff, bounded replay, real Ghostty screen/rows and pidfd cleanup. Ghostty revision differs from upstream; foreground metadata uses the process-group leader. Detached new sessions are outside cleanup ownership. |
| Browser | Complete original archive, including service worker, Office assets/fonts/Ghostty. All ${n(equivalence.assetsCompared)} URLs and original decompressed bytes are preserved. Asset serving is tested; complete browser workflow parity is unverified. |
| Plugins / extensions | Public Effect/plugin modules share bundled namespaces; isolated Promise/Effect activation is tested. Opt-in side effects and untested extension/provider combinations remain gaps. User plugins, MCP/LSP servers, formatters and tools can require external packages/executables. |
| Updates | Automatic install/update and uninstall are explicitly unavailable. Replace the artifact with a newly verified build. |

--standalone-info reports interactiveTui, miniTui, embeddedTerminal and hostClipboard true, **fullParity false**. dist/build-report.json and dist/verification.json identify the exact file; neither is a runtime dependency. Node's FFI still uses OS system libraries. Other platforms, provider/browser workflows and the remaining Git/search/extension differences need further work. See the [validation record](VALIDATION.md) for completed checks and the [clipboard documentation](tui/clipboard/README.md) for native platform qualification commands.
`],
  ])

  // Every validation and every complete document is prepared before the first write.
  for (const [file, content] of documents) await writeFile(file, content)
  console.log(JSON.stringify({ artifact: basename(artifact), bytes: bytes.length, sha256, tests: counts.tests, documents: [...documents.keys()].map((file) => file.slice(repository.length + 1)) }))
}

async function json(file) { return JSON.parse(await readFile(join(directory, file), "utf8")) }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex") }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await finalizeValidation()
