# CLI용 lite 배포판

lite는 브라우저 웹 앱 자산을 제외한 단일 JavaScript 배포판입니다. 기본·mini TUI, 에이전트, HTTP API, 일반·지속형 PTY와 내장 터미널, 클립보드, 구문 강조와 이미지 처리에 필요한 JS/WASM은 full과 동일합니다.

| 배포판 | 파일 | 실제 크기 | full 대비 감소 |
| --- | --- | ---: | ---: |
| full | dist/opencode-standalone.js | 29,079,504바이트 (29.08 MB) | — |
| lite | dist/lite/opencode-standalone.js | 7,526,125바이트 (7.53 MB) | 21,553,379바이트 (74.12%) |

## 빌드와 실행

```sh
cd standalone
npm ci --ignore-scripts --workspaces=false
npm run build:lite
node dist/lite/opencode-standalone.js --standalone-info
node dist/lite/opencode-standalone.js
node dist/lite/opencode-standalone.js mini
node dist/lite/opencode-standalone.js serve --hostname 127.0.0.1 --port 4096
npm run verify:lite
```

실행에는 **Node.js 26.4 이상**이 필요하며 런타임 npm 설치는 필요하지 않습니다. 빌드에는 개발 의존성과 컴파일 도구가 필요합니다. lite 빌드는 브라우저 Vite 단계를 실행하지 않고, 브라우저 빌드 캐시나 브라우저 라이선스 파일을 읽지 않습니다. 웹 캐시가 없는 환경에서도 빌드할 수 있습니다.

기본 `npm run build`는 웹 앱을 포함한 full을 `dist/`에 생성합니다. `npm run build:lite`는 `dist/lite/`에 생성하며 두 배포판의 결과와 검증 영수증을 분리합니다. 배포할 때는 선택한 디렉터리의 `opencode-standalone.js` 파일 하나만 복사하면 됩니다.

## 제외되는 기능

브라우저 웹 UI와 서비스 워커, Office 문서 미리 보기, 브라우저 폰트·아이콘·스타일·오디오 자산을 제외합니다. 웹 UI 경로와 정적 자산 요청에는 **404**를 반환합니다. 제외된 자산을 CDN에서 자동으로 내려받지 않습니다. HTTP API와 인증 경로, OpenAPI 문서는 유지합니다.

CLI/TUI에서 사용하는 Bash·PowerShell 파서, Photon 이미지 처리, TUI 구문 강조 파서와 이미지 코덱, Ghostty 터미널, 클립보드 워커와 기존 알림 음원은 유지합니다. TUI는 호스트 터미널의 글꼴을 사용합니다. 기존 플랫폼·오디오·Git 등의 제한과 **fullParity: false** 상태도 유지하며, 자세한 범위는 [COMPATIBILITY.md](COMPATIBILITY.md)에 기록합니다.

## 검증과 비교

full은 182/182개, lite는 182/182개 테스트를 통과했습니다. 양쪽 모두 현재 전체 42개 테스트 파일을 실행했고 실패·건너뜀은 0개입니다. 검증 환경은 full linux/x64 v26.4.0, lite linux/x64 v26.4.0입니다.

비교 스크립트는 실제 파일의 크기·SHA-256·성공한 검증 영수증을 확인하고, 압축을 푼 app·pty·daemon·tui 모듈이 바이트 단위로 같은지 검사합니다. 포함 모듈·WASM 자산·플러그인·TUI manifest도 동일합니다. full의 1,688개 웹 URL은 lite에서 모두 빠졌고, lite에는 36바이트 빈 웹 아카이브만 남습니다. 브라우저 전용 고지는 lite의 라이선스에서 제외합니다.

- full SHA-256: `8d963c69449a2504030379ea376f86211188b701b13cf12955d73f34c395efe0`
- lite SHA-256: `b502df0983d223a3fe5c34425502b0a9cdab0a272d532a385b5e9e73e1e503d0`
- 비교 영수증: `dist/lite/comparison.json`

양쪽을 새로 빌드·검증한 뒤 `node scripts/finalize-lite.mjs`를 실행하면 비교 영수증과 이 문서를 갱신합니다. 빌드·검증 영수증이나 비교 영수증은 런타임에 필요하지 않습니다.
