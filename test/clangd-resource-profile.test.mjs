import { test } from "node:test";
import assert from "node:assert/strict";
import { clangdResourceProfile } from "../producer/clang-browser/scripts/resource-profile.mjs";
import {
  lowerImportedMemory,
  transformGlue,
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
