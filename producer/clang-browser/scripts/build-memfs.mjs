#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const scriptPath = fileURLToPath(import.meta.url);
const producerRoot = path.resolve(path.dirname(scriptPath), "..");
const manifest = JSON.parse(
  await fs.readFile(path.join(producerRoot, "manifest.json"), "utf8"),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const receiptFor = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) });

// Public function arities of the original 2c72ee42... MemFS module. Linking only these
// exports avoids modern wasm-ld's additional __stack_pointer global export.
const exportArity = {
  init: 0,
  fd_allocate: 3,
  fd_close: 1,
  fd_fdstat_get: 2,
  fd_fdstat_set_flags: 2,
  fd_filestat_get: 2,
  fd_filestat_set_size: 2,
  fd_pread: 5,
  fd_prestat_dir_name: 3,
  fd_prestat_get: 2,
  fd_read: 4,
  fd_readdir: 5,
  fd_seek: 4,
  fd_write: 4,
  path_create_directory: 3,
  path_filestat_get: 5,
  path_open: 9,
  path_readlink: 6,
  path_remove_directory: 3,
  path_rename: 6,
  path_symlink: 5,
  path_unlink_file: 3,
  GetPathBuf: 0,
  GetPathBufLen: 0,
  FindNode: 1,
  AddDirectoryNode: 1,
  AddFileNode: 2,
  GetFileNodeAddress: 1,
  GetFileNodeSize: 1,
};
const importNames = [
  "copy_in",
  "copy_out",
  "host_read",
  "host_write",
  "memfs_log",
];

export async function fetchMemfsSources({
  workDir,
  source = manifest.sources.memfs,
  fetchImpl = fetch,
}) {
  if (!/^[a-f0-9]{40}$/.test(source.commit))
    throw new Error("MemFS source needs an immutable commit");
  const directory = path.join(workDir, "source");
  await fs.mkdir(directory, { recursive: true });
  const receipts = {};
  for (const [name, pin] of Object.entries(source.files)) {
    if (path.basename(name) !== name)
      throw new Error("Invalid MemFS source filename");
    const filePath = path.join(directory, name);
    const url = `${source.repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${source.commit}/${pin.path}`;
    let bytes = await fs.readFile(filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!bytes) {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new Error(`MemFS source HTTP ${response.status}: ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) {
      throw new Error(`MemFS source ${name} SHA-256/size mismatch`);
    }
    await fs.writeFile(filePath, bytes);
    receipts[name] = { url, ...receiptFor(bytes) };
  }
  return { directory, receipts };
}

function modernizeSource(original, maxNodes) {
  let source = original;
  const replace = (pattern, replacement) => {
    if (!pattern.test(source))
      throw new Error(`MemFS compatibility patch did not match ${pattern}`);
    pattern.lastIndex = 0;
    source = source.replace(pattern, replacement);
  };
  replace(/#include <wasi\/core.h>/, "#include <wasi/api.h>");
  replace(/#define MAX_NODES 1024\b/, `#define MAX_NODES ${maxNodes}`);
  for (const name of [
    "BADF",
    "EXIST",
    "INVAL",
    "MFILE",
    "NODEV",
    "NOENT",
    "NOTCAPABLE",
    "NOTDIR",
    "SUCCESS",
  ]) {
    replace(new RegExp(`__WASI_E${name}\\b`, "g"), `__WASI_ERRNO_${name}`);
  }
  for (const [before, after] of [
    ["__WASI_FDFLAG_APPEND", "__WASI_FDFLAGS_APPEND"],
    ["__WASI_O_CREAT", "__WASI_OFLAGS_CREAT"],
    ["__WASI_O_DIRECTORY", "__WASI_OFLAGS_DIRECTORY"],
    ["__WASI_O_EXCL", "__WASI_OFLAGS_EXCL"],
    ["__WASI_O_TRUNC", "__WASI_OFLAGS_TRUNC"],
    ["st_dev", "dev"],
    ["st_ino", "ino"],
    ["st_filetype", "filetype"],
    ["st_nlink", "nlink"],
    ["st_size", "size"],
    ["st_atim", "atim"],
    ["st_mtim", "mtim"],
    ["st_ctim", "ctim"],
    ["pr_type", "tag"],
  ])
    replace(new RegExp(`\\b${before}\\b`, "g"), after);
  // Preserve the old module's trap behavior without importing WASI proc_exit through libc.
  replace(
    /void Assert\(bool result, const char\* cond\) \{/,
    `void abort(void) { __builtin_trap(); }

void Assert(bool result, const char* cond) {`,
  );
  return source;
}

export async function verifyMemfsModule(
  bytes,
  maxNodes = manifest.sources.memfs.maxNodes,
) {
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module);
  assert.deepEqual(
    imports.map(({ module, name, kind }) => `${module}:${name}:${kind}`).sort(),
    importNames.map((name) => `env:${name}:function`),
  );
  assert.deepEqual(
    exports.map(({ name, kind }) => `${name}:${kind}`).sort(),
    [
      "memory:memory",
      ...Object.keys(exportArity).map((name) => `${name}:function`),
    ].sort(),
  );
  let instance;
  const assertions = [];
  const unexpected = () => {
    throw new Error("Unexpected MemFS host I/O during capacity check");
  };
  instance = await WebAssembly.instantiate(module, {
    env: {
      copy_in: unexpected,
      copy_out: unexpected,
      host_read: unexpected,
      host_write: unexpected,
      memfs_log(pointer, length) {
        assertions.push(
          new TextDecoder().decode(
            new Uint8Array(instance.exports.memory.buffer, pointer, length),
          ),
        );
      },
    },
  });
  const memfs = instance.exports;
  for (const [name, arity] of Object.entries(exportArity))
    assert.equal(memfs[name].length, arity, name);
  memfs.init();
  const initialMemoryBytes = memfs.memory.buffer.byteLength;
  const encoder = new TextEncoder();
  const setPath = (name) => {
    const encoded = encoder.encode(name);
    assert.ok(encoded.length < memfs.GetPathBufLen());
    new Uint8Array(memfs.memory.buffer, memfs.GetPathBuf(), encoded.length).set(
      encoded,
    );
    return encoded.length;
  };
  // init reserves four nodes: stdin, stdout, stderr and the root directory.
  for (let index = 0; index < maxNodes - 4; index++) {
    const length = setPath(`capacity-${index}`);
    const inode = memfs.AddFileNode(length, 1);
    assert.equal(memfs.FindNode(length), inode);
    assert.equal(memfs.GetFileNodeSize(inode), 1);
    new Uint8Array(memfs.memory.buffer)[memfs.GetFileNodeAddress(inode)] =
      index % 251;
  }
  for (let index = 0; index < maxNodes - 4; index++) {
    const inode = memfs.FindNode(setPath(`capacity-${index}`));
    assert.equal(
      new Uint8Array(memfs.memory.buffer)[memfs.GetFileNodeAddress(inode)],
      index % 251,
    );
  }
  assert.equal(assertions.length, 0);
  assert.throws(
    () => memfs.AddFileNode(setPath("one-too-many"), 0),
    WebAssembly.RuntimeError,
  );
  assert.ok(
    assertions.some((message) => message.startsWith("Assertion failed:")),
  );
  return {
    imports,
    exports,
    functionArity: exportArity,
    maxNodes,
    usableNodes: maxNodes - 4,
    initialMemoryBytes,
  };
}

export async function buildMemfs({
  wasiSdkPath,
  workDir,
  outDir,
  wasiSdkVersion = manifest.toolchains.wasiSdk.version,
}) {
  if (!wasiSdkPath) throw new Error("Pass --wasi-sdk or set WASI_SDK_PATH");
  wasiSdkPath = path.resolve(wasiSdkPath);
  workDir = path.resolve(workDir);
  outDir = path.resolve(outDir);
  const sdkVersion = (
    await fs.readFile(path.join(wasiSdkPath, "VERSION"), "utf8")
  ).trim();
  if (!sdkVersion.startsWith(`${wasiSdkVersion}.`))
    throw new Error("MemFS WASI SDK version mismatch");
  const { directory, receipts } = await fetchMemfsSources({ workDir });
  const maxNodes = manifest.sources.memfs.maxNodes;
  assert.ok(
    Number.isSafeInteger(maxNodes) && maxNodes >= 4096 && maxNodes <= 65536,
  );
  const original = await fs.readFile(path.join(directory, "memfs.c"), "utf8");
  const patched = modernizeSource(original, maxNodes);
  const buildDir = path.join(workDir, "build");
  await fs.mkdir(buildDir, { recursive: true });
  await fs.writeFile(path.join(buildDir, "memfs.c"), patched);
  await fs.copyFile(
    path.join(directory, "stb_sprintf.h"),
    path.join(buildDir, "stb_sprintf.h"),
  );
  const sysroot = path.join(wasiSdkPath, "share/wasi-sysroot");
  const clang = path.join(wasiSdkPath, "bin/clang");
  const commands = [
    [
      clang,
      `--sysroot=${sysroot}`,
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter",
      "-c",
      "-o",
      "memfs.o",
      "memfs.c",
    ],
    [
      clang,
      `--sysroot=${sysroot}`,
      "-DSTB_SPRINTF_IMPLEMENTATION",
      "-x",
      "c",
      "-O2",
      "-c",
      "-o",
      "stb_sprintf.o",
      "stb_sprintf.h",
    ],
    [
      path.join(wasiSdkPath, "bin/wasm-ld"),
      `-L${sysroot}/lib/wasm32-wasi`,
      "--no-entry",
      "--strip-all",
      "--export-memory",
      ...Object.keys(exportArity).map((name) => `--export=${name}`),
      "--allow-undefined",
      "-o",
      "memfs.wasm",
      "memfs.o",
      "stb_sprintf.o",
      "-lc",
    ],
  ];
  for (const [command, ...args] of commands) {
    console.log(JSON.stringify({ argv: [command, ...args], cwd: buildDir }));
    execFileSync(command, args, { cwd: buildDir, stdio: "inherit" });
  }
  const wasm = await fs.readFile(path.join(buildDir, "memfs.wasm"));
  const abi = await verifyMemfsModule(wasm, maxNodes);
  const gzip = gzipSync(wasm, { level: 9 });
  const receipt = {
    format: "wasm-llvm-memfs-build-v1",
    maxNodes,
    abi,
    source: {
      repository: manifest.sources.memfs.repository,
      commit: manifest.sources.memfs.commit,
      files: receipts,
    },
    license: manifest.sources.memfs.license,
    patch: {
      description:
        "MAX_NODES; WASI header, errno, flag and field renames; preserve abort trap",
      originalSha256: sha256(original),
      patchedSha256: sha256(patched),
      builderSha256: sha256(await fs.readFile(scriptPath)),
    },
    toolchain: {
      wasiSdkVersion,
      sdkVersion,
      clangVersion: execFileSync(clang, ["--version"], {
        encoding: "utf8",
      }).split("\n")[0],
    },
    commands: commands.map((argv) =>
      argv.map((arg) => arg.replaceAll(wasiSdkPath, "${WASI_SDK_PATH}")),
    ),
    outputs: {
      "memfs.wasm": receiptFor(wasm),
      "memfs.wasm.gz": receiptFor(gzip),
    },
  };
  await fs.mkdir(outDir, { recursive: true });
  const wasmPath = path.join(outDir, "memfs.wasm");
  const gzipPath = path.join(outDir, "memfs.wasm.gz");
  const receiptPath = path.join(outDir, "memfs-build-receipt.json");
  await fs.writeFile(wasmPath, wasm);
  await fs.writeFile(gzipPath, gzip);
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  await fs.copyFile(
    path.join(directory, "LICENSE.llvm.txt"),
    path.join(outDir, "LICENSE.llvm.txt"),
  );
  await fs.writeFile(
    path.join(outDir, "LICENSE.stb_sprintf.txt"),
    (await fs.readFile(path.join(directory, "stb_sprintf.h"), "utf8"))
      .split("ALTERNATIVE A - MIT License")[1]
      .split("ALTERNATIVE B")[0],
  );
  console.log(
    JSON.stringify({
      wasmPath,
      gzipPath,
      receiptPath,
      outputs: receipt.outputs,
      maxNodes,
    }),
  );
  return { wasmPath, gzipPath, receiptPath, receipt };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: node build-memfs.mjs --wasi-sdk DIR [--work-dir DIR] [--out-dir DIR]",
    );
  } else {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (
        !["--wasi-sdk", "--work-dir", "--out-dir"].includes(args[index]) ||
        !args[index + 1] ||
        args[index + 1].startsWith("--")
      ) {
        throw new Error(`Invalid MemFS build option: ${args[index]}`);
      }
      options[args[index]] = args[index + 1];
    }
    const artifacts = path.resolve(producerRoot, "../../artifacts");
    await buildMemfs({
      wasiSdkPath: options["--wasi-sdk"] || process.env.WASI_SDK_PATH,
      workDir: options["--work-dir"] || path.join(artifacts, "memfs-build"),
      outDir: options["--out-dir"] || path.join(artifacts, "memfs"),
    });
  }
}
