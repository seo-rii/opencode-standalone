# Distribution size

The complete verified file is **32,943,477 bytes**, 10,999,041 bytes (25.03%) smaller than the original **43,942,518 bytes** (SHA-256 09793cdadc6642dd48e343d67bbbe9a4320c407e151a5901115ea7555ba2ecb8), and 4,651,821 bytes (12.37%) smaller than the first public **37,595,298-byte** distribution. Compared with the earlier **35,628,036-byte headless checkpoint**, it is 2,684,559 bytes (7.53%) smaller; it includes the actual default/mini TUI, Solid, parser worker, native image/ICC resources, embedded Ghostty terminal and desktop clipboard protocols. Its current SHA-256 is 14f490bf9e2bb26fb592fe78e0b387d0b96efe9c32af27e8adc588327f18fb87.

The application is minified with keepNames enabled, Brotli-compressed with a 16 MiB window and stored as comment-safe **base95**. This shares repeated parser resources without changing the JavaScript or function names. The TUI factory has an independent compressed module inside the same JS file; it is not a second distribution file. Standard Node APIs decode the selected payload without extracting modules, WASM, addons or browser assets.

| Payload | Input bytes | Stored bytes | ASCII bytes |
| --- | ---: | ---: | ---: |
| app | 27,881,989 | 5,400,184 | 6,596,192 |
| pty | 1,851 | 824 | 1,005 |
| daemon | 329,979 | 235,342 | 287,429 |
| licenses | 1,710,295 | 37,274 | 45,491 |
| tui | 1,231,863 | 892,888 | 1,090,534 |
| web | 20,449,684 | 20,399,740 | 24,917,340 |

Input sizes describe modules or the hybrid browser archive before outer packing. Related JavaScript, text and raw fonts share Brotli quality 11 groups, each limited to 32 MiB before compression. Office WASM and already compressed media keep individual Brotli payloads. Identical assets share storage. The browser archive shrank from **27,101,364** to **20,449,684 bytes**; the original 1,688 URLs and every decompressed byte were preserved. The current packed archive decodes to SHA-256 26211c2f960154c20616f48b5552f084aa3f2369f37eaf5242921a07153b7feb.

Groups are decompressed on demand with a 48 MiB cache. Brotli HTTP responses for grouped assets are generated at quality 4 and cached up to 8 MiB; requests without Brotli read the original bytes directly. The original web handler retains content types, CSP, caching and encoding negotiation. Web assets remain unloaded during CLI startup. Larger application windows and browser caches trade some runtime memory for the smaller distribution.

The file retains the original Office WASM, fonts, browser code and all tested runtime features. Image/ICC and embedded-terminal vendor code is embedded WASM; system libc supplies host PTYs and input flushing. Larger compressed builds can take longer; their development tools are not runtime npm dependencies.

From standalone/, scripts/size-benchmark.mjs compares application compression/encoding and web/benchmark.mjs samples browser Brotli qualities. These measurements write under .cache; use private redirected logs for long runs. [VALIDATION.md](VALIDATION.md) records the matching successful tests, and dist/build-report.json contains the exact module/payload manifest.
