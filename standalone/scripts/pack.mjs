import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"
import { isUtf8 } from "node:buffer"
import { alphabet, encodePayload, decodePayload } from "./encoding.mjs"
import { utf8Ranges, encodeUtf8Payload, decodeUtf8Payload } from "./utf8.mjs"

export function decodePackedPayload(encoded, entry) {
  if (encoded.length !== entry.length) throw new Error("Truncated standalone payload")
  if (entry.encoding !== "base95" && entry.encoding !== "utf8-words") throw new Error("Unknown embedded payload encoding")
  const bytes = entry.encoding === "utf8-words" ? decodeUtf8Payload(encoded, entry.storedBytes, utf8Ranges) : decodePayload(encoded, entry.storedBytes, alphabet)
  const raw = entry.brotli ? brotliDecompressSync(bytes) : bytes
  if (raw.length !== entry.bytes) throw new Error("Embedded payload size differs from its record")
  return raw
}

// The payload lives in a comment: Node need not parse a giant JS string for web
// assets. Offsets refer to this same file; no executable or asset is extracted.
export function packArtifact(metadata, inputs, options = {}) {
  const encoding = options.encoding ?? "base95"
  if (encoding !== "base95" && encoding !== "utf8-words") throw new Error("Unknown embedded payload encoding")
  let offset = 0
  const entries = Object.entries(inputs).map(([name, input]) => {
    const raw = Buffer.from(input.bytes)
    const data = input.compressed === false ? raw : brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: input.quality ?? 6,
        [constants.BROTLI_PARAM_LGWIN]: input.window ?? 22,
      },
    })
    const encoded = encoding === "utf8-words" ? encodeUtf8Payload(data) : Buffer.from(encodePayload(data), "ascii")
    const record = { offset, length: encoded.length, encoding, brotli: input.compressed !== false, storedBytes: data.length, bytes: raw.length }
    offset += encoded.length + 1
    return { name, encoded, record }
  })
  const records = Object.fromEntries(entries.map(({ name, record }) => [name, record]))
  const header = `#!/usr/bin/env node
// OpenCode standalone experimental distribution. Project: MIT.
// Embedded third-party notices: --standalone-licenses.
"use strict";
(async () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 26 || (major === 26 && minor < 4)) throw new Error("opencode-standalone requires Node.js 26.4 or later");
  const metadata = ${JSON.stringify(metadata)};
  if (process.argv[2] === "--standalone-info") {
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }
  const records = ${JSON.stringify(records)};
  const decode = ${(encoding === "utf8-words" ? decodeUtf8Payload : decodePayload).toString()};
  const base = Number("0000000000");
  const read = (name) => {
    const entry = records[name];
    if (!entry) throw new Error("Missing embedded payload: " + name);
    const fs = process.getBuiltinModule("node:fs");
    const fd = fs.openSync(process.argv[1], "r");
    const encoded = Buffer.alloc(entry.length);
    try {
      let position = 0;
      while (position < encoded.length) {
        const count = fs.readSync(fd, encoded, position, encoded.length - position, base + entry.offset + position);
        if (count === 0) throw new Error("Truncated standalone payload: " + name);
        position += count;
      }
    } finally { fs.closeSync(fd); }
    const bytes = decode(encoded, entry.storedBytes, ${JSON.stringify(encoding === "utf8-words" ? utf8Ranges : alphabet)});
    return entry.brotli ? process.getBuiltinModule("node:zlib").brotliDecompressSync(bytes) : bytes;
  };
  if (process.argv[2] === "--standalone-licenses") {
    console.log(read("licenses").toString("utf8"));
    return;
  }
  if (!process.execArgv.includes("--experimental-ffi")) {
    const child = process.getBuiltinModule("node:child_process").spawn(process.execPath, [...process.execArgv, "--experimental-ffi", ...process.argv.slice(1)], { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
    child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
    child.once("exit", (code, signal) => { process.exitCode = code ?? (128 + (process.getBuiltinModule("node:os").constants.signals[signal] ?? 1)); });
    return;
  }
  globalThis[Symbol.for("opencode.standalone.web-archive")] = () => read("web");
  const modules = { "opencode-standalone:app": "app", "opencode-standalone:pty": "pty", "opencode-standalone:daemon": "daemon", "opencode-standalone:tui": "tui" };
  process.getBuiltinModule("node:module").registerHooks({
    resolve(specifier, context, nextResolve) {
      return Object.hasOwn(modules, specifier) ? { url: specifier, shortCircuit: true } : nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      return Object.hasOwn(modules, url) ? { format: "module", source: read(modules[url]), shortCircuit: true } : nextLoad(url, context);
    },
  });
  const entry = process.argv[2] === "--standalone-pty-exec" ? "pty" : process.argv[2] === "--standalone-persistent-pty-daemon" ? "daemon" : "app";
  await import("opencode-standalone:" + entry);
})().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
`
  const start = Buffer.byteLength(header + "\n/*\n")
  if (String(start).length > 10) throw new Error("Standalone header exceeds offset field")
  const bytes = Buffer.concat([
    Buffer.from(header.replace('Number("0000000000")', `Number("${String(start).padStart(10, "0")}")`) + "\n/*\n"),
    ...entries.flatMap((entry) => [entry.encoded, Buffer.from("\n")]),
    Buffer.from("*/\n"),
  ])
  if (!isUtf8(bytes)) throw new Error("Standalone artifact must remain valid UTF-8")
  return { bytes, records }
}
