#!/usr/bin/env node
// Controlled resource-only artifact experiment, NOT a source-built release.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { clangdResourceProfile } from "./resource-profile.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const receipt = (encoded, raw = encoded) => ({
  bytes: encoded.length,
  sha256: sha(encoded),
  uncompressedBytes: raw.length,
  uncompressedSha256: sha(raw),
});
function replaceOnce(text, before, after) {
  assert.equal(
    text.split(before).length,
    2,
    `Expected one generated-glue anchor: ${before}`,
  );
  return text.replace(before, after);
}
function leb(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

/** Edit only the imported shared memory minimum; reject unknown Wasm layouts. */
export function lowerImportedMemory(bytes, pages) {
  assert(
    Number.isInteger(pages) && pages >= 2048 && pages <= 32768,
    "Invalid memory pages",
  );
  assert.deepEqual(
    bytes.subarray(0, 8),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  let at = 8;
  const number = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      assert(at < bytes.length, "Truncated LEB");
      const byte = bytes[at++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Oversized LEB");
  };
  const name = () => {
    const length = number();
    at += length;
    assert(at <= bytes.length, "Truncated import");
  };
  while (at < bytes.length) {
    const section = at,
      id = bytes[at++],
      length = number(),
      start = at,
      end = at + length;
    assert(end <= bytes.length, "Truncated section");
    if (id !== 2) {
      at = end;
      continue;
    }
    let minimum;
    for (let count = number(); count > 0; count--) {
      name();
      name();
      const kind = bytes[at++];
      if (kind === 0) number();
      else if (kind === 1) {
        at++;
        const flags = number();
        number();
        if (flags & 1) number();
      } else if (kind === 2) {
        assert.equal(minimum, undefined, "Multiple imported memories");
        assert.equal(number(), 3, "Expected shared 32-bit memory with maximum");
        const offset = at;
        assert.equal(number(), 32768, "Expected shipped 2 GiB minimum");
        minimum = { offset, end: at };
        assert.equal(number(), 65536, "Expected 4 GiB maximum");
      } else if (kind === 3) at += 2;
      else if (kind === 4) {
        number();
        number();
      } else throw new Error("Unsupported import kind");
    }
    assert.equal(at, end, "Unexpected imports layout");
    assert(minimum, "Missing memory import");
    const imports = Buffer.concat([
      bytes.subarray(start, minimum.offset),
      leb(pages),
      bytes.subarray(minimum.end, end),
    ]);
    return Buffer.concat([
      bytes.subarray(0, section),
      Buffer.from([2]),
      leb(imports.length),
      imports,
      bytes.subarray(end),
    ]);
  }
  throw new Error("Missing import section");
}

export function transformGlue(source, profile, analysisThreads) {
  const settings = clangdResourceProfile({
    CLANGD_INITIAL_MEMORY_MIB: String(profile.memoryMiB),
    ...(profile.pool === "auto"
      ? {}
      : { CLANGD_PTHREAD_POOL_SIZE: String(profile.pool) }),
  });
  assert(
    Number.isInteger(analysisThreads) &&
      analysisThreads >= 0 &&
      analysisThreads <= 32,
  );
  let result = replaceOnce(
    source,
    'Module["INITIAL_MEMORY"]||2147483648',
    `Module["INITIAL_MEMORY"]||${settings.initialMemoryMiB * 1024 ** 2}`,
  );
  result = replaceOnce(
    result,
    "var pthreadPoolSize=Math.max(navigator.hardwareConcurrency,8)",
    `var pthreadPoolSize=${settings.poolExpression}`,
  );
  // Only benchmark variants override the empty argv supplied by the consumer.
  if (analysisThreads)
    result = replaceOnce(
      result,
      'Module["callMain"]=callMain;',
      `Module["callMain"]=(args)=>callMain(["-j=${analysisThreads}",...args]);`,
    );
  return result;
}

export async function prepare({ directory, expected, out, headersPath }) {
  const js = await readFile(path.join(directory, "clangd.js"));
  const gzip = await readFile(path.join(directory, "clangd.wasm.gz"));
  for (const [name, bytes] of [
    ["clangd.js", js],
    ["clangd.wasm.gz", gzip],
  ]) {
    assert.equal(bytes.length, expected[name].bytes, `${name} size`);
    assert.equal(sha(bytes), expected[name].sha256, `${name} SHA-256`);
  }
  const wasm = gunzipSync(gzip, { maxOutputLength: 128 * 1024 ** 2 });
  assert.equal(sha(wasm), expected["clangd.wasm.gz"].uncompressedSha256);
  let headerAsset;
  if (headersPath) {
    const encoded = await readFile(headersPath);
    const headerReceipt = expected["clangd.headers.json.gz"];
    assert(
      headerReceipt,
      "Explicit headers require encoded and decoded receipts",
    );
    assert.equal(encoded.length, headerReceipt.bytes);
    assert.equal(sha(encoded), headerReceipt.sha256);
    const raw = gunzipSync(encoded, { maxOutputLength: 128 * 1024 ** 2 });
    assert.equal(raw.length, headerReceipt.uncompressedBytes);
    assert.equal(sha(raw), headerReceipt.uncompressedSha256);
    const tree = JSON.parse(raw);
    assert.equal(
      tree.version,
      "llvmorg-22.1.8:ca7933e47d3a3451d81e72ac174dcb5aa28b59d1",
    );
    assert.equal(tree.targetTriple, "wasm32-wasi");
    assert.equal(tree.resourceDir, "/lib/clang/22");
    headerAsset = { encoded, raw, fileCount: Object.keys(tree.files).length };
  }
  await mkdir(out, { recursive: false });
  const fixtures = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files: {},
    compiler: {},
    clangd: {},
    experiment: {
      kind: "generated-resource-transform",
      sourceBuild: false,
      baseline: {
        "clangd.js": receipt(js),
        "clangd.wasm.gz": receipt(gzip, wasm),
      },
      warning:
        "Resource-only experiment. Do not publish transformed artifacts. Rebuild with producer flags and qualify before release.",
    },
  };
  const profiles = [
    { name: "baseline", memoryMiB: 2048, pool: "auto", threads: 0 },
    { name: "pool4-j2", memoryMiB: 2048, pool: 4, threads: 2 },
    { name: "memory512-pool4-j2", memoryMiB: 512, pool: 4, threads: 2 },
    { name: "memory256-pool2-j1", memoryMiB: 256, pool: 2, threads: 1 },
  ];
  if (headerAsset)
    fixtures.experiment.explicitHeaders = {
      ...receipt(headerAsset.encoded, headerAsset.raw),
      fileCount: headerAsset.fileCount,
      note: "The same full header asset is mounted in every arm; this differs from shipped embedded-plus-overlay delivery.",
    };
  for (const profile of profiles) {
    const raw =
      profile.memoryMiB === 2048
        ? wasm
        : lowerImportedMemory(wasm, profile.memoryMiB * 16);
    assert(WebAssembly.validate(raw), `Invalid Wasm: ${profile.name}`);
    const source =
      profile.name === "baseline"
        ? js
        : Buffer.from(
            transformGlue(js.toString("utf8"), profile, profile.threads),
          );
    const encoded =
      profile.memoryMiB === 2048 ? gzip : gzipSync(raw, { level: 9 });
    const target = path.join(out, profile.name, "clangd");
    await mkdir(target, { recursive: true });
    for (const [name, bytes] of [
      ["clangd.js", source],
      ["clangd.wasm.gz", encoded],
      ...(headerAsset ? [["clangd.headers.json.gz", headerAsset.encoded]] : []),
    ]) {
      const filename = path.join(target, name);
      await writeFile(filename, bytes);
      fixtures.files[`${profile.name}/clangd/${name}`] = path.resolve(filename);
    }
    fixtures.clangd[profile.name] = {
      basePath: `/${profile.name}/clangd/`,
      implementation: "current",
      headers: headerAsset ? "clangd.headers.json.gz" : false,
      integrity: {
        "clangd.js": receipt(source),
        "clangd.wasm.gz": receipt(encoded, raw),
        ...(headerAsset
          ? {
              "clangd.headers.json.gz": receipt(
                headerAsset.encoded,
                headerAsset.raw,
              ),
            }
          : {}),
      },
      profile,
    };
  }
  await writeFile(
    path.join(out, "fixtures.json"),
    JSON.stringify(fixtures, null, 2) + "\n",
  );
  return fixtures;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, receiptFile, out, headersPath] = process.argv.slice(2);
  if (!directory || !receiptFile || !out)
    throw new Error(
      "Usage: prepare-resource-experiment.mjs BASELINE_DIR RECEIPTS_JSON NEW_OUT_DIR [HEADERS_GZIP]",
    );
  await prepare({
    directory,
    expected: JSON.parse(await readFile(receiptFile, "utf8")),
    out,
    headersPath,
  });
}
