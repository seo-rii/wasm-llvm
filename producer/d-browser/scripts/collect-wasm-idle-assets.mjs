import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultLdcBuildDir = path.resolve(repoRoot, "build", "ldc-wasi");
const defaultLdcSourceDir = path.resolve(repoRoot, "build", "ldc");
const defaultWasiSdkDir = process.env.WASI_SDK_PATH
  ? path.resolve(process.env.WASI_SDK_PATH)
  : path.resolve(repoRoot, "build", "wasi-sdk");
const defaultStageDir = path.resolve(repoRoot, "build", "wasm-idle-root");
const defaultOutDir = path.resolve(repoRoot, "dist", "wasm-idle");
const defaultToolchainPrefix = "/toolchain";
const defaultEmscriptenLldDir = process.env.LDC_WASM_EMSCRIPTEN_LLD_DIR
  ? path.resolve(process.env.LDC_WASM_EMSCRIPTEN_LLD_DIR)
  : path.resolve(process.env.HOME || "", ".cache", "llvm-wasm-20260319");

const usage = `Usage: node scripts/collect-wasm-idle-assets.mjs --ldc-build DIR --ldc-source DIR --wasi-sdk DIR [--emscripten-lld DIR] [--stage DIR] [--out DIR] [--version VERSION] [--toolchain-prefix PATH]

Collects a completed LDC WASI build into the wasm-idle asset root, then packages
that root into dist/wasm-idle.

Defaults:
  --ldc-build        ${path.relative(repoRoot, defaultLdcBuildDir)}
  --ldc-source       ${path.relative(repoRoot, defaultLdcSourceDir)}
  --wasi-sdk         ${path.relative(repoRoot, defaultWasiSdkDir)}
  --stage            ${path.relative(repoRoot, defaultStageDir)}
  --out              ${path.relative(repoRoot, defaultOutDir)}
  --emscripten-lld   ${path.relative(repoRoot, defaultEmscriptenLldDir)}
  --toolchain-prefix ${defaultToolchainPrefix}
`;

const options = {
  ldcBuildDir: process.env.LDC_WASM_LDC_BUILD
    ? path.resolve(process.env.LDC_WASM_LDC_BUILD)
    : defaultLdcBuildDir,
  ldcSourceDir: process.env.LDC_WASM_LDC_SOURCE
    ? path.resolve(process.env.LDC_WASM_LDC_SOURCE)
    : defaultLdcSourceDir,
  wasiSdkDir: defaultWasiSdkDir,
  stageDir: process.env.LDC_WASM_BUILD_ROOT
    ? path.resolve(process.env.LDC_WASM_BUILD_ROOT)
    : defaultStageDir,
  outDir: defaultOutDir,
  emscriptenLldDir: defaultEmscriptenLldDir,
  version: process.env.LDC_WASM_VERSION || "ldc-1.42.0-wasi",
  toolchainPrefix:
    process.env.LDC_WASM_TOOLCHAIN_PREFIX || defaultToolchainPrefix,
};

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--help" || arg === "-h") {
    console.log(usage.trimEnd());
    process.exit(0);
  }
  if (arg === "--ldc-build") {
    options.ldcBuildDir = path.resolve(readOptionValue(argv, index, arg));
    index += 1;
    continue;
  }
  if (arg === "--ldc-source") {
    options.ldcSourceDir = path.resolve(readOptionValue(argv, index, arg));
    index += 1;
    continue;
  }
  if (arg === "--wasi-sdk") {
    options.wasiSdkDir = path.resolve(readOptionValue(argv, index, arg));
    index += 1;
    continue;
  }
  if (arg === "--stage") {
    options.stageDir = path.resolve(readOptionValue(argv, index, arg));
    index += 1;
    continue;
  }
  if (arg === "--out") {
    options.outDir = path.resolve(readOptionValue(argv, index, arg));
    index += 1;
    continue;
  }
  if (arg === "--emscripten-lld") {
    options.emscriptenLldDir = path.resolve(readOptionValue(argv, index, arg));
    index += 1;
    continue;
  }
  if (arg === "--version") {
    options.version = readOptionValue(argv, index, arg);
    index += 1;
    continue;
  }
  if (arg === "--toolchain-prefix") {
    options.toolchainPrefix = readOptionValue(argv, index, arg);
    index += 1;
    continue;
  }
  throw new Error(`unexpected argument: ${arg}`);
}

if (!options.version) {
  throw new Error("--version must not be empty");
}
if (!options.toolchainPrefix.startsWith("/")) {
  throw new Error("--toolchain-prefix must be an absolute WASI path");
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertFile(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`expected file: ${filePath}`);
  }
}

async function assertDirectory(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isDirectory()) {
    throw new Error(`expected directory: ${filePath}`);
  }
}

async function copyFileInto(sourcePath, targetPath) {
  await assertFile(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

function runCommand(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`command failed (${code}): ${command} ${args.join(" ")}`));
    });
    child.on("error", reject);
  });
}

async function createTarZst(outputPath, sourceDir, entries) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand("tar", ["--zstd", "-cf", outputPath, "-C", sourceDir, ...entries]);
}

const ldc2Path = path.join(options.ldcBuildDir, "bin", "ldc2");
const emscriptenLldJsPath = path.join(options.emscriptenLldDir, "lld.js");
const emscriptenLldWasmPath = path.join(options.emscriptenLldDir, "lld.wasm");
const emscriptenLldDataPath = path.join(options.emscriptenLldDir, "lld.data");
const runtimeSourceDir = path.join(options.ldcSourceDir, "runtime");
const wasiLibDir = path.join(
  options.wasiSdkDir,
  "share",
  "wasi-sysroot",
  "lib",
  "wasm32-wasi",
);
const clangLibRoot = path.join(options.wasiSdkDir, "lib", "clang");

await assertFile(ldc2Path);
await assertFile(emscriptenLldJsPath);
await assertFile(emscriptenLldWasmPath);
await assertFile(emscriptenLldDataPath);
await assertDirectory(runtimeSourceDir);
await assertDirectory(wasiLibDir);
await assertDirectory(clangLibRoot);

let compilerRtBuiltins = null;
const clangVersions = (await fs.readdir(clangLibRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }),
  );
for (const version of clangVersions) {
  for (const target of ["wasm32-unknown-wasip1", "wasm32-unknown-wasi"]) {
    const candidate = path.join(
      clangLibRoot,
      version,
      "lib",
      target,
      "libclang_rt.builtins.a",
    );
    if (await pathExists(candidate)) {
      compilerRtBuiltins = candidate;
      break;
    }
  }
  if (compilerRtBuiltins) break;
}
if (!compilerRtBuiltins) {
  throw new Error(`failed to find libclang_rt.builtins.a under ${clangLibRoot}`);
}

await fs.rm(options.stageDir, { recursive: true, force: true });
await fs.mkdir(options.stageDir, { recursive: true });
await fs.copyFile(ldc2Path, path.join(options.stageDir, "ldc2.wasm"));
await fs.copyFile(emscriptenLldJsPath, path.join(options.stageDir, "lld.js"));
await fs.copyFile(emscriptenLldWasmPath, path.join(options.stageDir, "lld.wasm"));
await fs.copyFile(emscriptenLldDataPath, path.join(options.stageDir, "lld.data"));

const tempDir = path.join(options.stageDir, ".tmp");
const configDir = path.join(tempDir, "ldc2.conf");
await fs.mkdir(configDir, { recursive: true });
const toolchainPrefix = options.toolchainPrefix.replace(/\/+$/, "");
await fs.writeFile(
  path.join(configDir, "30-compiler.conf"),
  `"default":
{
    switches ~= [
        "-func-specialization-size-threshold=1000000000",
        "-defaultlib=phobos2-ldc,druntime-ldc",
    ];
    post-switches ~= [
        "-I${toolchainPrefix}/imports/druntime/src",
        "-I${toolchainPrefix}/imports/phobos",
        "-I${toolchainPrefix}/imports/jit-rt/d",
    ];
};
`,
);
await fs.writeFile(
  path.join(configDir, "50-target-default.conf"),
  `"default":
{
    switches ~= [
        "-link-defaultlib-shared=false",
    ];
    lib-dirs = [
        "${toolchainPrefix}/lib",
        "${toolchainPrefix}/lib/eh",
    ];
    rpath = "";
};
`,
);
await fs.writeFile(
  path.join(configDir, "55-target-wasm.conf"),
  `"^wasm(32|64)-":
{
    switches ~= [
        "-L-z",
        "-Lstack-size=1048576",
        "-L--stack-first",
    ];
};
`,
);
await createTarZst(
  path.join(options.stageDir, "ldc2.conf.tar.zst"),
  tempDir,
  ["ldc2.conf"],
);

const importsStageDir = path.join(tempDir, "imports");
await fs.cp(path.join(runtimeSourceDir, "druntime", "src"), path.join(importsStageDir, "druntime", "src"), {
  recursive: true,
});
await fs.cp(path.join(runtimeSourceDir, "phobos", "std"), path.join(importsStageDir, "phobos", "std"), {
  recursive: true,
});
await fs.cp(path.join(runtimeSourceDir, "phobos", "etc"), path.join(importsStageDir, "phobos", "etc"), {
  recursive: true,
});
await fs.cp(path.join(runtimeSourceDir, "phobos", "phobos"), path.join(importsStageDir, "phobos", "phobos"), {
  recursive: true,
});
await fs.cp(path.join(runtimeSourceDir, "jit-rt", "d"), path.join(importsStageDir, "jit-rt", "d"), {
  recursive: true,
});
await createTarZst(
  path.join(options.stageDir, "imports.tar.zst"),
  importsStageDir,
  ["."],
);

const libsStageDir = path.join(tempDir, "runtime-libs");
await copyFileInto(
  path.join(options.ldcBuildDir, "lib", "libphobos2-ldc.a"),
  path.join(libsStageDir, "lib", "libphobos2-ldc.a"),
);
await copyFileInto(
  path.join(options.ldcBuildDir, "lib", "libdruntime-ldc.a"),
  path.join(libsStageDir, "lib", "libdruntime-ldc.a"),
);
await copyFileInto(
  compilerRtBuiltins,
  path.join(libsStageDir, "lib", "libclang_rt.builtins.a"),
);

const wasiRootEntries = (await fs.readdir(wasiLibDir, { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isFile() && (entry.name.endsWith(".a") || entry.name.endsWith(".o")),
  )
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));
for (const entry of wasiRootEntries) {
  await copyFileInto(
    path.join(wasiLibDir, entry),
    path.join(libsStageDir, "lib", entry),
  );
}
await copyFileInto(
  path.join(wasiLibDir, "eh", "libunwind.a"),
  path.join(libsStageDir, "lib", "eh", "libunwind.a"),
);
await createTarZst(
  path.join(options.stageDir, "runtime-libs.tar.zst"),
  libsStageDir,
  ["."],
);

await fs.rm(tempDir, { recursive: true, force: true });
await runCommand(process.execPath, [
  path.join(repoRoot, "scripts", "package-wasm-idle-assets.mjs"),
  "--source",
  options.stageDir,
  "--out",
  options.outDir,
  "--version",
  options.version,
]);

console.log(`Collected ldc-wasm assets from ${options.ldcBuildDir}`);
