// Producer-only qualification against Node's real WASI filesystem. Container
// VFS, Worker cancellation, browser behavior and full sysroots have separate gates.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { WASI } from "node:wasi";
import { fileURLToPath } from "node:url";

const [candidateArgument, outputArgument] = process.argv.slice(2);
assert(
  candidateArgument && outputArgument,
  "usage: node --disable-wasm-trap-handler smoke-cli.mjs CANDIDATE NEW_OUTPUT",
);
const candidate = realpathSync(candidateArgument);
const output = path.resolve(outputArgument);
assert(!existsSync(output), "smoke output must be new");
const parent = realpathSync(path.dirname(output));
const canonicalOutput = path.join(parent, path.basename(output));
assert(
  canonicalOutput !== candidate &&
    !canonicalOutput.startsWith(candidate + path.sep) &&
    !candidate.startsWith(canonicalOutput + path.sep),
  "output must not overlap candidate",
);
const producer = JSON.parse(
  readFileSync(path.join(candidate, "build-receipt.json"), "utf8"),
);
assert.equal(producer.complete, true, "completed producer receipt required");
assert.equal(producer.readOnlyInputsUnchanged, true);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = {};
const modules = {};
for (const name of ["clang", "lld"]) {
  const bytes = readFileSync(path.join(candidate, `${name}.wasm`));
  const identity = { bytes: bytes.length, sha256: hash(bytes) };
  assert.deepEqual(identity, producer.outputs[`${name}.wasm`]);
  inputs[name] = identity;
  modules[name] = new WebAssembly.Module(bytes);
}

mkdirSync(output, { mode: 0o700 });
const root = path.join(output, "root");
const cwd = "/workspace/project space/한글";
const project = path.join(root, cwd);
mkdirSync(path.join(project, "include"), { recursive: true });
mkdirSync(path.join(root, "opt/bin"), { recursive: true });
// A real executable node contains the pinned linker bytes; no empty placeholder.
const linkerPath = "/opt/bin/wasm-ld";
copyFileSync(path.join(candidate, "lld.wasm"), path.join(root, linkerPath));
chmodSync(path.join(root, linkerPath), 0o700);
writeFileSync(path.join(project, "include/value.h"), "#define PLUS 2\n");
writeFileSync(
  path.join(project, "part one.c"),
  '#include "value.h"\nint base(void){return VALUE+PLUS;}\n',
);
writeFileSync(
  path.join(project, "part two.c"),
  "int base(void); int answer(void){return base();}\n",
);
writeFileSync(
  path.join(project, "compile.rsp"),
  '--target=wasm32-wasi -Iinclude -DVALUE=40 -c "part one.c" -o "part one.o"\n',
);
writeFileSync(path.join(project, "broken.c"), "int broken( {\n");
const commands = [];
const dispatches = [];
const rejectedDispatches = [];
const decoder = new TextDecoder("utf-8", { fatal: true });

function invoke(kind, argv, env, descriptors, depth = 0) {
  assert(depth <= 1, "unexpected recursive subprocess");
  const wasi = new WASI({
    version: "preview1",
    args: argv,
    env,
    preopens: { "/": root },
    returnOnExit: true,
    stdin: descriptors[0],
    stdout: descriptors[1],
    stderr: descriptors[2],
  });
  let instance;
  const string = (pointer, length) => {
    pointer >>>= 0;
    length >>>= 0;
    const bytes = new Uint8Array(instance.exports.memory.buffer);
    assert(
      length <= 1024 * 1024 &&
        pointer <= bytes.length &&
        length <= bytes.length - pointer,
      "out-of-bounds guest string",
    );
    const value = decoder.decode(bytes.subarray(pointer, pointer + length));
    assert(!value.includes("\0"));
    return value;
  };
  const table = (pointer, count) => {
    pointer >>>= 0;
    count >>>= 0;
    const memory = instance.exports.memory.buffer;
    assert(
      count <= 4096 &&
        pointer <= memory.byteLength &&
        count * 8 <= memory.byteLength - pointer,
    );
    const view = new DataView(memory);
    const values = [];
    let total = 0;
    for (let index = 0; index < count; index++) {
      const offset = pointer + index * 8;
      const length = view.getUint32(offset + 4, true);
      total += length;
      assert(total <= 1024 * 1024);
      values.push(string(view.getUint32(offset, true), length));
    }
    return values;
  };
  const imports = {
    ...wasi.getImportObject(),
    wasm_idle_process_v1: {
      initial_cwd(pointer, capacity) {
        pointer >>>= 0;
        capacity >>>= 0;
        const bytes = new Uint8Array(instance.exports.memory.buffer);
        const encoded = new TextEncoder().encode(cwd + "\0");
        assert(capacity <= bytes.length && pointer <= bytes.length - capacity);
        if (capacity < encoded.length) return -1;
        bytes.set(encoded, pointer);
        return encoded.length;
      },
    },
    wasm_idle_tool_host: {
      exec_v1(
        programPointer,
        programLength,
        argvPointer,
        argc,
        envPointer,
        envc,
        flags,
      ) {
        if (kind !== "clang" || depth !== 0) {
          rejectedDispatches.push({ kind, depth, result: -1 });
          return -1;
        }
        const program = string(programPointer, programLength);
        assert.equal(program, linkerPath, "only the pinned linker may execute");
        assert(flags === 0 || flags === 1);
        const childArgv = table(argvPointer, argc);
        let childEnv = env;
        if (flags === 0) {
          childEnv = Object.create(null);
          for (const item of table(envPointer, envc)) {
            const separator = item.indexOf("=");
            assert(separator > 0);
            childEnv[item.slice(0, separator)] = item.slice(separator + 1);
          }
        }
        const code = invoke("lld", childArgv, childEnv, descriptors, depth + 1);
        dispatches.push({ program, argv: childArgv, flags, code, cwd });
        return code;
      },
    },
  };
  instance = new WebAssembly.Instance(modules[kind], imports);
  return wasi.start(instance);
}

function command(label, args, expectedCode = 0) {
  const stdout = path.join(output, `${label}.stdout`);
  const stderr = path.join(output, `${label}.stderr`);
  const descriptors = [
    openSync("/dev/null", "r"),
    openSync(stdout, "wx", 0o600),
    openSync(stderr, "wx", 0o600),
  ];
  const started = performance.now();
  let code;
  try {
    code = invoke(
      "clang",
      ["clang", ...args],
      { LANG: "C", PWD: "/deliberately-wrong" },
      descriptors,
    );
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
  const result = {
    label,
    argv: ["clang", ...args],
    cwd,
    code,
    durationMs: performance.now() - started,
    stdout: readFileSync(stdout).toString("utf8"),
    stderr: readFileSync(stderr).toString("utf8"),
  };
  commands.push(result);
  assert.equal(code, expectedCode, `${label}: ${result.stderr}`);
}

let passed = false;
try {
  command("version", ["--version"]);
  assert.match(commands.at(-1).stdout, /clang version/);
  command("response", ["@compile.rsp"]);
  command("object", [
    "--target=wasm32-wasi",
    "-c",
    "part two.c",
    "-o",
    "part two.o",
  ]);
  command("preprocess", [
    "--target=wasm32-wasi",
    "-Iinclude",
    "-DVALUE=40",
    "-E",
    "part one.c",
    "-o",
    "part one.i",
  ]);
  assert.match(
    readFileSync(path.join(project, "part one.i"), "utf8"),
    /return\s+40\s*\+\s*2/,
  );
  command("assembly", [
    "--target=wasm32-wasi",
    "-Iinclude",
    "-DVALUE=40",
    "-S",
    "part one.c",
    "-o",
    "part one.s",
  ]);
  assert(statSync(path.join(project, "part one.s")).size > 0);
  command(
    "diagnostic",
    ["--target=wasm32-wasi", "-c", "broken.c", "-o", "broken.o"],
    1,
  );
  assert.match(commands.at(-1).stderr, /error:/);
  command("link", [
    "--target=wasm32-wasi",
    `--ld-path=${linkerPath}`,
    "-nostdlib",
    "-Wl,--no-entry",
    "-Wl,--export=answer",
    "part one.o",
    "part two.o",
    "-o",
    "answer.wasm",
  ]);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].code, 0);
  const artifact = new WebAssembly.Module(
    readFileSync(path.join(project, "answer.wasm")),
  );
  assert.deepEqual(WebAssembly.Module.imports(artifact), []);
  assert.equal(new WebAssembly.Instance(artifact).exports.answer(), 42);
  passed = true;
} finally {
  writeFileSync(
    path.join(output, "receipt.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        passed,
        qualification:
          "producer Node WASI freestanding CLI smoke; not container/browser/sysroot qualification",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        fixtureSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
        producerReceiptSha256: hash(
          readFileSync(path.join(candidate, "build-receipt.json")),
        ),
        inputs,
        sourceRevision: producer.source.revision,
        linkTimeOptimization: producer.linkTimeOptimization,
        commands,
        dispatches,
        rejectedDispatches,
        executedArtifactResult: passed ? 42 : null,
      },
      null,
      2,
    ) + "\n",
  );
}
process.stdout.write(
  JSON.stringify({
    passed,
    commands: commands.length,
    dispatches: dispatches.length,
    result: 42,
  }) + "\n",
);
