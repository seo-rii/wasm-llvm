import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WASI } from "node:wasi";

const [filename, resultPath] = process.argv.slice(2);
assert(
  filename && resultPath,
  "usage: node abi-fixture.mjs fixture.wasm result.json",
);
const bytes = await readFile(filename);
const wasi = new WASI({
  version: "preview1",
  args: ["abi-fixture"],
  returnOnExit: true,
});
const returns = [23, 0, 0, -1, -2];
const calls = [];
let instance;
const { wasi_snapshot_preview1 } = wasi.getImportObject();
instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {
  wasi_snapshot_preview1,
  wasm_idle_tool_host: {
    exec_v1(programPtr, programLen, argvPtr, argc, envPtr, envc, flags) {
      const data = new Uint8Array(instance.exports.memory.buffer);
      const view = new DataView(data.buffer);
      const string = (pointer, length) => {
        assert(pointer >= 0 && length >= 0 && length <= data.length - pointer);
        return new TextDecoder("utf-8", { fatal: true }).decode(
          data.subarray(pointer, pointer + length),
        );
      };
      const table = (pointer, count) => {
        assert(
          count >= 0 &&
            count < 16 &&
            pointer >= 0 &&
            count * 8 <= data.length - pointer,
        );
        return Array.from({ length: count }, (_, i) =>
          string(
            view.getUint32(pointer + i * 8, true),
            view.getUint32(pointer + i * 8 + 4, true),
          ),
        );
      };
      const call = {
        program: string(programPtr, programLen),
        argv: table(argvPtr, argc),
        env: table(envPtr, envc),
        flags,
      };
      assert.equal(call.program, "/toolchains/wasm-ld");
      assert.deepEqual(call.argv, ["wasm-ld", "space arg", "한글", ""]);
      assert.deepEqual(
        call.env,
        calls.length === 1 ? ["ONE=value space", "TWO="] : [],
      );
      assert.equal(flags, calls.length === 1 || calls.length === 2 ? 0 : 1);
      assert(
        calls.length < returns.length,
        "unsupported request reached the host",
      );
      const result = returns[calls.length];
      calls.push({ ...call, result });
      return result;
    },
  },
});
assert.equal(wasi.start(instance), 0);
assert.equal(calls.length, returns.length);
await writeFile(
  resultPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      node: process.version,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      calls,
      unsupportedRequestsRejectedBeforeHost: [
        "timeout",
        "memory",
        "redirect",
        "affinity",
      ],
      processStatistics: "unavailable",
      passed: true,
    },
    null,
    2,
  ) + "\n",
);
