import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  materializeNativeLinkArguments,
  parseNativeSplitPipelineArgs,
  runNativeSplitPipeline,
  validateNativeLinkPlan,
} from "../scripts/probe-native-split-pipeline.mjs";

const tempDirs = [];
const wasmHeader = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);
const bitcodeHeader = Buffer.from([0x42, 0x43, 0xc0, 0xde]);
const wasmHeaderSha256 = createHash("sha256").update(wasmHeader).digest("hex");
const bitcodeHeaderSha256 = createHash("sha256").update(bitcodeHeader).digest("hex");

function validLinkPlan() {
  return {
    schemaVersion: 6,
    format: "wasm-llvm-tinygo-link-plan-v6",
    compilerSha256: "a".repeat(64),
    capabilities: [
      "go-embed-objects",
      "target-cgo-c",
      "target-cxx-hosted-noeh",
      "target-clang-assembly",
      "target-cgo-cxxflags",
      "target-cgo-linker-flags",
    ],
    compilerPackages: ["github.com/tinygo-org/tinygo/builder"],
    linker: "wasm-ld",
    objects: [
      {
        kind: "program",
        path: "objects/0000-program.o",
        format: "wasm-object",
        bytes: wasmHeader.length,
        sha256: wasmHeaderSha256,
      },
      {
        kind: "target-c",
        path: "objects/0001-target-c.bc",
        format: "llvm-bitcode",
        bytes: bitcodeHeader.length,
        sha256: bitcodeHeaderSha256,
        importPath: "_/fixture",
        sourceField: "CFiles",
        sourcePath: "helper.c",
        sourceSha256: "b".repeat(64),
        dependencies: [],
        llvmValidation: {
          toolchain: "llvm-20.1.1",
          moduleVerified: true,
          targetTriple: "wasm32-unknown-wasi",
          dataLayout: "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20",
          threadLocalGlobals: 0,
          globalConstructors: 0,
          globalDestructors: 0,
          forbiddenAbiSymbols: [],
        },
      },
      {
        kind: "target-cxx",
        path: "objects/0002-target-cxx.bc",
        format: "llvm-bitcode",
        bytes: bitcodeHeader.length,
        sha256: bitcodeHeaderSha256,
        importPath: "_/fixture",
        sourceField: "CXXFiles",
        sourcePath: "helper.cpp",
        sourceSha256: "e".repeat(64),
        dependencies: [],
        compilerFlags: ["-DTINYGO_CXX_SCALE=2"],
        llvmValidation: {
          toolchain: "llvm-20.1.1",
          moduleVerified: true,
          targetTriple: "wasm32-unknown-wasi",
          dataLayout: "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20",
          threadLocalGlobals: 0,
          globalConstructors: 0,
          globalDestructors: 0,
          forbiddenAbiSymbols: [],
        },
      },
      {
        kind: "target-assembly",
        path: "objects/0003-target-assembly.o",
        format: "wasm-object",
        bytes: wasmHeader.length,
        sha256: wasmHeaderSha256,
        importPath: "_/fixture",
        sourceField: "SFiles",
        sourcePath: "helper.S",
        sourceSha256: "f".repeat(64),
        dependencies: [],
        wasmValidation: {
          profile: "wasm-relocatable-object-v1",
          linkingVersion: 2,
          symbolTable: true,
        },
      },
      {
        kind: "embed",
        path: "objects/0004-embed.o",
        format: "wasm-object",
        bytes: wasmHeader.length,
        sha256: wasmHeaderSha256,
        importPath: "_/fixture",
        sourcePath: "greeting.txt",
        sourceSha256: "c".repeat(64),
        embeddedFileHash: "c".repeat(32),
      },
    ],
    output: "program.unoptimized.wasm",
    arguments: [
      "--stack-first",
      "--no-demangle",
      "-o",
      "program.unoptimized.wasm",
      "--strip-debug",
      "--compress-relocations",
      "objects/0000-program.o",
      "/toolchain/compiler-rt.a",
      "/toolchain/runtime.o",
      "objects/0001-target-c.bc",
      "objects/0002-target-cxx.bc",
      "objects/0003-target-assembly.o",
      "/toolchain/libcxx.a",
      "/toolchain/libcxxabi.a",
      "/toolchain/libc.a",
      "objects/0004-embed.o",
      "-mllvm",
      "-mcpu=generic",
    ],
    runtimeInputs: [
      { kind: "compiler-rt", path: "/toolchain/compiler-rt.a" },
      { kind: "extra-file", source: "/tinygo/runtime.o", path: "/toolchain/runtime.o" },
      { kind: "libcxx", path: "/toolchain/libcxx.a" },
      { kind: "libcxxabi", path: "/toolchain/libcxxabi.a" },
      { kind: "wasi-libc", path: "/toolchain/libc.a" },
    ],
    cgoInputs: [
      {
        importPath: "_/fixture",
        sourcePath: "cgo.go",
        bytes: 64,
        sha256: "d".repeat(64),
        dependencies: [],
      },
    ],
    cgoLinkerFlags: [],
    optimizer: {
      tool: "wasm-opt",
      input: "program.unoptimized.wasm",
      output: "program.wasm",
      arguments: [
        "--asyncify",
        "-O1",
        "-g",
        "program.unoptimized.wasm",
        "--output",
        "program.wasm",
      ],
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wasm-llvm-tinygo-split-"));
  tempDirs.push(root);
  const paths = {
    root,
    objectRootPath: root,
    programObjectPath: path.join(root, "objects", "0000-program.o"),
    targetCObjectPath: path.join(root, "objects", "0001-target-c.bc"),
    targetCXXObjectPath: path.join(root, "objects", "0002-target-cxx.bc"),
    targetAssemblyObjectPath: path.join(root, "objects", "0003-target-assembly.o"),
    embedObjectPath: path.join(root, "objects", "0004-embed.o"),
    linkPlanPath: path.join(root, "link-plan.json"),
    lldWasmPath: path.join(root, "lld.wasm"),
    wasmOptPath: path.join(root, "wasm-opt"),
    unoptimizedWasmPath: path.join(root, "out", "program.unopt.wasm"),
    outputWasmPath: path.join(root, "out", "program.wasm"),
    expectedStdinPath: path.join(root, "stdin.txt"),
    expectedStdoutPath: path.join(root, "stdout.txt"),
  };
	const linkPlan = validLinkPlan();
  await mkdir(path.dirname(paths.programObjectPath), { recursive: true });
  await Promise.all([
    writeFile(paths.programObjectPath, wasmHeader),
    writeFile(paths.targetCObjectPath, bitcodeHeader),
    writeFile(paths.targetCXXObjectPath, bitcodeHeader),
    writeFile(paths.targetAssemblyObjectPath, wasmHeader),
    writeFile(paths.embedObjectPath, wasmHeader),
    writeFile(paths.linkPlanPath, `${JSON.stringify(linkPlan, null, 2)}\n`),
    writeFile(paths.lldWasmPath, wasmHeader),
    writeFile(paths.wasmOptPath, "#!/bin/sh\n"),
    writeFile(paths.expectedStdinPath, "Ada\n"),
    writeFile(paths.expectedStdoutPath, "hello Ada count=2 total=3 cgo=5/20\n"),
  ]);
  return { linkPlan, paths };
}

test("parses every pipeline path from an explicit named CLI option", () => {
  const cwd = path.join(path.sep, "work");
  assert.deepEqual(
    parseNativeSplitPipelineArgs(
      [
        "--object-root",
        "objects-root",
        "--link-plan",
        "link-plan.json",
        "--lld-wasm",
        "lld.wasm",
        "--wasm-opt",
        "bin/wasm-opt",
        "--unoptimized-wasm",
        "out/program.unopt.wasm",
        "--output-wasm",
        "out/program.wasm",
        "--expected-stdin",
        "stdin.txt",
        "--expected-stdout",
        "stdout.txt",
      ],
      cwd,
    ),
    {
      help: false,
      objectRootPath: path.join(cwd, "objects-root"),
      linkPlanPath: path.join(cwd, "link-plan.json"),
      lldWasmPath: path.join(cwd, "lld.wasm"),
      wasmOptPath: path.join(cwd, "bin/wasm-opt"),
      unoptimizedWasmPath: path.join(cwd, "out/program.unopt.wasm"),
      outputWasmPath: path.join(cwd, "out/program.wasm"),
      expectedStdinPath: path.join(cwd, "stdin.txt"),
      expectedStdoutPath: path.join(cwd, "stdout.txt"),
    },
  );
  assert.throws(
    () => parseNativeSplitPipelineArgs(["program.o"]),
    /Unexpected positional argument program\.o/u,
  );
  assert.throws(
    () => parseNativeSplitPipelineArgs(["--object-root", "objects-root"]),
    /Missing required option --link-plan/u,
  );
});

test("rejects every thin LTO cache-directory spelling before invoking LLD", () => {
  for (const forbiddenArgument of [
    "--thinlto-cache-dir",
    "--thinlto-cache-dir=/tmp/cache",
    "-Wl,--thinlto-cache-dir=/tmp/cache",
  ]) {
    assert.throws(
      () =>
		validateNativeLinkPlan({
		  ...validLinkPlan(),
		  arguments: [...validLinkPlan().arguments, forbiddenArgument],
		}),
      /forbidden --thinlto-cache-dir/u,
    );
  }
});

test("maps the link-plan object and output to explicit CLI paths", () => {
  const plan = validLinkPlan();
  assert.deepEqual(
    materializeNativeLinkArguments(plan, {
      objectRootPath: "/actual",
      unoptimizedWasmPath: "/actual/program.unopt.wasm",
    }),
	plan.arguments.map((argument) => {
	  if (argument === plan.output) return "/actual/program.unopt.wasm";
	  const object = plan.objects.find((candidate) => candidate.path === argument);
	  if (object) return path.join("/actual", object.path);
	  return argument;
	}),
  );
  assert.throws(
    () =>
      materializeNativeLinkArguments(
		{
		  ...plan,
		  arguments: plan.arguments.filter((argument) => argument !== plan.output),
		},
        {
          objectRootPath: "/actual",
          unoptimizedWasmPath: "/actual/program.unopt.wasm",
        },
      ),
	/must reference its output exactly once/u,
  );
});

test("runs raw WASI LLD, Binaryen, then the final WASI module and verifies exact output", async () => {
  const { paths } = await createFixture();
  const calls = [];
  const result = await runNativeSplitPipeline(paths, {
    runWasiModuleImpl: async (invocation) => {
      calls.push({ kind: "wasi", ...invocation });
      if (calls.length === 1) {
        await mkdir(path.dirname(paths.unoptimizedWasmPath), {
          recursive: true,
        });
        await writeFile(paths.unoptimizedWasmPath, wasmHeader);
        return {
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      }
      return {
        exitCode: 0,
        stdout: await readFile(paths.expectedStdoutPath),
        stderr: Buffer.alloc(0),
      };
    },
    execFileImpl: async (executable, arguments_) => {
      calls.push({ kind: "exec", executable, arguments: arguments_ });
      await writeFile(paths.outputWasmPath, wasmHeader);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].kind, "wasi");
  assert.equal(calls[0].modulePath, paths.lldWasmPath);
  assert.deepEqual(calls[0].args.slice(0, 2), ["wasm-ld", "--stack-first"]);
  assert(calls[0].args.includes(paths.programObjectPath));
  assert(calls[0].args.includes(paths.targetCObjectPath));
  assert(calls[0].args.includes(paths.targetCXXObjectPath));
  assert(calls[0].args.includes(paths.targetAssemblyObjectPath));
  assert(calls[0].args.includes(paths.embedObjectPath));
  assert(calls[0].args.includes(paths.unoptimizedWasmPath));
  assert.equal(calls[1].kind, "exec");
  assert.equal(calls[1].executable, paths.wasmOptPath);
  assert.deepEqual(calls[1].arguments, [
    "--asyncify",
    "-O1",
    "-g",
    paths.unoptimizedWasmPath,
    "--output",
    paths.outputWasmPath,
  ]);
  assert.equal(calls[2].kind, "wasi");
  assert.equal(calls[2].modulePath, paths.outputWasmPath);
  assert.deepEqual(calls[2].args, [paths.outputWasmPath]);
  assert.deepEqual(calls[2].stdin, Buffer.from("Ada\n"));
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "hello Ada count=2 total=3 cgo=5/20\n",
    unoptimizedWasmPath: paths.unoptimizedWasmPath,
    outputWasmPath: paths.outputWasmPath,
  });
});

test("fails when final execution differs byte-for-byte from expected stdout", async () => {
  const { paths } = await createFixture();
  let wasiCalls = 0;
  await assert.rejects(
    () =>
      runNativeSplitPipeline(paths, {
        runWasiModuleImpl: async () => {
          wasiCalls += 1;
          if (wasiCalls === 1) {
            await mkdir(path.dirname(paths.unoptimizedWasmPath), {
              recursive: true,
            });
            await writeFile(paths.unoptimizedWasmPath, wasmHeader);
            return {
              exitCode: 0,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
            };
          }
          return {
            exitCode: 0,
            stdout: Buffer.from("wrong output\n"),
            stderr: Buffer.alloc(0),
          };
        },
        execFileImpl: async () => {
          await writeFile(paths.outputWasmPath, wasmHeader);
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      }),
    /Final stdout mismatch.*hello Ada count=2 total=3 cgo=5\/20.*wrong output/su,
  );
});

test("rejects reordered C objects and malformed native dependency evidence", () => {
  const staleProtocol = validLinkPlan();
  staleProtocol.schemaVersion = 4;
  staleProtocol.format = "wasm-llvm-tinygo-link-plan-v4";
  assert.throws(
    () => validateNativeLinkPlan(staleProtocol),
    /identity differs from compile protocol v6/u,
  );

  const reordered = validLinkPlan();
  [reordered.objects[1], reordered.objects[2]] = [
    reordered.objects[2],
    reordered.objects[1],
  ];
  assert.throws(
    () => validateNativeLinkPlan(reordered),
    /object 1 is invalid|target C objects must precede/u,
  );

  const unsafeDependency = validLinkPlan();
  unsafeDependency.cgoInputs[0].dependencies = [
    {
      scope: "workspace",
      path: "../escape.h",
      bytes: 1,
      sha256: "e".repeat(64),
    },
  ];
  assert.throws(
    () => validateNativeLinkPlan(unsafeDependency),
    /CGo input 0 dependency 0 is invalid/u,
  );

  const nullDependencies = validLinkPlan();
  nullDependencies.cgoInputs[0].dependencies = null;
  assert.throws(
    () => validateNativeLinkPlan(nullDependencies),
    /CGo input 0 dependencies are invalid/u,
  );

  const missingLLVMValidation = validLinkPlan();
  delete missingLLVMValidation.objects[1].llvmValidation;
  assert.throws(
    () => validateNativeLinkPlan(missingLLVMValidation),
    /lacks exact LLVM validation/u,
  );

  const unboundCGoLinkerFlags = validLinkPlan();
  unboundCGoLinkerFlags.cgoLinkerFlags = ["-lexample"];
  assert.throws(
    () => validateNativeLinkPlan(unboundCGoLinkerFlags),
    /do not bind its CGo linker flags/u,
  );
});
