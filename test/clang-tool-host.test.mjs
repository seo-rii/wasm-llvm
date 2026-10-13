import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
test("tool-host producer rejects an unqualified LLVM revision before building", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tool-host-pin-"));
  try {
    assert.throws(
      () =>
        run(["--compiler-only"], {
          WASM_LLVM_TOOLCHAIN_WORK_DIR: path.join(root, "work"),
          WASM_LLVM_TOOLCHAIN_OUT_DIR: path.join(root, "out"),
          LLVM_COMMIT: "unqualified",
        }),
      /profile-pinned LLVM revision/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
