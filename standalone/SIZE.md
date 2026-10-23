# Distribution size

The complete verified file is **29,079,504 bytes**, 14,863,014 bytes (33.82%) smaller than the original **43,942,518 bytes** (SHA-256 09793cdadc6642dd48e343d67bbbe9a4320c407e151a5901115ea7555ba2ecb8), 8,515,794 bytes (22.65%) smaller than the first public **37,595,298-byte** distribution, and 491,441 bytes (1.66%) smaller than the previous **29,570,945-byte** release. Compared with the earlier **35,628,036-byte headless checkpoint**, it is 6,548,532 bytes (18.38%) smaller; it includes the actual default/mini TUI, Solid, parser worker, native image/ICC resources, embedded Ghostty terminal and desktop clipboard protocols. Its current SHA-256 is 8d963c69449a2504030379ea376f86211188b701b13cf12955d73f34c395efe0.

The application is minified with esbuild keepNames followed by Terser 5.51.2, preserving function/class names and function argument counts. It is Brotli-compressed with a 16 MiB window and stored as comment-safe **utf8-ans**. The additional minification reduced the measured compressed application from 5,401,886 to 5,284,357 bytes. This build-only pass took about 6.5 minutes on the measured host; exact source, options and tool-version matches reuse a hash-checked cache. The TUI factory has an independent compressed module inside the same JS file; it is not a second distribution file. Standard Node APIs decode the selected payload without extracting modules, WASM, addons or browser assets.

The payload encoding uses a fixed-integer rANS model over a pinned safe Unicode alphabet, approaching the alphabet's capacity of 6.85 bits per UTF-8 byte. It contains no NUL, ASCII controls, bidi/format controls, surrogates, Unicode noncharacters or comment-closing delimiters. The complete file remains valid UTF-8 JavaScript. Compared on the previous payloads, it saves 356,317 bytes over four-byte codewords. Five interleaved measurements of the final validated decoder added about 140 ms of application decoding CPU and 322 ms when the web payload is first decoded. Parser-only checks changed CPU by about 3 ms and reduced median peak RSS by about 3.7 MiB. Its Unicode source can use roughly 20–30 MiB more parsing memory than ASCII-only source. The legacy base95 and four-byte UTF-8 packing APIs remain available for comparison.

Five pairs of copied-file `--version` runs compare the previous distribution with this exact final artifact, using fresh HOME/XDG/cwd, an empty PATH, --no-addons and preenabled FFI. Median process CPU rises from 3,266 to 3,446 ms (+5.5%); median peak RSS falls from 563 to 534 MiB. The complete application and payload decoder are included in these measurements. Concurrent verification affected wall time, so these figures describe the measured host rather than a general startup guarantee.

| Payload | Input bytes | Stored bytes | UTF-8 bytes |
| --- | ---: | ---: | ---: |
| app | 27,290,682 | 5,284,357 | 6,171,009 |
| pty | 1,851 | 824 | 973 |
| daemon | 329,979 | 235,342 | 274,846 |
| licenses | 1,710,295 | 37,274 | 43,543 |
| tui | 1,231,863 | 892,888 | 1,042,703 |
| web | 18,491,347 | 18,441,456 | 21,535,733 |

Input sizes describe modules or the hybrid browser archive before outer packing. Related JavaScript, text and raw fonts share Brotli quality 11 groups, each limited to 32 MiB before compression. Office WASM shares a separate group capped at 40 MiB, using an internal 32 MiB Brotli window. Already compressed media keep individual Brotli payloads. Identical assets share storage. The browser archive shrank from **27,101,364** to **18,491,347 bytes**; the original 1,688 URLs and every decompressed byte were preserved. The current packed archive decodes to SHA-256 e02672d27255f3226004f97bf157820b29d0c675689c85d07340d638a1a7c4dd.

Groups are decompressed on demand with a 48 MiB cache. Standard browser-compatible Brotli HTTP responses are generated at quality 1 for Office WASM and quality 4 for other grouped assets, then cached up to 16 MiB; requests without Brotli read the original bytes directly. A cold Office request adds about 0.3 seconds of group decoding and recompression in the measured host. Its compressed responses are larger than individually stored quality 11 payloads (the largest DOCX WASM is about 7.21 MB instead of 4.42 MB). The original web handler retains content types, CSP, caching and encoding negotiation. Web assets remain unloaded during CLI startup. Application windows, Unicode parsing and browser caches trade runtime memory and some first-request work for the smaller distribution.

The file retains the original Office WASM, fonts, browser code and all tested runtime features. Image/ICC and embedded-terminal vendor code is embedded WASM; system libc supplies host PTYs and input flushing. Larger compressed builds can take longer; their development tools are not runtime npm dependencies.

From standalone/, scripts/size-benchmark.mjs compares application compression/encoding and web/benchmark.mjs samples browser Brotli qualities. These measurements write under .cache; use private redirected logs for long runs. [VALIDATION.md](VALIDATION.md) records the matching successful tests, and dist/build-report.json contains the exact module/payload manifest.
