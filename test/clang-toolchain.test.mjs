import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("keeps compiler temporary files inside the configured toolchain work directory", async () => {
  const source = await readFile(
    path.join(REPO_ROOT, "producer/clang-browser/scripts/build-toolchain.mjs"),
    "utf8",
  );

  assert.match(
    source,
    /const tempDir = path\.resolve\(process\.env\.TMPDIR \|\| path\.join\(config\.workDir, 'tmp'\)\);/,
  );
  assert.match(source, /process\.env\.TMPDIR = tempDir;/);
  assert.match(source, /await fs\.mkdir\(tempDir, \{ recursive: true \}\);/);
});

test("pins, verifies, and packages MemFS without relying on an existing output archive", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(REPO_ROOT, "producer/clang-browser/manifest.json"),
      "utf8",
    ),
  );
  const buildSource = await readFile(
    path.join(REPO_ROOT, "producer/clang-browser/scripts/build-toolchain.mjs"),
    "utf8",
  );
  const packageSource = await readFile(
    path.join(
      REPO_ROOT,
      "producer/clang-browser/scripts/package-toolchain.mjs",
    ),
    "utf8",
  );

  assert.match(manifest.sources.memfs.commit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.sources.memfs.maxNodes, 8192);
  for (const name of [
    "memfs.c", "stb_sprintf.h", "Makefile", "imports.txt", "LICENSE.llvm.txt",
  ]) {
    assert.match(manifest.sources.memfs.files[name].sha256, /^[0-9a-f]{64}$/);
    assert.ok(manifest.sources.memfs.files[name].bytes > 0);
  }
  assert.equal(
    manifest.sources.lldWasmOnlyPatch.path,
    "patches/lld-wasm-only.patch",
  );
  assert.match(manifest.sources.lldWasmOnlyPatch.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    createHash("sha256")
      .update(
        await readFile(
          path.join(
            REPO_ROOT,
            "producer/clang-browser",
            manifest.sources.lldWasmOnlyPatch.path,
          ),
        ),
      )
      .digest("hex"),
    manifest.sources.lldWasmOnlyPatch.sha256,
  );
  assert.match(manifest.toolchains.emsdk.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.toolchains.wasiSdk.sysrootSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.toolchains.wasiSdk.clangRtSha256, /^[0-9a-f]{64}$/);
  for (const host of [
    "x86_64-linux",
    "arm64-linux",
    "x86_64-macos",
    "arm64-macos",
  ]) {
    assert.match(manifest.toolchains.wasiSdk.archives[host], /^[0-9a-f]{64}$/);
  }
  assert.match(buildSource, /const \{ wasmPath: memfsWasm, receiptPath: memfsReceipt \} = await buildMemfs\(/);
  assert.match(buildSource, /'--memfs-receipt',\s*memfsReceipt/);
  assert.match(buildSource, /assertSha256\(archivePath, archiveSha256/);
  assert.match(buildSource, /toolchains\.wasiSdk\.sysrootSha256/);
  assert.match(buildSource, /toolchains\.wasiSdk\.clangRtSha256/);
  assert.match(buildSource, /Emscripten SDK checkout mismatch/);
  assert.match(buildSource, /patchLldForWasmOnly\(\)/);
  assert.match(buildSource, /LLD WebAssembly-only patch/);
  assert.match(buildSource, /'--memfs-wasm',\s*memfsWasm/);
  assert.match(packageSource, /await assertWasm\('memfs', memfsBytes\)/);
  for (const tarOption of [
    "'--sort=name'",
    "'--mtime=@0'",
    "'--owner=0'",
    "'--group=0'",
    "'--numeric-owner'",
  ]) {
    assert.ok(packageSource.includes(tarOption));
  }
  assert.match(
    packageSource,
    /zipSingleFile\(path\.join\(targetDir, 'memfs\.zip'\), 'memfs', memfsBytes\)/,
  );
});

test("emits path- and time-independent Clang producer metadata", async () => {
  const packageSource = await readFile(
    path.join(
      REPO_ROOT,
      "producer/clang-browser/scripts/package-toolchain.mjs",
    ),
    "utf8",
  );
  const releaseSource = await readFile(
    path.join(REPO_ROOT, "producer/clang-browser/scripts/prepare-release.mjs"),
    "utf8",
  );

  assert.doesNotMatch(
    packageSource,
    /generatedAt:\s*new Date\(\)\.toISOString\(\)/,
  );
  assert.doesNotMatch(
    releaseSource,
    /generatedAt:\s*new Date\(\)\.toISOString\(\)/,
  );
  assert.doesNotMatch(releaseSource, /source:\s*SOURCE_DIR/);
});

test("keeps unrelated LLVM tools out of Clang and reuses its LLVM objects for standalone LLD", async () => {
  const source = await readFile(
    path.join(REPO_ROOT, "producer/clang-browser/scripts/build-toolchain.mjs"),
    "utf8",
  );

  assert.match(source, /'-DLLVM_ENABLE_PROJECTS=clang;lld'/);
  assert.match(source, /'-DLLVM_DISTRIBUTION_COMPONENTS=clang'/);
  assert.match(source, /'-DLLVM_BUILD_TOOLS=ON'/);
  assert.match(source, /'-DCLANG_BUILD_TOOLS=ON'/);
  assert.match(source, /'llvm-driver',\s*'lld',\s*'clang-resource-headers'/);
  assert.match(source, /path\.join\(wasiBuild, 'bin', 'lld'\)/);
  assert.doesNotMatch(source, /const lldBuild =/);
});

test("pins the WASI close patch that prevents successful output streams from inheriting stale errno", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(REPO_ROOT, "producer/clang-browser/manifest.json"),
      "utf8",
    ),
  );
  const buildSource = await readFile(
    path.join(REPO_ROOT, "producer/clang-browser/scripts/build-toolchain.mjs"),
    "utf8",
  );
  const patchSpec = manifest.sources.llvmWasiClosePatch;
  const patchPath = path.join(
    REPO_ROOT,
    "producer/clang-browser",
    patchSpec.path,
  );
  const patchSource = await readFile(patchPath, "utf8");

  assert.equal(patchSpec.path, "patches/llvm-wasi-close.patch");
  assert.match(patchSpec.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    createHash("sha256").update(patchSource).digest("hex"),
    patchSpec.sha256,
  );
  assert.match(buildSource, /patchLlvmWasiClose\(\)/);
  assert.match(buildSource, /LLVM WASI close patch/);
  assert.match(patchSource, /if \(::close\(FD\) < 0\)/);
  assert.match(patchSource, /return std::error_code\(\);/);
  assert.match(
    execFileSync("git", ["apply", "--numstat", patchPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }),
    /^3\s+2\s+llvm\/lib\/Support\/Unix\/Process\.inc$/m,
  );
  assert.doesNotMatch(
    patchSource,
    /::close\(FD\);\n\+\s*return errnoAsErrorCode\(\);/,
  );
});

test("pins the clangd Asyncify bridge required for browser stdin", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(REPO_ROOT, "producer/clang-browser/manifest.json"),
      "utf8",
    ),
  );
  const buildSource = await readFile(
    path.join(REPO_ROOT, "producer/clang-browser/scripts/build-toolchain.mjs"),
    "utf8",
  );
  const packageSource = await readFile(
    path.join(
      REPO_ROOT,
      "producer/clang-browser/scripts/package-toolchain.mjs",
    ),
    "utf8",
  );
  const verifySource = await readFile(
    path.join(
      REPO_ROOT,
      "producer/clang-browser/scripts/verify-artifacts.mjs",
    ),
    "utf8",
  );
  const patchSpec = manifest.sources.clangdEmscriptenStdinPatch;
  const patchPath = path.join(
    REPO_ROOT,
    "producer/clang-browser",
    patchSpec.path,
  );
  const patchSource = await readFile(patchPath, "utf8");

  assert.equal(patchSpec.path, "patches/clangd-emscripten-stdin.patch");
  assert.match(patchSpec.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    createHash("sha256").update(patchSource).digest("hex"),
    patchSpec.sha256,
  );
  assert.match(buildSource, /patchClangdForEmscriptenStdin\(\)/);
  assert.match(buildSource, /clangd Emscripten stdin patch/);
  assert.match(patchSource, /EM_ASYNC_JS\(void, waitForStdin/);
  assert.match(patchSource, /await Module\.stdinReady\(\)/);
  assert.match(patchSource, /while \(!feof\(In\)\)/);
  assert.match(
    execFileSync("git", ["apply", "--numstat", patchPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }),
    /^11\s+0\s+clang-tools-extra\/clangd\/JSONTransport\.cpp$/m,
  );
  assert.match(packageSource, /assertClangdStdinBridge/);
  assert.match(packageSource, /stdinBridge: 'emscripten-asyncify'/);
  assert.match(verifySource, /assertClangdStdinBridge/);
});

test("requires the browser linker runtime libraries in the packaged sysroot", async () => {
  const buildSource = await readFile(
    path.join(REPO_ROOT, "producer/clang-browser/scripts/build-toolchain.mjs"),
    "utf8",
  );
  const smokeSource = await readFile(
    path.join(REPO_ROOT, "producer/clang-browser/scripts/smoke-artifacts.mjs"),
    "utf8",
  );

  for (const runtimeFile of [
    "crt1.o",
    "libc.a",
    "libc-printscan-long-double.a",
    "libc++.a",
    "libc++abi.a",
    "libm.a",
    "libwasi-emulated-mman.a",
  ]) {
    assert.ok(buildSource.includes(`'${runtimeFile}'`));
    assert.ok(smokeSource.includes(`lib/wasm32-wasi/${runtimeFile}`));
  }
});

test("the SDK long-double library replaces the trapping printf/scanf implementations", {
  skip: !process.env.WASI_SDK_PATH && "Set WASI_SDK_PATH for the WASI execution regression",
}, async (t) => {
  const { WASI } = await import("node:wasi");
  const sdk = path.resolve(process.env.WASI_SDK_PATH);
  const directory = await mkdtemp(path.join(os.tmpdir(), "wasm-llvm-long-double-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "long-double.c");
  await writeFile(source, `#include <float.h>
#include <stdio.h>
_Static_assert(sizeof(long double) == 16 && LDBL_MANT_DIG == 113,
               "The WASI long double ABI must remain binary128");
int main(void) {
  char buffer[64];
  long double scanned = 0;
  if (snprintf(buffer, sizeof buffer, "%.3Lf", 1.25L) != 5) return 1;
  if (sscanf("2.5", "%Lf", &scanned) != 1 || scanned != 2.5L) return 2;
  printf("format=%s scan=%.3Lf\\n", buffer, scanned);
  return 0;
}
`);
  const compiler = path.join(sdk, "bin", "clang");
  const options = ["--target=wasm32-wasi", source];
  const baseline = path.join(directory, "baseline.wasm");
  const repaired = path.join(directory, "repaired.wasm");
  execFileSync(compiler, [...options, "-o", baseline], { stdio: "pipe" });
  // This archive must precede libc so its definitions replace libc's stubs.
  execFileSync(compiler, [...options, "-lc-printscan-long-double", "-o", repaired], {
    stdio: "pipe",
  });
  async function runWasi(file, label) {
    const stdoutPath = path.join(directory, `${label}.stdout`);
    const stderrPath = path.join(directory, `${label}.stderr`);
    const stdout = await open(stdoutPath, "w");
    const stderr = await open(stderrPath, "w");
    let exitCode;
    let error;
    try {
      const wasi = new WASI({
        version: "preview1", args: ["long-double"], env: {}, preopens: {},
        returnOnExit: true, stdout: stdout.fd, stderr: stderr.fd,
      });
      const module = await WebAssembly.compile(await readFile(file));
      const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
      try {
        exitCode = wasi.start(instance);
      } catch (caught) {
        error = caught;
      }
    } finally {
      await stdout.close();
      await stderr.close();
    }
    return {
      exitCode, error,
      stdout: await readFile(stdoutPath, "utf8"),
      stderr: await readFile(stderrPath, "utf8"),
    };
  }
  const withoutLibrary = await runWasi(baseline, "baseline");
  assert.ok(withoutLibrary.error instanceof WebAssembly.RuntimeError);
  assert.match(withoutLibrary.stderr, /Support for formatting long double values is currently disabled/);
  const withLibrary = await runWasi(repaired, "repaired");
  assert.equal(withLibrary.error, undefined);
  assert.equal(withLibrary.exitCode, 0);
  assert.equal(withLibrary.stdout, "format=1.250 scan=2.500\n");
  assert.equal(withLibrary.stderr, "");
});
