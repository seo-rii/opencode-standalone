# Distribution size

The complete verified file is **29,570,945 bytes**, 14,371,573 bytes (32.71%) smaller than the original **43,942,518 bytes** (SHA-256 09793cdadc6642dd48e343d67bbbe9a4320c407e151a5901115ea7555ba2ecb8), 8,024,353 bytes (21.34%) smaller than the first public **37,595,298-byte** distribution, and 3,372,532 bytes (10.24%) smaller than the previous **32,943,477-byte** release. Compared with the earlier **35,628,036-byte headless checkpoint**, it is 6,057,091 bytes (17.00%) smaller; it includes the actual default/mini TUI, Solid, parser worker, native image/ICC resources, embedded Ghostty terminal and desktop clipboard protocols. Its current SHA-256 is e7881aef0f188a60b0f6bcdc92f46d6dcbce85a6317596c3c555e84f1658c76e.

The application is minified with keepNames enabled, Brotli-compressed with a 16 MiB window and stored as comment-safe **utf8-words**. This shares repeated parser resources without changing the JavaScript or function names. The TUI factory has an independent compressed module inside the same JS file; it is not a second distribution file. Standard Node APIs decode the selected payload without extracting modules, WASM, addons or browser assets.

The payload encoding uses fixed four-byte UTF-8 words and a pinned Unicode range table. It contains no NUL, ASCII controls, bidi/format controls, surrogates, Unicode noncharacters or comment-closing delimiters. The complete file remains valid UTF-8 JavaScript. Its Unicode source can use roughly 20–30 MiB more parsing memory than ASCII-only source; measured startup time stayed within run-to-run variation after decoder optimization. The legacy base95 packing API remains available for comparison.

| Payload | Input bytes | Stored bytes | UTF-8 bytes |
| --- | ---: | ---: | ---: |
| app | 27,882,240 | 5,401,886 | 6,385,340 |
| pty | 1,851 | 824 | 976 |
| daemon | 329,979 | 235,342 | 278,184 |
| licenses | 1,710,295 | 37,274 | 44,044 |
| tui | 1,231,863 | 892,888 | 1,055,408 |
| web | 18,491,347 | 18,441,456 | 21,798,424 |

Input sizes describe modules or the hybrid browser archive before outer packing. Related JavaScript, text and raw fonts share Brotli quality 11 groups, each limited to 32 MiB before compression. Office WASM shares a separate group capped at 40 MiB, using an internal 32 MiB Brotli window. Already compressed media keep individual Brotli payloads. Identical assets share storage. The browser archive shrank from **27,101,364** to **18,491,347 bytes**; the original 1,688 URLs and every decompressed byte were preserved. The current packed archive decodes to SHA-256 e02672d27255f3226004f97bf157820b29d0c675689c85d07340d638a1a7c4dd.

Groups are decompressed on demand with a 48 MiB cache. Standard browser-compatible Brotli HTTP responses are generated at quality 1 for Office WASM and quality 4 for other grouped assets, then cached up to 16 MiB; requests without Brotli read the original bytes directly. A cold Office request adds about 0.3 seconds of group decoding and recompression in the measured host. Its compressed responses are larger than individually stored quality 11 payloads (the largest DOCX WASM is about 7.21 MB instead of 4.42 MB). The original web handler retains content types, CSP, caching and encoding negotiation. Web assets remain unloaded during CLI startup. Application windows, Unicode parsing and browser caches trade runtime memory and some first-request work for the smaller distribution.

The file retains the original Office WASM, fonts, browser code and all tested runtime features. Image/ICC and embedded-terminal vendor code is embedded WASM; system libc supplies host PTYs and input flushing. Larger compressed builds can take longer; their development tools are not runtime npm dependencies.

From standalone/, scripts/size-benchmark.mjs compares application compression/encoding and web/benchmark.mjs samples browser Brotli qualities. These measurements write under .cache; use private redirected logs for long runs. [VALIDATION.md](VALIDATION.md) records the matching successful tests, and dist/build-report.json contains the exact module/payload manifest.
