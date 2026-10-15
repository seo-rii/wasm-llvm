import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { WASI } from "node:wasi";
import path from "node:path";

const [wasmPath, root, resultPath] = process.argv.slice(2);
assert(wasmPath && root && resultPath);
const cwd = "/workspace/한글 space";
await mkdir(path.join(root, cwd), { recursive: true });
await writeFile(path.join(root, cwd, "input.txt"), "cwd-ok\n");
const module = await WebAssembly.compile(await readFile(wasmPath));
const results = [];
for (const mode of [
  "valid",
  "reject",
  "empty",
  "relative",
  "embedded-nul",
  "too-large",
  "missing",
  "valid",
]) {
  const wasi = new WASI({
    version: "preview1",
    args: ["cwd-fixture", cwd],
    env: { PWD: "/deliberately-wrong" },
    preopens: { "/": root },
    returnOnExit: true,
  });
  let instance;
  let calls = 0;
  instance = await WebAssembly.instantiate(module, {
    ...wasi.getImportObject(),
    wasm_idle_process_v1: {
      initial_cwd(pointer, capacity) {
        calls++;
        assert.equal(capacity, 4096);
        const memory = new Uint8Array(instance.exports.memory.buffer);
        assert(pointer >= 0 && capacity <= memory.length - pointer);
        if (mode === "reject") return -1;
        if (mode === "too-large") return capacity + 1;
        const text =
          mode === "empty"
            ? ""
            : mode === "relative"
              ? "workspace"
              : mode === "embedded-nul"
                ? "/workspace\0/misleading"
                : mode === "missing"
                  ? "/missing"
                  : cwd;
        const bytes = new TextEncoder().encode(text + "\0");
        memory.set(bytes, pointer);
        return bytes.length;
      },
    },
  });
  const code = wasi.start(instance);
  assert.equal(code, mode === "valid" ? 0 : 125);
  assert.equal(calls, 1);
  results.push({ mode, code });
}
await writeFile(
  resultPath,
  JSON.stringify(
    {
      passed: true,
      node: process.version,
      cwd,
      pwdIgnored: true,
      relativeFileRead: "cwd-ok\n",
      results,
    },
    null,
    2,
  ) + "\n",
);
