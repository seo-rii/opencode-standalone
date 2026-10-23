# Embedded upstream browser app

This builder compiles the real `packages/app` browser UI and packages every emitted asset into the existing OpenCode `AppArchive` wire format. It preserves the upstream Solid/Tailwind plugin, icons, service worker, lazy chunks, Office previews, fonts, and Ghostty browser-terminal WASM.

Merge `dependencies.json`'s `devDependencies` into `standalone/package.json`, install them through the standalone lockfile, and run the workspace preparation script before building. The browser uses the upstream Vite 8.2.2 through the `vite-web` npm alias; the CLI builder keeps Vite 7.3.6. The Solid plugin update supports both versions.

From `standalone` with Node 26.4 or later:

```sh
NODE_OPTIONS=--max-old-space-size=4096 node web/build.mjs
```

The build can take several minutes and should be launched with stdout/stderr redirected to a private log. It writes only `.cache/web`: Vite output under `dist`, a binary `app.archive`, per-file hashes and included-module information in `manifest.json`, and third-party notices in `licenses.txt`. It does not write `packages/app/dist`, load repository `.env` files, import the Sentry upload plugin, or deploy anything. The app connects to its serving origin; runtime Sentry configuration is empty in this build.

The archive has a little-endian u32 JSON-index byte length, a JSON mapping from asset path to `[offset, compressedLength]`, and concatenated independent Brotli payloads. This is the format consumed by `packages/cli/src/app-archive.ts` and `app-assets.ts`. Brotli uses upstream release quality 11 with at most four active reads/compression jobs. SHA-256-identical assets share one payload; all original URLs remain in the index. Path ordering makes the archive deterministic despite concurrent compression. Decompressed contents are unchanged, and each unique payload is verified by a compression round trip while packaging. Source maps are excluded as in the upstream archive builder. The manifest records quality, concurrency, unique-asset count, and bytes saved by deduplication.

`node --test archive.test.mjs` from this directory compares the builder's output with the actual upstream TypeScript `AppArchive.decode`, bundled by Vite for the test. It covers UTF-8 text, nested JavaScript, binary WASM, empty files, duplicate shared views, distinct same-length files, deterministic output, and source-map exclusion. The builder, tests and final server use Node.

`node web/benchmark.mjs` from `standalone` compares Brotli qualities 8–11 against the existing cache's compression. It samples the two largest emitted WASM, TTF, JavaScript, SVG, and WOFF2 assets, verifies every round trip, and prints sizes and elapsed compression times. Run it with stdout/stderr redirected to a private log because quality 11 can take several minutes.

The main single-file builder must embed `app.archive` as the result of `virtual:opencode-app-assets`, and include `licenses.txt` in `--standalone-licenses`. The manifest supplies main/worker module IDs plus explicit Office/font/Ghostty package roots; the notice file includes package notices and nested font/WASM license files. A successful browser build is only one validation step: test that the standalone server serves its index, hashed JavaScript/CSS, WASM, service worker, and lazy assets, then exercise the actual browser UI.
