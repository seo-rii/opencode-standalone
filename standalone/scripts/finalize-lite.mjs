import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { decodePackedPayload } from "./pack.mjs"
import { distributionDirectory } from "./profiles.mjs"
import { testFiles } from "./tests.mjs"
import { archiveMagic, decodeAssetArchive } from "../web/runtime.mjs"

const directory = fileURLToPath(new URL("../", import.meta.url))
const payloadNames = ["app", "pty", "daemon", "licenses", "tui", "web"]
const preservedNames = ["app", "pty", "daemon", "tui"]

/** Describe lite only after both exact artifacts pass the complete current suite. */
export async function finalizeLite() {
  const tests = await testFiles(directory)
  assert.ok(tests.length > 0, "No standalone test files found")
  const [full, lite] = await Promise.all([validateDistribution("full", tests), validateDistribution("lite", tests)])
  assert.equal(lite.report.upstream, full.report.upstream, "The builds use different upstream sources")
  assert.equal(lite.bytes.length < full.bytes.length, true, "Lite must be smaller than full")
  const buildRecords = ["modules", "assets", "pluginModules", "tui"]
  for (const field of buildRecords)
    assert.deepEqual(lite.report[field], full.report[field], `Lite changed the ${field} build record`)

  const preservedPayloads = {}
  for (const name of preservedNames) {
    const original = unpack(full, name), retained = unpack(lite, name)
    assert.ok(retained.equals(original), `Lite changed the original ${name} module`)
    preservedPayloads[name] = { identical: true, bytes: original.length, sha256: hash(original) }
  }
  // Each profile keeps its own notices: browser-only licenses need not be copied
  // into lite. Decode both to validate their actual packed sizes and encoding.
  for (const distribution of [full, lite]) assert.ok(unpack(distribution, "licenses").length > 0, "Third-party notices are missing")
  const fullWeb = unpack(full, "web"), liteWeb = unpack(lite, "web")
  assert.equal(Object.keys(decodeAssetArchive(fullWeb).files).length, 1688, "Full must contain every original browser URL")
  const emptyIndex = Buffer.from('{"groups":[],"files":{}}')
  const emptyHeader = Buffer.alloc(12)
  emptyHeader.write(archiveMagic, 0, "ascii")
  emptyHeader.writeUInt32LE(emptyIndex.length, 8)
  assert.equal(liteWeb.length, 36, "Lite must contain only the empty browser archive")
  assert.ok(liteWeb.equals(Buffer.concat([emptyHeader, emptyIndex])), "Lite contains unexpected browser archive data")
  assert.equal(Object.keys(decodeAssetArchive(liteWeb).files).length, 0, "Lite still contains browser URLs")

  const savedBytes = full.bytes.length - lite.bytes.length
  const savedPercent = savedBytes / full.bytes.length * 100
  const comparison = {
    format: "opencode-standalone-lite-comparison-v1", created: new Date().toISOString(), upstream: full.report.upstream,
    full: { artifact: relative(directory, full.artifact), bytes: full.bytes.length, sha256: hash(full.bytes), counts: full.verification.counts },
    lite: { artifact: relative(directory, lite.artifact), bytes: lite.bytes.length, sha256: hash(lite.bytes), counts: lite.verification.counts },
    savedBytes, savedPercent, tests, preservedPayloads, preservedBuildRecords: buildRecords,
    omittedFeatures: ["browser-ui"], web: { fullUrls: 1688, liteUrls: 0, omittedUrls: 1688, liteArchiveBytes: liteWeb.length }, fullParity: false,
  }
  const n = (value) => value.toLocaleString("en-US")
  const document = `# CLI용 lite 배포판

lite는 브라우저 웹 앱 자산을 제외한 단일 JavaScript 배포판입니다. 기본·mini TUI, 에이전트, HTTP API, 일반·지속형 PTY와 내장 터미널, 클립보드, 구문 강조와 이미지 처리에 필요한 JS/WASM은 full과 동일합니다.

| 배포판 | 파일 | 실제 크기 | full 대비 감소 |
| --- | --- | ---: | ---: |
| full | dist/opencode-standalone.js | ${n(full.bytes.length)}바이트 (${(full.bytes.length / 1_000_000).toFixed(2)} MB) | — |
| lite | dist/lite/opencode-standalone.js | ${n(lite.bytes.length)}바이트 (${(lite.bytes.length / 1_000_000).toFixed(2)} MB) | ${n(savedBytes)}바이트 (${savedPercent.toFixed(2)}%) |

## 빌드와 실행

\`\`\`sh
cd standalone
npm ci --ignore-scripts --workspaces=false
npm run build:lite
node dist/lite/opencode-standalone.js --standalone-info
node dist/lite/opencode-standalone.js
node dist/lite/opencode-standalone.js mini
node dist/lite/opencode-standalone.js serve --hostname 127.0.0.1 --port 4096
npm run verify:lite
\`\`\`

실행에는 **Node.js 26.4 이상**이 필요하며 런타임 npm 설치는 필요하지 않습니다. 빌드에는 개발 의존성과 컴파일 도구가 필요합니다. lite 빌드는 브라우저 Vite 단계를 실행하지 않고, 브라우저 빌드 캐시나 브라우저 라이선스 파일을 읽지 않습니다. 웹 캐시가 없는 환경에서도 빌드할 수 있습니다.

기본 \`npm run build\`는 웹 앱을 포함한 full을 \`dist/\`에 생성합니다. \`npm run build:lite\`는 \`dist/lite/\`에 생성하며 두 배포판의 결과와 검증 영수증을 분리합니다. 배포할 때는 선택한 디렉터리의 \`opencode-standalone.js\` 파일 하나만 복사하면 됩니다.

## 제외되는 기능

브라우저 웹 UI와 서비스 워커, Office 문서 미리 보기, 브라우저 폰트·아이콘·스타일·오디오 자산을 제외합니다. 웹 UI 경로와 정적 자산 요청에는 **404**를 반환합니다. 제외된 자산을 CDN에서 자동으로 내려받지 않습니다. HTTP API와 인증 경로, OpenAPI 문서는 유지합니다.

CLI/TUI에서 사용하는 Bash·PowerShell 파서, Photon 이미지 처리, TUI 구문 강조 파서와 이미지 코덱, Ghostty 터미널, 클립보드 워커와 기존 알림 음원은 유지합니다. TUI는 호스트 터미널의 글꼴을 사용합니다. 기존 플랫폼·오디오·Git 등의 제한과 **fullParity: false** 상태도 유지하며, 자세한 범위는 [COMPATIBILITY.md](COMPATIBILITY.md)에 기록합니다.

## 검증과 비교

full은 ${n(full.verification.counts.pass)}/${n(full.verification.counts.tests)}개, lite는 ${n(lite.verification.counts.pass)}/${n(lite.verification.counts.tests)}개 테스트를 통과했습니다. 양쪽 모두 현재 전체 ${n(tests.length)}개 테스트 파일을 실행했고 실패·건너뜀은 0개입니다. 검증 환경은 full ${full.verification.platform}/${full.verification.arch} ${full.verification.node}, lite ${lite.verification.platform}/${lite.verification.arch} ${lite.verification.node}입니다.

비교 스크립트는 실제 파일의 크기·SHA-256·성공한 검증 영수증을 확인하고, 압축을 푼 app·pty·daemon·tui 모듈이 바이트 단위로 같은지 검사합니다. 포함 모듈·WASM 자산·플러그인·TUI manifest도 동일합니다. full의 1,688개 웹 URL은 lite에서 모두 빠졌고, lite에는 36바이트 빈 웹 아카이브만 남습니다. 브라우저 전용 고지는 lite의 라이선스에서 제외합니다.

- full SHA-256: \`${comparison.full.sha256}\`
- lite SHA-256: \`${comparison.lite.sha256}\`
- 비교 영수증: \`dist/lite/comparison.json\`

양쪽을 새로 빌드·검증한 뒤 \`node scripts/finalize-lite.mjs\`를 실행하면 비교 영수증과 이 문서를 갱신합니다. 빌드·검증 영수증이나 비교 영수증은 런타임에 필요하지 않습니다.
`
  // Validate and prepare every result before writing the comparison or public doc.
  await writeFile(join(distributionDirectory(directory, "lite"), "comparison.json"), JSON.stringify(comparison, null, 2) + "\n")
  await writeFile(join(directory, "LITE.md"), document)
  console.log(JSON.stringify({ fullBytes: full.bytes.length, liteBytes: lite.bytes.length, savedBytes, savedPercent, fullTests: full.verification.counts.tests, liteTests: lite.verification.counts.tests, testFiles: tests.length, preservedPayloads: preservedNames, omittedBrowserUrls: 1688 }))
}

async function validateDistribution(profile, tests) {
  const output = distributionDirectory(directory, profile)
  const artifact = join(output, "opencode-standalone.js")
  const [bytes, reportText, verificationText] = await Promise.all([readFile(artifact), readFile(join(output, "build-report.json"), "utf8"), readFile(join(output, "verification.json"), "utf8")])
  const report = JSON.parse(reportText), verification = JSON.parse(verificationText)
  for (const [name, receipt] of [["Build", report], ["Verification", verification]]) {
    assert.equal(receipt.profile ?? "full", profile, `${name} profile does not match ${profile}`)
    assert.equal(receipt.artifact, basename(artifact), `${name} names a different ${profile} artifact`)
    assert.equal(receipt.bytes, bytes.length, `${name} size differs from the actual ${profile} artifact`)
    assert.equal(receipt.sha256, hash(bytes), `${name} SHA-256 differs from the actual ${profile} artifact`)
  }
  assert.deepEqual(report.omittedFeatures ?? [], profile === "lite" ? ["browser-ui"] : [], "Unexpected omitted features")
  assert.equal(verification.exitCode, 0, `${profile} verification did not succeed`)
  assert.equal(verification.signal, null, `${profile} verification was terminated`)
  assert.equal(verification.fullParity, false, "Verification must not claim full upstream parity")
  assert.ok(Number.isSafeInteger(verification.counts?.tests) && verification.counts.tests > 0, "Verification did not execute tests")
  assert.equal(verification.counts.pass, verification.counts.tests, "Every verification test must pass")
  assert.equal(verification.counts.fail, 0, "Verification contains failures")
  assert.equal(verification.counts.skipped, 0, "Verification contains skipped tests")
  assert.ok(Array.isArray(verification.tests), "Verification must identify its test files")
  assert.deepEqual([...verification.tests].sort(), tests, `${profile} verification did not run the complete current test suite`)
  assert.ok(Number.isFinite(Date.parse(verification.started)) && Date.parse(verification.finished) >= Date.parse(verification.started), "Verification timestamps are invalid")
  assert.match(report.upstream, /^[a-f0-9]{40}$/, "Build source must pin an upstream commit")
  assert.ok(Array.isArray(report.modules) && report.modules.length > 0, "Build must identify its modules")
  assert.ok(report.assets && Object.keys(report.assets).length > 0, "Build must identify its required WASM assets")
  assert.ok(Array.isArray(report.pluginModules) && report.pluginModules.length > 0, "Build must identify its public plugin modules")
  assert.match(report.tui?.factoryWasm?.sha256, /^[a-f0-9]{64}$/, "Build must identify its TUI factory")
  assert.equal(report.external, "Node.js built-in modules only", "Build contains a different runtime dependency profile")
  assert.deepEqual(Object.keys(report.payloads ?? {}).sort(), [...payloadNames].sort(), "Unexpected embedded payload set")
  for (const name of payloadNames) {
    const record = report.payloads[name]
    for (const field of ["offset", "length", "storedBytes", "bytes"])
      assert.ok(Number.isSafeInteger(record[field]) && record[field] >= (field === "offset" ? 0 : 1), `Invalid ${profile} ${name} payload ${field}`)
    assert.equal(record.encoding, report.payloads.app.encoding, "Embedded payload encodings differ")
    assert.equal(typeof record.brotli, "boolean", "Invalid embedded compression flag")
  }
  const base = bytes.subarray(0, 16_384).toString("ascii").match(/const base = Number\("(\d{10})"\);/)
  assert.ok(base, "Packed artifact does not expose its payload offset")
  const info = spawnSync(process.execPath, ["--no-addons", artifact, "--standalone-info"], { cwd: directory, env: { PATH: "", NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 })
  assert.equal(info.error, undefined, `Could not read ${profile} artifact metadata`)
  assert.equal(info.status, 0, `${profile} artifact metadata failed: ${info.stderr}`)
  const metadata = JSON.parse(info.stdout)
  assert.equal(metadata.name, "opencode-standalone")
  assert.equal(metadata.profile ?? "full", profile, "Artifact metadata reports a different profile")
  assert.deepEqual(metadata.omittedFeatures ?? [], profile === "lite" ? ["browser-ui"] : [], "Artifact metadata reports different omitted features")
  assert.equal(metadata.browserAssets, profile === "full", "Artifact metadata reports the wrong browser support")
  assert.equal(metadata.upstream, report.upstream, "Artifact metadata reports a different upstream source")
  assert.equal(metadata.payloadEncoding, report.payloads.app.encoding, "Artifact metadata reports a different payload encoding")
  for (const feature of ["interactiveTui", "miniTui", "embeddedTerminal", "hostClipboard", "embeddedWasm"])
    assert.equal(metadata[feature], true, `Artifact does not retain ${feature}`)
  assert.equal(metadata.fullParity, false, "Artifact must not claim full upstream parity")
  return { artifact, bytes, report, verification, base: Number(base[1]) }
}

function unpack(distribution, name) {
  const record = distribution.report.payloads[name]
  const start = distribution.base + record.offset
  assert.ok(Number.isSafeInteger(start) && start >= distribution.base && record.length <= distribution.bytes.length - start, `Embedded ${name} payload exceeds the artifact`)
  return decodePackedPayload(distribution.bytes.subarray(start, start + record.length), record)
}

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex") }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await finalizeLite()
