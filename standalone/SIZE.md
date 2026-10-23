# Distribution size

The complete verified file is **37,595,298 bytes**, 6,347,220 bytes (14.44%) smaller than the original **43,942,518 bytes** (SHA-256 09793cdadc6642dd48e343d67bbbe9a4320c407e151a5901115ea7555ba2ecb8). Compared with the earlier **35,628,036-byte headless checkpoint**, it is 1,967,262 bytes (5.52%) larger; it now includes the actual default/mini TUI, Solid, parser worker, native image/ICC resources, embedded Ghostty terminal and desktop clipboard protocols. Its current SHA-256 is 235247505b90a72fa5ac31f8f9c1d660888343b40940c389e29a66ac9684c9a5.

The application is minified with keepNames enabled, Brotli-compressed and stored as comment-safe **base95**. The TUI factory has an independent compressed module inside the same JS file; it is not a second distribution file. Standard Node APIs decode the selected payload without extracting modules, WASM, addons or browser assets.

| Payload | Input bytes | Stored bytes | ASCII bytes |
| --- | ---: | ---: | ---: |
| app | 27,879,916 | 5,560,013 | 6,791,027 |
| pty | 1,851 | 824 | 1,005 |
| daemon | 329,979 | 235,342 | 287,429 |
| licenses | 1,710,295 | 37,274 | 45,491 |
| tui | 1,231,863 | 892,888 | 1,090,534 |
| web | 24,115,808 | 24,049,540 | 29,374,326 |

Input sizes describe modules or the already compressed browser archive before outer packing. Browser assets use Brotli quality 11 with shared identical payloads and four bounded build workers. The browser archive shrank from **27,101,364** to **24,115,808 bytes**; the original 1,688 URLs and every decompressed byte were preserved. The current packed archive decodes to that same SHA-256: 43323f83ab9967f85c0183d05a7ea01d786e674396e12a030719d70478e61999.

The file retains the original Office WASM, fonts, browser code and all tested runtime features. Image/ICC and embedded-terminal vendor code is embedded WASM; system libc supplies host PTYs and input flushing. Larger compressed builds can take longer; their development tools are not runtime npm dependencies.

From standalone/, scripts/size-benchmark.mjs compares application compression/encoding and web/benchmark.mjs samples browser Brotli qualities. These measurements write under .cache; use private redirected logs for long runs. [VALIDATION.md](VALIDATION.md) records the matching successful tests, and dist/build-report.json contains the exact module/payload manifest.
