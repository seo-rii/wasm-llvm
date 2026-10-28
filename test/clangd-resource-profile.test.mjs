import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { clangdResourceProfile } from "../producer/clang-browser/scripts/resource-profile.mjs";
import {
  lowerImportedMemory,
  transformGlue,
  prepare,
} from "../producer/clang-browser/scripts/prepare-resource-experiment.mjs";
test("release defaults remain hardware-based and 2 GiB", () => {
  assert.deepEqual(clangdResourceProfile({}), {
    initialMemoryMiB: 2048,
    pthreadPoolSize: "auto",
    poolExpression: "Math.max(navigator.hardwareConcurrency, 8)",
  });
  assert.deepEqual(
    clangdResourceProfile({ CLANGD_PTHREAD_POOL_SIZE: "auto" }),
    clangdResourceProfile({}),
  );
  assert.equal(
    clangdResourceProfile({
      CLANGD_INITIAL_MEMORY_MIB: "512",
      CLANGD_PTHREAD_POOL_SIZE: "4",
    }).poolExpression,
    "4",
  );
});
test("explicit headers require matching receipts and remain identical across profiles", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "clangd-resources-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wasm = Buffer.from([
    0, 97, 115, 109, 1, 0, 0, 0, 2, 13, 1, 1, 97, 1, 97, 2, 3, 128, 128, 2, 128,
    128, 4,
  ]);
  const js = Buffer.from(
    'Module["INITIAL_MEMORY"]||2147483648;var pthreadPoolSize=Math.max(navigator.hardwareConcurrency,8);Module["callMain"]=callMain;',
  );
  const rawHeaders = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      version: "llvmorg-22.1.8:ca7933e47d3a3451d81e72ac174dcb5aa28b59d1",
      targetTriple: "wasm32-wasi",
      resourceDir: "/lib/clang/22",
      files: { "/lib/clang/22/include/stddef.h": "test header" },
    }),
  );
  const gzip = gzipSync(wasm),
    headers = gzipSync(rawHeaders);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const receipt = (bytes, raw = bytes) => ({
    bytes: bytes.length,
    sha256: hash(bytes),
    uncompressedBytes: raw.length,
    uncompressedSha256: hash(raw),
  });
  await Promise.all([
    writeFile(path.join(directory, "clangd.js"), js),
    writeFile(path.join(directory, "clangd.wasm.gz"), gzip),
    writeFile(path.join(directory, "headers.gz"), headers),
  ]);
  const expected = {
    "clangd.js": receipt(js),
    "clangd.wasm.gz": receipt(gzip, wasm),
    "clangd.headers.json.gz": receipt(headers, rawHeaders),
  };
  const out = path.join(directory, "output"),
    headersPath = path.join(directory, "headers.gz");
  await assert.rejects(
    prepare({
      directory,
      expected: {
        ...expected,
        "clangd.headers.json.gz": {
          ...expected["clangd.headers.json.gz"],
          sha256: "0".repeat(64),
        },
      },
      out,
      headersPath,
    }),
  );
  await assert.rejects(access(out));
  const result = await prepare({ directory, expected, out, headersPath });
  for (const fixture of Object.values(result.clangd)) {
    assert.equal(fixture.headers, "clangd.headers.json.gz");
    assert.deepEqual(
      fixture.integrity[fixture.headers],
      receipt(headers, rawHeaders),
    );
  }
  for (const [name, filename] of Object.entries(result.files)) {
    if (name.endsWith("/clangd.headers.json.gz"))
      assert.deepEqual(await readFile(filename), headers);
  }
});
test("rejects arbitrary expressions and unsafe memory/pool sizes", () => {
  for (const env of [
    { CLANGD_INITIAL_MEMORY_MIB: "127" },
    { CLANGD_INITIAL_MEMORY_MIB: "4097" },
    { CLANGD_PTHREAD_POOL_SIZE: "0" },
    { CLANGD_PTHREAD_POOL_SIZE: "navigator.hardwareConcurrency" },
    { CLANGD_INITIAL_MEMORY_MIB: "512;exit" },
  ])
    assert.throws(() => clangdResourceProfile(env));
});
test("experiment rewrites memory import section lengths, retaining shared maximum", () => {
  const wasm = Buffer.from([
    0, 97, 115, 109, 1, 0, 0, 0, 2, 12, 1, 1, 97, 1, 97, 2, 3, 128, 128, 2, 128,
    128, 4,
  ]);
  // Import payload has 13 bytes; this catches accidental offsets/layout assumptions.
  wasm[9] = 13;
  assert(WebAssembly.validate(wasm));
  const small = lowerImportedMemory(wasm, 8192);
  assert(WebAssembly.validate(small));
  assert.equal(small.length, wasm.length - 1);
  assert.doesNotThrow(
    () =>
      new WebAssembly.Instance(new WebAssembly.Module(small), {
        a: {
          a: new WebAssembly.Memory({
            initial: 8192,
            maximum: 65536,
            shared: true,
          }),
        },
      }),
  );
  assert.throws(() => lowerImportedMemory(small, 4096), /shipped/);
});
test("unknown or duplicated generated glue fails closed", () => {
  const source =
    'Module["INITIAL_MEMORY"]||2147483648;var pthreadPoolSize=Math.max(navigator.hardwareConcurrency,8);Module["callMain"]=callMain;';
  const result = transformGlue(source, { memoryMiB: 512, pool: 4 }, 2);
  assert.match(result, /536870912/);
  assert.match(result, /-j=2/);
  assert.throws(() =>
    transformGlue(source + source, { memoryMiB: 512, pool: 4 }, 2),
  );
  assert.throws(() => transformGlue("unknown", { memoryMiB: 512, pool: 4 }, 2));
});
