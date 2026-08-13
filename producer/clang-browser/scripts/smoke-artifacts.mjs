#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  configure,
} from "@zip.js/zip.js";
import { assertClangdStdinBridge } from "./clangd-artifact-contract.mjs";

configure({ useWebWorkers: false });

const gunzipAsync = promisify(gunzip);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const artifactDir = path.resolve(
  process.env.WASM_LLVM_CLANG_ARTIFACT_DIR ||
    path.join(repoRoot, "artifacts", "clang-browser"),
);

async function readZipEntries(filePath) {
  const reader = new ZipReader(
    new Uint8ArrayReader(await fs.readFile(filePath)),
  );
  try {
    const entries = await reader.getEntries();
    return await Promise.all(
      entries
        .filter((entry) => !entry.directory && "getData" in entry)
        .map(async (entry) => ({
          name: entry.filename,
          bytes: await entry.getData(new Uint8ArrayWriter()),
        })),
    );
  } finally {
    await reader.close();
  }
}

async function readSingleZipEntry(filePath, expectedName) {
  const entries = await readZipEntries(filePath);
  if (entries.length !== 1 || entries[0].name !== expectedName) {
    throw new Error(
      `${path.basename(filePath)} must contain only ${expectedName}; found ${entries
        .map((entry) => entry.name)
        .join(", ")}`,
    );
  }
  return entries[0].bytes;
}

async function compileWasm(label, bytes) {
  if (
    bytes.length < 8 ||
    !Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from("\0asm"))
  ) {
    throw new Error(`${label} does not contain a WebAssembly module`);
  }
  await WebAssembly.compile(bytes);
}

await compileWasm(
  "clang.zip",
  await readSingleZipEntry(path.join(artifactDir, "clang.zip"), "clang"),
);
await compileWasm(
  "lld.zip",
  await readSingleZipEntry(path.join(artifactDir, "lld.zip"), "lld"),
);

const sysroot = await readSingleZipEntry(
  path.join(artifactDir, "sysroot.tar.zip"),
  "sysroot.tar",
);
if (sysroot.length < 1024)
  throw new Error("sysroot.tar.zip contains an empty sysroot");
const sysrootEntries = new Set();
for (let offset = 0; offset + 512 <= sysroot.length; ) {
  const header = sysroot.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) break;
  const name = Buffer.from(header.subarray(0, 100))
    .toString("utf8")
    .replace(/\0.*$/s, "");
  const prefix = Buffer.from(header.subarray(345, 500))
    .toString("utf8")
    .replace(/\0.*$/s, "");
  const sizeText = Buffer.from(header.subarray(124, 136))
    .toString("utf8")
    .replace(/\0.*$/s, "")
    .trim();
  const size = Number.parseInt(sizeText || "0", 8);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(
      `sysroot.tar contains an invalid size for ${name || "<unnamed>"}`,
    );
  }
  sysrootEntries.add(
    `${prefix ? `${prefix}/` : ""}${name}`.replace(/^\.\//, ""),
  );
  offset += 512 + Math.ceil(size / 512) * 512;
}
for (const requiredEntry of [
  "lib/wasm32-wasi/crt1.o",
  "lib/wasm32-wasi/libc.a",
  "lib/wasm32-wasi/libc++.a",
  "lib/wasm32-wasi/libc++abi.a",
  "lib/wasm32-wasi/libm.a",
  "lib/wasm32-wasi/libwasi-emulated-mman.a",
]) {
  if (!sysrootEntries.has(requiredEntry)) {
    throw new Error(
      `sysroot.tar is missing required runtime file: ${requiredEntry}`,
    );
  }
}

const memfsEntries = await readZipEntries(path.join(artifactDir, "memfs.zip"));
if (memfsEntries.length === 0)
  throw new Error("memfs.zip does not contain any files");

const clangdWasm = await gunzipAsync(
  await fs.readFile(path.join(artifactDir, "clangd", "clangd.wasm.gz")),
);
await compileWasm("clangd/clangd.wasm.gz", clangdWasm);

const clangdJs = await fs.readFile(
  path.join(artifactDir, "clangd", "clangd.js"),
  "utf8",
);
if (!clangdJs.includes("WebAssembly")) {
  throw new Error("clangd/clangd.js does not look like an Emscripten loader");
}
await assertClangdStdinBridge(clangdJs, clangdWasm);

console.log(
  `Smoke-checked Clang, LLD, sysroot, MemFS, and clangd artifacts in ${artifactDir}`,
);
