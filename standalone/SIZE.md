# Distribution size

The complete verified file is **37,586,057 bytes**, 6,356,461 bytes (14.47%) smaller than the original **43,942,518 bytes** (SHA-256 09793cdadc6642dd48e343d67bbbe9a4320c407e151a5901115ea7555ba2ecb8). Compared with the earlier **35,628,036-byte headless checkpoint**, it is 1,958,021 bytes (5.50%) larger; it now includes the actual default/mini TUI, Solid, parser worker, native image/ICC resources, embedded Ghostty terminal and desktop clipboard protocols. Its current SHA-256 is e02e6a45fc273459a33ea18ed8181d6e4244cfdf86930202ad857427b070e6a5.

The application is minified with keepNames enabled, Brotli-compressed and stored as comment-safe **base95**. The TUI factory has an independent compressed module inside the same JS file; it is not a second distribution file. Standard Node APIs decode the selected payload without extracting modules, WASM, addons or browser assets.

| Payload | Input bytes | Stored bytes | ASCII bytes |
| --- | ---: | ---: | ---: |
| app | 27,846,512 | 5,553,184 | 6,782,497 |
| pty | 1,851 | 824 | 1,005 |
| daemon | 329,979 | 235,342 | 287,429 |
| licenses | 1,710,295 | 37,274 | 45,491 |
| tui | 1,231,407 | 892,292 | 1,089,823 |
| web | 24,115,808 | 24,049,540 | 29,374,326 |

Input sizes describe modules or the already compressed browser archive before outer packing. Browser assets use Brotli quality 11 with shared identical payloads and four bounded build workers. The browser archive shrank from **27,101,364** to **24,115,808 bytes**; the original 1,688 URLs and every decompressed byte were preserved. The current packed archive decodes to that same SHA-256: 43323f83ab9967f85c0183d05a7ea01d786e674396e12a030719d70478e61999.

The file retains the original Office WASM, fonts, browser code and all tested runtime features. Image/ICC and embedded-terminal vendor code is embedded WASM; system libc supplies host PTYs and input flushing. Larger compressed builds can take longer; their development tools are not runtime npm dependencies.

From standalone/, scripts/size-benchmark.mjs compares application compression/encoding and web/benchmark.mjs samples browser Brotli qualities. These measurements write under .cache; use private redirected logs for long runs. [VALIDATION.md](VALIDATION.md) records the matching successful tests, and dist/build-report.json contains the exact module/payload manifest.
