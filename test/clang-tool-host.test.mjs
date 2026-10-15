import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const build = fileURLToPath(
  new URL(
    "../producer/clang-browser/scripts/build-toolchain.mjs",
    import.meta.url,
  ),
);
const run = (args, env) =>
  execFileSync(process.execPath, [build, ...args], {
    env: { ...process.env, CLANG_TOOL_HOST: "ON", ...env },
    encoding: "utf8",
    stdio: "pipe",
  });

test("tool-host producer cannot enter default release packaging", () => {
  assert.throws(() => run([], {}), /requires --compiler-only/);
});
test("tool-host producer needs explicit separate fresh work and output directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tool-host-settings-"));
  try {
    assert.throws(
      () =>
        run(["--compiler-only"], {
          WASM_LLVM_TOOLCHAIN_WORK_DIR: "",
          WASM_LLVM_TOOLCHAIN_OUT_DIR: "",
        }),
      /requires explicit/,
    );
    assert.throws(
      () =>
        run(["--compiler-only"], {
          WASM_LLVM_TOOLCHAIN_WORK_DIR: root,
          WASM_LLVM_TOOLCHAIN_OUT_DIR: path.join(root, "out"),
        }),
      /must be separate/,
    );
    assert.throws(
      () =>
        run(["--compiler-only"], {
          WASM_LLVM_TOOLCHAIN_WORK_DIR: root,
          WASM_LLVM_TOOLCHAIN_OUT_DIR: root + "-out",
        }),
      /requires a fresh directory/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("tool-host producer rejects an unqualified LLVM revision or unpinned inputs before building", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tool-host-pin-"));
  const manifest = JSON.parse(
    readFileSync(new URL("../producer/clang-browser/manifest.json", import.meta.url), "utf8"),
  );
  // An empty PATH makes any guard regression stop at the command check instead of building.
  const emptyPath = path.join(root, "empty-path");
  mkdirSync(emptyPath);
  const pinned = {
    WASM_LLVM_TOOLCHAIN_WORK_DIR: path.join(root, "work"),
    WASM_LLVM_TOOLCHAIN_OUT_DIR: path.join(root, "out"),
    PATH: emptyPath,
    LLVM_VERSION: "",
    LLVM_COMMIT: "",
    HOST_TRIPLE: "",
    TARGET_TRIPLE: "",
    YOWASP_WASI_PATCH_REPO: "",
    YOWASP_WASI_PATCH_COMMIT: "",
    WASI_SDK_VERSION: "",
    WASI_SDK_PATH: "",
    EMSDK_VERSION: "",
    EMSDK_COMMIT: "",
  };
  try {
    assert.throws(
      () => run(["--compiler-only"], { ...pinned, LLVM_COMMIT: "unqualified" }),
      /profile-pinned LLVM revision/,
    );
    for (const [override, names] of [
      [{ LLVM_VERSION: "0.0.1", LLVM_COMMIT: manifest.sources.llvm.commit }, "LLVM_VERSION"],
      [{ YOWASP_WASI_PATCH_REPO: "https://example.invalid/llvm" }, "YOWASP_WASI_PATCH_REPO"],
      [{ YOWASP_WASI_PATCH_COMMIT: "0".repeat(40) }, "YOWASP_WASI_PATCH_COMMIT"],
      [{ WASI_SDK_VERSION: "1" }, "WASI_SDK_VERSION"],
      [{ WASI_SDK_PATH: path.join(root, "unverified-sdk") }, "WASI_SDK_PATH"],
      [{ EMSDK_VERSION: "0.0.1" }, "EMSDK_VERSION, EMSDK_COMMIT"],
      [{ EMSDK_COMMIT: "0".repeat(40) }, "EMSDK_COMMIT"],
      [{ TARGET_TRIPLE: "wasm32-unknown-unknown" }, "TARGET_TRIPLE"],
    ]) {
      assert.throws(
        () => run(["--compiler-only"], { ...pinned, ...override }),
        (error) =>
          error.stderr.includes(`requires producer-manifest pinned inputs; unset ${names}\n`),
        names,
      );
    }
    // The manifest-pinned configuration passes the guards and stops at the command check.
    assert.throws(
      () => run(["--compiler-only"], pinned),
      /Missing required command: cmake/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
