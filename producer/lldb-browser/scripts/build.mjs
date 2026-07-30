#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EMSCRIPTEN_REVISION,
  LLVM_REVISION,
  REGISTERED_PLUGINS,
  REPO_ROOT,
  SCRIPT_DIR,
  loadProducerMetadata,
  verifyLockedInputs,
} from "./contracts.mjs";

const defaultWorkDir = path.resolve(
  process.env.WASM_LLVM_LLDB_WORK_DIR ||
    path.join(REPO_ROOT, "artifacts", "lldb-browser-build"),
);

export const EMSCRIPTEN_LINK_FLAGS = [
  "-pthread",
  "-sPTHREAD_POOL_SIZE=8",
  "-sPROXY_TO_PTHREAD=1",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createLldbWebDapModule",
  "-sENVIRONMENT=worker",
  "-sINVOKE_RUN=0",
  "-sINCOMING_MODULE_JS_API=['locateFile','mainScriptUrlOrBlob','noInitialRun','onAbort','onExit','stdout','stderr','print','printErr']",
  "-sEXPORTED_RUNTIME_METHODS=['FS','callMain','HEAPU8']",
  "-sFILESYSTEM=1",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sINITIAL_MEMORY=536870912",
  "-sMAXIMUM_MEMORY=4294967296",
  "-sSTACK_SIZE=8388608",
  "-sWASM_BIGINT=1",
  // Emscripten 6 uses ASSERTIONS to disable paired Wasm import/export minification.
  "-sASSERTIONS=1",
  "-sEXIT_RUNTIME=1",
  "-sERROR_ON_UNDEFINED_SYMBOLS=1",
  "-Wl,--gc-sections",
];

export function parseBuildArgs(argv) {
  const options = {
    plan: false,
    package: true,
    workDir: defaultWorkDir,
    sourceDir: process.env.LLVM_SOURCE_DIR
      ? path.resolve(process.env.LLVM_SOURCE_DIR)
      : "",
    emsdkDir: process.env.EMSDK ? path.resolve(process.env.EMSDK) : "",
    outDir: path.resolve(
      process.env.WASM_LLVM_LLDB_OUT_DIR ||
        path.join(REPO_ROOT, "artifacts", "lldb-browser"),
    ),
  };
  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--plan") {
      options.plan = true;
      continue;
    }
    if (argument === "--no-package") {
      options.package = false;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (
      argument === "--work-dir" ||
      argument === "--source-dir" ||
      argument === "--emsdk-dir" ||
      argument === "--out-dir"
    ) {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${argument}`);
      const key = {
        "--work-dir": "workDir",
        "--source-dir": "sourceDir",
        "--emsdk-dir": "emsdkDir",
        "--out-dir": "outDir",
      }[argument];
      options[key] = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

export function createBuildPlan(options) {
  const sourceDir =
    options.sourceDir || path.join(options.workDir, "llvm-project");
  const emsdkDir = options.emsdkDir || path.join(options.workDir, "emsdk");
  const nativeBuildDir = path.join(options.workDir, "native-build");
  const webBuildDir = path.join(options.workDir, "web-build");
  const reproducibleCompileFlags = [
    "-pthread",
    `-ffile-prefix-map=${sourceDir}=/llvm-project`,
    `-ffile-prefix-map=${webBuildDir}=/lldb-web-build`,
  ].join(" ");
  const reproducibleVcsDefinitions = [
    "-DLLVM_FORCE_VC_REPOSITORY=https://github.com/llvm/llvm-project.git",
    `-DLLVM_FORCE_VC_REVISION=${LLVM_REVISION}`,
  ];
  const nativeDefinitions = [
    "-G",
    "Ninja",
    "-S",
    path.join(sourceDir, "llvm"),
    "-B",
    nativeBuildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DLLVM_ENABLE_PROJECTS=clang;lldb",
    "-DLLVM_TARGETS_TO_BUILD=WebAssembly",
    "-DLLVM_INCLUDE_TESTS=OFF",
    "-DCLANG_INCLUDE_TESTS=OFF",
    "-DLLDB_INCLUDE_TESTS=OFF",
    "-DLLVM_INCLUDE_EXAMPLES=OFF",
    "-DLLVM_INCLUDE_BENCHMARKS=OFF",
    "-DLLVM_INCLUDE_DOCS=OFF",
    ...reproducibleVcsDefinitions,
  ];
  const webDefinitions = [
    "-G",
    "Ninja",
    "-S",
    path.join(sourceDir, "llvm"),
    "-B",
    webBuildDir,
    "-DCMAKE_BUILD_TYPE=MinSizeRel",
    "-DLLVM_ENABLE_PROJECTS=clang;lldb",
    "-DLLVM_TARGETS_TO_BUILD=WebAssembly",
    "-DLLVM_ENABLE_THREADS=ON",
    "-DLLVM_ENABLE_RTTI=ON",
    "-DLLVM_ENABLE_EH=ON",
    "-DLLVM_ENABLE_ZLIB=OFF",
    "-DLLVM_ENABLE_ZSTD=OFF",
    "-DLLVM_ENABLE_TERMINFO=OFF",
    "-DLLVM_ENABLE_LIBXML2=OFF",
    "-DLLVM_INCLUDE_TESTS=OFF",
    "-DLLVM_INCLUDE_EXAMPLES=OFF",
    "-DLLVM_INCLUDE_BENCHMARKS=OFF",
    "-DLLVM_INCLUDE_DOCS=OFF",
    "-DCLANG_INCLUDE_TESTS=OFF",
    "-DLLDB_INCLUDE_TESTS=OFF",
    "-DLLDB_ENABLE_PYTHON=OFF",
    "-DLLDB_ENABLE_LUA=OFF",
    "-DLLDB_ENABLE_LIBEDIT=OFF",
    "-DLLDB_ENABLE_CURSES=OFF",
    "-DLLDB_ENABLE_LZMA=OFF",
    "-DLLDB_ENABLE_LIBXML2=OFF",
    "-DLLDB_ENABLE_SWIG=OFF",
    "-DLLDB_ENABLE_PROTOCOL_SERVERS=OFF",
    "-DLLDB_BUILD_LLDBRPC=OFF",
    "-DLLDB_BUILD_FRAMEWORK=OFF",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DLLVM_BUILD_LLVM_DYLIB=OFF",
    "-DLLVM_LINK_LLVM_DYLIB=OFF",
    "-DCLANG_LINK_CLANG_DYLIB=OFF",
    ...reproducibleVcsDefinitions,
    `-DLLVM_TABLEGEN=${path.join(nativeBuildDir, "bin", "llvm-tblgen")}`,
    `-DCLANG_TABLEGEN=${path.join(nativeBuildDir, "bin", "clang-tblgen")}`,
    `-DLLDB_TABLEGEN_EXE=${path.join(nativeBuildDir, "bin", "lldb-tblgen")}`,
    `-DLLDB_WEB_PLUGIN_ALLOWLIST=${REGISTERED_PLUGINS.join(";")}`,
    `-DCMAKE_C_FLAGS=${reproducibleCompileFlags}`,
    `-DCMAKE_CXX_FLAGS=${reproducibleCompileFlags}`,
  ];
  const emcmake = path.join(emsdkDir, "upstream", "emscripten", "emcmake");
  const parallel = process.env.NINJA_JOBS
    ? ["--parallel", process.env.NINJA_JOBS]
    : ["--parallel"];
  return {
    kind: "wasm-llvm-lldb-browser-build-plan",
    sourceRevision: LLVM_REVISION,
    emscriptenRevision: EMSCRIPTEN_REVISION,
    sourceDir,
    emsdkDir,
    nativeBuildDir,
    webBuildDir,
    outDir: options.outDir,
    target: "lldb-web-dap",
    registeredPlugins: [...REGISTERED_PLUGINS],
    executableLinkFlags: [...EMSCRIPTEN_LINK_FLAGS],
    commands: [
      { command: "cmake", arguments: nativeDefinitions },
      {
        command: "cmake",
        arguments: [
          "--build",
          nativeBuildDir,
          "--target",
          "llvm-tblgen",
          "clang-tblgen",
          "lldb-tblgen",
          ...parallel,
        ],
      },
      { command: emcmake, arguments: ["cmake", ...webDefinitions] },
      {
        command: "cmake",
        arguments: [
          "--build",
          webBuildDir,
          "--target",
          "lldb-web-dap",
          ...parallel,
        ],
      },
    ],
    outputs: {
      js: path.join(webBuildDir, "bin", "lldb-web-dap.js"),
      wasm: path.join(webBuildDir, "bin", "lldb-web-dap.wasm"),
      worker: path.join(webBuildDir, "bin", "lldb-web-dap.pthread.mjs"),
    },
  };
}

export function assertNoEmbeddedBuildPaths(wasmBytes, forbiddenPaths) {
  const bytes = Buffer.from(
    wasmBytes.buffer,
    wasmBytes.byteOffset,
    wasmBytes.byteLength,
  );
  for (const forbiddenPath of forbiddenPaths) {
    if (bytes.includes(forbiddenPath)) {
      throw new Error(
        `LLDB browser Wasm contains an embedded prepared build path: ${forbiddenPath}`,
      );
    }
  }
}

function run(command, commandArguments) {
  return new Promise((resolve, reject) => {
    console.log(`+ ${[command, ...commandArguments].join(" ")}`);
    const child = spawn(command, commandArguments, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function assertPrepared(plan) {
  const statePath = path.join(
    path.dirname(plan.nativeBuildDir),
    "prepare-state.json",
  );
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (
    state.llvmRevision !== LLVM_REVISION ||
    state.emscriptenRevision !== EMSCRIPTEN_REVISION ||
    path.resolve(state.sourceDir) !== path.resolve(plan.sourceDir) ||
    path.resolve(state.emsdkDir) !== path.resolve(plan.emsdkDir)
  ) {
    throw new Error(
      `prepare state does not match the locked build: ${statePath}`,
    );
  }
}

async function main() {
  const options = parseBuildArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node producer/lldb-browser/scripts/build.mjs [options]

Options:
  --plan             Print configure/build commands without writing or executing.
  --work-dir DIR     Prepared checkout/build workspace.
  --source-dir DIR   Prepared LLVM source override.
  --emsdk-dir DIR    Prepared Emscripten SDK override.
  --out-dir DIR      Packaged artifact destination.
  --no-package       Stop after building lldb-web-dap.`);
    return;
  }

  const { sourcesLock } = await loadProducerMetadata();
  await verifyLockedInputs(sourcesLock);
  const plan = createBuildPlan(options);
  if (options.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  await assertPrepared(plan);
  for (const command of plan.commands) {
    await run(command.command, command.arguments);
  }
  const wasmBytes = await fs.readFile(plan.outputs.wasm);
  assertNoEmbeddedBuildPaths(wasmBytes, [
    plan.sourceDir,
    plan.webBuildDir,
  ]);
  if (options.package) {
    await run(process.execPath, [
      path.join(SCRIPT_DIR, "package.mjs"),
      "--js",
      plan.outputs.js,
      "--wasm",
      plan.outputs.wasm,
      "--worker",
      plan.outputs.worker,
      "--target-dir",
      plan.outDir,
    ]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
