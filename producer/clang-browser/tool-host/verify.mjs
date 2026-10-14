import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [wasmPath, resultPath, ...flags] = process.argv.slice(2);
assert(wasmPath && resultPath, "usage: node verify.mjs clang.wasm module.json");
assert(
  flags.every((flag) =>
    ["--initial-cwd", "--kind=clang", "--kind=lld"].includes(flag),
  ),
);
const initialCwd = flags.includes("--initial-cwd");
assert(flags.filter((flag) => flag.startsWith("--kind=")).length <= 1, "ambiguous tool kind");
const kind = flags.includes("--kind=lld") ? "lld" : "clang";
const bytes = await readFile(wasmPath);
const module = await WebAssembly.compile(bytes);
const imports = WebAssembly.Module.imports(module);
const exports = WebAssembly.Module.exports(module);
const bridge = imports.filter((item) => item.module === "wasm_idle_tool_host");
assert.deepEqual(
  bridge,
  [{ module: "wasm_idle_tool_host", name: "exec_v1", kind: "function" }],
);
assert.deepEqual(
  imports.filter((item) => item.module === "wasm_idle_process_v1"),
  initialCwd
    ? [
        {
          module: "wasm_idle_process_v1",
          name: "initial_cwd",
          kind: "function",
        },
      ]
    : [],
);
assert(
  imports.every(
    (item) =>
      item.kind === "function" &&
      (item.module === "wasi_snapshot_preview1" ||
        item.module === "wasm_idle_tool_host" ||
        (initialCwd && item.module === "wasm_idle_process_v1")),
  ),
);
assert(
  exports.some((item) => item.name === "memory" && item.kind === "memory"),
);
assert(
  exports.some((item) => item.name === "_start" && item.kind === "function"),
);

// WebAssembly.Module.imports omits signatures. Read the two relevant standard
// sections and verify the bridge's exact type instead of trusting its name.
class Cursor {
  constructor(data) {
    this.data = data;
    this.offset = 0;
  }
  byte() {
    assert(this.offset < this.data.length, "truncated Wasm");
    return this.data[this.offset++];
  }
  u32() {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      if (shift === 28) assert(byte < 16, "u32 overflow");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("invalid u32");
  }
  slice(size) {
    assert(size <= this.data.length - this.offset, "truncated section");
    const slice = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return slice;
  }
  name() {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      this.slice(this.u32()),
    );
  }
}

const reader = new Cursor(bytes.subarray(8));
const types = [];
let signature;
let cwdSignature;
while (reader.offset < reader.data.length) {
  const id = reader.byte();
  const section = new Cursor(reader.slice(reader.u32()));
  if (id === 1) {
    const count = section.u32();
    for (let i = 0; i < count; i++) {
      assert.equal(section.byte(), 0x60, "expected core function type");
      const parameters = [...section.slice(section.u32())];
      const results = [...section.slice(section.u32())];
      types.push({ parameters, results });
    }
  } else if (id === 2) {
    const count = section.u32();
    for (let i = 0; i < count; i++) {
      const namespace = section.name();
      const name = section.name();
      assert.equal(section.byte(), 0, "expected only function imports");
      const type = types[section.u32()];
      if (namespace === "wasm_idle_tool_host" && name === "exec_v1")
        signature = type;
      if (namespace === "wasm_idle_process_v1" && name === "initial_cwd")
        cwdSignature = type;
    }
  }
}
assert.deepEqual(
  signature,
  {
    parameters: Array(7).fill(0x7f),
    results: [0x7f],
  },
);
assert.deepEqual(
  cwdSignature,
  initialCwd ? { parameters: [0x7f, 0x7f], results: [0x7f] } : undefined,
);
await writeFile(
  resultPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      imports,
      exports,
      kind,
      bridgeSignature: { parameters: Array(7).fill("i32"), results: ["i32"] },
      childDispatch: kind === "clang" ? "pinned linker; explicit compiler cc1/cc1as opt-in" : "deny",
      cwdSignature: initialCwd
        ? { parameters: ["i32", "i32"], results: ["i32"] }
        : null,
    },
    null,
    2,
  ) + "\n",
);
