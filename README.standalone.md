# opencode-standalone

OpenCode를 **런타임 npm 설치 없이 실행하는 단일 JavaScript 파일**로 만드는 실험적 포크입니다. Node.js 26.4 이상에서 실행하며, 기본 TUI·mini TUI·에이전트·HTTP API·웹 앱과 필요한 JS/WASM을 파일 안에 포함합니다.

**원본과의 완전한 기능 호환성은 아직 달성하지 못했습니다.** 검증 플랫폼은 Linux x64입니다. 지원 범위와 이미지 크기·클립보드·오디오·Git·검색 등의 제한은 [호환성 표](standalone/COMPATIBILITY.md)에 기록합니다.

기준 소스는 OpenCode [f7577a1](https://github.com/anomalyco/opencode/tree/f7577a1f65b465b35b0dcb30b23f22c14e3b5460), 소스 버전 2.1.2, 배포 버전 2.1.2-standalone.1입니다. 업스트림 소스를 보존하고 변환과 대체 구현을 standalone/에 모았습니다.

## 빌드와 실행

```sh
cd standalone
npm ci --ignore-scripts --workspaces=false
npm run build
node dist/opencode-standalone.js --standalone-info
node dist/opencode-standalone.js
node dist/opencode-standalone.js mini
node dist/opencode-standalone.js serve --hostname 127.0.0.1 --port 4096
node dist/opencode-standalone.js run --standalone -m provider/model "요청 내용"
```

빌드에는 개발 의존성과 컴파일 도구가 필요합니다. 배포할 때는 dist/opencode-standalone.js 하나만 복사합니다. 모델 인증·설정은 원본 방식을 따르며, 실험적 Node 내장 FFI가 필요하면 런처가 같은 Node를 --experimental-ffi로 다시 실행합니다. --standalone-licenses로 포함된 고지를 확인할 수 있습니다.

현재 검증 파일은 **29,079,504바이트 (29.08 MB)**이며, 최초 43,942,518바이트 대비 **33.82% 감소**했습니다. 정확히 이 파일이 **182/182개 테스트**, 실패·건너뜀 0개를 통과했습니다. [검증 기록](standalone/VALIDATION.md)과 [용량 기록](standalone/SIZE.md)에 SHA-256과 내역을 기록합니다.

## 라이트 버전

CLI·기본/mini TUI·에이전트·API·터미널·클립보드를 사용하는 경우 `npm run build:lite`로 브라우저 UI 에셋을 제외할 수 있습니다. 결과는 `dist/lite/opencode-standalone.js`에 따로 생성되고, `npm run verify:lite`로 검증합니다. 기본 `npm run build`는 웹 UI를 포함한 전체 버전입니다.

라이트의 HTTP API는 유지되며, 브라우저 화면·서비스 워커·웹 Office 미리보기와 폰트는 제외되어 UI 요청에 404를 반환합니다. 포함 범위·크기·실행 명령은 [라이트 문서](standalone/LITE.md)에 있습니다.

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
| 브라우저 자산 | 원본 웹 빌드의 1,688개 URL·파일 바이트를 보존한 아카이브 |

기본·mini CLI는 파일 하나를 빈 디렉터리에 복사하고 PATH를 비운 실제 PTY에서 한글 입력, 100→44열 크기 변경, 로컬 모델 응답과 정상 종료를 검증합니다. 실제 Solid 화면의 스트리밍 Markdown·코드 강조·스크롤·화면 전환 후 편집도 44/100열에서 검사합니다. 운영 API 키와 외부 모델 서비스는 테스트에 사용하지 않습니다.

기본 TUI에서 `/terminal`로 실제 셸을 열 수 있습니다. 같은 복사 파일의 테스트에서 한글·ANSI 색상 출력, 100→44열 크기 변경, 터미널 숨김·재열기 후 같은 셸 PID와 화면 복원, 셸 종료 후 정리까지 확인합니다.

Linux 데스크톱에서는 OS 클립보드에서 텍스트·이미지를 읽고 텍스트를 복사할 수 있습니다. X11은 직접 소켓 프로토콜을 사용하고 Wayland는 ext/wlr data-control과 내장 FFI·libc로 파일 디스크립터를 전달합니다. `xclip`·`wl-copy` 등의 추가 실행 파일은 필요하지 않습니다. 실제 CLI의 Ctrl+V 한글 붙여넣기와, 별도 X 서버·compositor 및 독립 네이티브 클라이언트 사이의 양방향 전송을 검증합니다. 디스플레이가 없는 환경에서는 원본 정책의 OSC 52 복사 경로를 유지합니다.

macOS는 Pasteboard·ImageIO, Windows는 user32·kernel32를 내장 FFI로 호출하는 클립보드 구현을 추가했습니다. 워커 코드도 JS 파일 안에 포함하며, 텍스트·PNG 읽기, 텍스트 쓰기·지우기와 TIFF/DIB→PNG 변환을 처리합니다. Linux에서 실제 FFI와 C ABI 검증 도구, 원본 Zig와의 DIB 변환 비교를 통과했습니다. **실제 macOS·Windows 실행은 아직 검증하지 않았으며**, 해당 OS에서 실행할 독립 검증 도구를 포함했습니다. 일반 PTY 등 다른 플랫폼 어댑터의 미구현 범위는 그대로 남아 있습니다.

## 검증

```sh
cd standalone
npm run typecheck
npm test
npm run verify
```

OS 클립보드 개발 검증에는 Xvfb·C 컴파일러·Xlib 개발 헤더가 필요하며, Wayland fixture는 `node tui/clipboard/wayland-fixture-prepare.mjs`로 .cache에 준비합니다. 이 도구들은 배포 파일의 런타임 의존성이 아닙니다. 자세한 절차는 [클립보드 문서](standalone/tui/clipboard/README.md)에 있습니다.

정확한 결과는 dist/build-report.json과 dist/verification.json에 있습니다. 전체 업스트림 검사인 루트 bun run check는 아직 통과하지 못했습니다. 사용자 플러그인·MCP 서버·언어 서버·포매터·셸 도구의 추가 실행 파일까지 자동으로 포함하지는 않습니다. 남은 플랫폼·기능 제한은 [호환성 표](standalone/COMPATIBILITY.md)에 기록합니다.
