# Embedded upstream browser app

This builder compiles the real `packages/app` browser UI and packages every emitted asset into a hybrid Brotli archive. It preserves the upstream Solid/Tailwind plugin, icons, service worker, lazy chunks, Office previews, fonts, and Ghostty browser-terminal WASM. All original asset URLs and decoded response bytes remain unchanged.

Merge `dependencies.json`'s `devDependencies` into `standalone/package.json`, install them through the standalone lockfile, and run the workspace preparation script before building. The browser uses the upstream Vite 8.2.2 through the `vite-web` npm alias; the CLI builder keeps Vite 7.3.6. The Solid plugin update supports both versions.

From `standalone` with Node 26.4 or later:

```sh
NODE_OPTIONS=--max-old-space-size=4096 node web/build.mjs
```

The build can take several minutes and should be launched with stdout/stderr redirected to a private log. It writes only `.cache/web`: Vite output under `dist`, a binary `app.archive`, per-file hashes and included-module information in `manifest.json`, and third-party notices in `licenses.txt`. It does not write `packages/app/dist`, load repository `.env` files, import the Sentry upload plugin, or deploy anything. The app connects to its serving origin; runtime Sentry configuration is empty in this build.

The archive starts with the eight ASCII bytes `OCWEB02\n`, a little-endian u32 JSON-index byte length, the index, and concatenated Brotli payloads. The index is `{ groups, files }`: each group is `[storedOffset, storedLength, rawLength, mode]`, and each file maps its original path to `[groupIndex, rawOffset, rawLength]`. Mode `0` shares a compression dictionary across raw assets; mode `1` stores a single independently compressed HTTP response. JavaScript, TTF, CSS, SVG and other text files share groups by extension, each at most 32 MiB before compression. Office WASM, WOFF/WOFF2, images, audio and oversized individual files retain their independent Brotli responses, so serving them avoids decompression and recompression.

Brotli uses quality 11 with at most four active reads/compression jobs. SHA-256-identical assets share one location while every original URL keeps its own index entry. Sorted paths make group boundaries and archive bytes deterministic despite concurrent I/O. Each compressed group is checked by a round trip, and source maps are excluded. The manifest records each file's original bytes, SHA-256, group location and compression mode rather than assigning the full shared group's size to every member.

`runtime.mjs` uses Node builtins and decompresses a raw group only when one of its files is requested. It keeps at most 48 MiB of raw groups in a least recently used cache. Browsers accepting Brotli receive preserved responses for mode `1`; mode `0` responses are compressed at quality 4 on demand and retained in a separate 8 MiB cache. `assets.ts` supplies these lazy maps to the upstream web handler, which keeps its existing URL routing, CSP, caching and content-encoding negotiation.

`node --test archive.test.mjs runtime.test.mjs` from this directory covers UTF-8 text, WASM, empty files, duplicate shared views, deterministic output, source-map exclusion, passthrough bytes, group limits, lazy access, cache eviction and archive boundaries. The builder, tests and final server use Node.

`node web/repack.mjs` from `standalone` repackages the existing `.cache/web/dist` files without rerunning Vite. It keeps their hashed URLs and service-worker manifest, preserves matching independently compressed responses from the previous archive, and updates the archive and manifest together after packaging succeeds.

`node web/benchmark.mjs` from `standalone` samples independent Brotli qualities 8–11 for the two largest emitted WASM, TTF, JavaScript, SVG, and WOFF2 assets. It verifies every round trip and prints sizes, elapsed compression times and the baseline file's group information. Shared-group sizes cannot be compared directly with one independently compressed member. Run it with stdout/stderr redirected to a private log because quality 11 can take several minutes.

The main single-file builder must embed `app.archive` as the result of `virtual:opencode-app-assets`, and include `licenses.txt` in `--standalone-licenses`. The manifest supplies main/worker module IDs plus explicit Office/font/Ghostty package roots; the notice file includes package notices and nested font/WASM license files. A successful browser build is only one validation step: test that the standalone server serves its index, hashed JavaScript/CSS, WASM, service worker, and lazy assets, then exercise the actual browser UI.
