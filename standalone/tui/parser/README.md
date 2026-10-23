# Embedded OpenTUI parser worker

This adapter bundles the actual `@opentui/core@0.6.6` published parser worker, its
six default grammar WASM modules and shipped query sources, and
`web-tree-sitter@0.25.10` into a Node worker loaded from an in-memory data URL.
It does not construct a native UI or extract worker scripts, WASM modules, or
queries to disk. The source and asset checksums are pinned in
`published-sources.json`.

The worker retains upstream parsing, query predicates, aliases, Markdown
injections, incremental edits, caches, and protocol responses. The adapter
passes embedded bytes to `Parser.init({ wasmBinary })` and
`Language.load(Uint8Array)`. Embedded default assets use
`opencode:opentui/…` identifiers. Custom filesystem and HTTP parser/query sources
continue through the actual upstream loader. Explicit `OTUI_ASSET_ROOT` and
custom worker paths remain available in the published client.

The 14 asset bodies total 5,051,656 bytes, compressed to 426,961 bytes with Brotli
quality 11. Each asset is decompressed lazily inside its worker. A default parse
creates the same empty cache directories as upstream, without writing runtime
asset files.

## Build integration

For esbuild, add `await standaloneParserPlugin()` from `build.mjs` and compose
`adaptPublishedParserSource(filename, source)` from `adapt.mjs` with the
renderer adapter's checked `onLoad` source transform. Both adapters modify the
same two published node chunks, so one `onLoad` callback must compose them.

For Rollup/Vite, `await getParserRuntimeModules()` returns a `Map<string,
string>` of virtual module IDs to source. Resolve and load those IDs, and apply
`adaptPublishedParserSource` in the published OpenTUI chunk transform. The
adapter checks that every pinned seam matches exactly once. The IDs are
`opencode:tui-parser` and `opencode:tui-parser-data`.

Include `LICENSES.txt` in the final artifact's license payload. It contains the
OpenTUI, web-tree-sitter, grammar, and nvim-treesitter query notices; builds do
not fetch licenses or parser assets from the network. Query and grammar bodies
remain byte-identical to the pinned installed package.

## Independent proofs

Run from `standalone/` using the installed Node 26.4 runtime:

```sh
../.tools/node/bin/node scripts/run-logged.mjs parser-tests \
  ../.tools/node/bin/node --test tui/parser/parser.test.mjs

../.tools/node/bin/node tui/parser/build.mjs /tmp/parser-proof.mjs
../.tools/node/bin/node --no-addons /tmp/parser-proof.mjs /tmp/parser-data

../.tools/node/bin/node tui/parser/client-build.mjs /tmp/parser-client-proof.mjs
../.tools/node/bin/node --no-addons /tmp/parser-client-proof.mjs /tmp/parser-client-data
```

The tests copy one JS file into a fresh directory and execute it with empty
`PATH`, isolated HOME/XDG paths, and `--no-addons`. They check real JavaScript
captures, TypeScript types, TSX tags, Markdown inline emphasis, Zig keywords,
Markdown fenced-code and inline injections, incremental edits/reset/disposal,
cache clear/reload, and worker restart/shutdown. The default run leaves only
the copied JS file on disk.

The separate client proof imports the actual published `TreeSitterClient`
class, composes the checked parser and renderer package adapters, and starts
the upstream `NodeWorkerShim`. It exercises public initialization,
`highlightOnce`, Markdown injections, buffer creation, queued incremental
updates, debounced reset, disposal, performance reporting, data path changes,
cache clear/reload, and destroy/reinitialization. A further run loads real
custom local and HTTP WASM/query sources through that same published client
against an ephemeral local HTTP server. The client proof constructs no native
renderer and does not replace worker or client objects with mocks. Interactive
TUI rendering remains covered by the renderer integration work.

`bundleParserProof()` emits a sidecar build report for source checksums and
asset sizes; `bundleParserClientProof()` reports its copied artifact checksum.
Both proofs contain all required license notices and need no sidecar at runtime.
