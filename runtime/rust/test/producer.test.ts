import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const producerRoot = path.join(repoRoot, "producer", "rust-browser");
const script = path.join(producerRoot, "scripts", "producer.mjs");
const tempDirs: string[] = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wasm-llvm-rust-producer-"),
  );
  tempDirs.push(directory);
  return directory;
}

async function createFixtureManifest(root: string) {
  const sourceDir = path.join(root, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main"], {
    cwd: sourceDir,
  });
  await execFileAsync("git", ["config", "user.name", "Producer Test"], {
    cwd: sourceDir,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "producer-test@example.invalid"],
    {
      cwd: sourceDir,
    },
  );
  await fs.writeFile(path.join(sourceDir, "input.txt"), "pinned source\n");
  await execFileAsync("git", ["add", "input.txt"], { cwd: sourceDir });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: sourceDir });
  const { stdout: commitStdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    {
      cwd: sourceDir,
    },
  );
  const { stdout: treeStdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD^{tree}"],
    {
      cwd: sourceDir,
    },
  );
  const commit = commitStdout.trim();
  const tree = treeStdout.trim();
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        producerId: "@seo-rii/wasm-llvm/rust-browser-test",
        sourceDateEpoch: 1,
        environment: {
          platform: "linux/amd64",
          baseImage: `fixture@sha256:${"0".repeat(64)}`,
          debianSnapshot: "20260101T000000Z",
          cmake: { version: "test", sha256: "1".repeat(64) },
          node: { version: "test", sha256: "2".repeat(64) },
        },
        upstreamPatchOrigin: { commit: "3".repeat(40) },
        sources: {
          fixture: { repository: sourceDir, commit, tree, patchedTree: tree },
        },
        downloads: {},
        configurationFiles: [],
        hostTools: [],
        outputs: [
          "rust/bin/rustc.wasm",
          "rust/lib/rustlib/wasm32-wasip1/lib",
          "rust/lib/rustlib/wasm32-wasip2/lib",
          "rust/lib/rustlib/wasm32-wasip3/lib",
          "producer-receipt.json",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  return manifestPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Rust browser producer", () => {
  it("locks full source revisions and verifies every checked-in input hash", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(producerRoot, "manifest.json"), "utf8"),
    );
    for (const source of Object.values(manifest.sources) as Array<
      Record<string, string | string[]>
    >) {
      expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(source.tree).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(manifest.sources.rust.requiredNewFiles).toContain(
      "compiler/rustc_llvm/llvm-wrapper/LLD.cpp",
    );
    expect(manifest.sources.rust.requiredNewFiles).toContain(
      "libloading_shim/src/real/mod.rs",
    );
    expect(manifest.sources.rust.requiredNewFiles).toContain(
      "libloading_wasi_0_9/src/lib.rs",
    );
    for (const download of Object.values(manifest.downloads) as Array<
      Record<string, string | number | boolean>
    >) {
      expect(download.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(download.size).toBeGreaterThan(0);
      if (!download.archiveOnly) {
        expect(download.entrySha256).toMatch(/^[0-9a-f]{64}$/);
        expect(download.entrySize).toBeGreaterThan(0);
      }
    }
    const result = await execFileAsync(process.execPath, [script, "verify"], {
      cwd: repoRoot,
    });
    expect(result.stdout).toContain("Verified @seo-rii/wasm-llvm/rust-browser");
  });

  it("attests and re-verifies a complete output directory", async () => {
    const root = await temporaryDirectory();
    const workDir = path.join(root, "work");
    const outDir = path.join(root, "output");
    const manifestPath = await createFixtureManifest(root);
    await fs.mkdir(path.join(outDir, "rust", "bin"), { recursive: true });
    for (const target of ["wasm32-wasip1", "wasm32-wasip2", "wasm32-wasip3"]) {
      await fs.mkdir(
        path.join(outDir, "rust", "lib", "rustlib", target, "lib"),
        { recursive: true },
      );
      await fs.writeFile(
        path.join(
          outDir,
          "rust",
          "lib",
          "rustlib",
          target,
          "lib",
          "libstd.rlib",
        ),
        target,
      );
    }
    await fs.writeFile(path.join(outDir, "rust", "bin", "rustc.wasm"), "wasm");

    await execFileAsync(
      process.execPath,
      [
        script,
        "prepare",
        "--manifest",
        manifestPath,
        "--work-dir",
        workDir,
        "--out-dir",
        outDir,
      ],
      { cwd: repoRoot },
    );

    await execFileAsync(
      process.execPath,
      [
        script,
        "attest",
        "--manifest",
        manifestPath,
        "--work-dir",
        workDir,
        "--out-dir",
        outDir,
      ],
      { cwd: repoRoot },
    );
    await execFileAsync(
      process.execPath,
      [
        script,
        "verify-output",
        "--manifest",
        manifestPath,
        "--work-dir",
        workDir,
        "--out-dir",
        outDir,
      ],
      { cwd: repoRoot },
    );

    const receipt = JSON.parse(
      await fs.readFile(path.join(outDir, "producer-receipt.json"), "utf8"),
    );
    expect(receipt.assets.map((asset: { path: string }) => asset.path)).toEqual(
      [
        "rust/bin/rustc.wasm",
        "rust/lib/rustlib/wasm32-wasip1/lib/libstd.rlib",
        "rust/lib/rustlib/wasm32-wasip2/lib/libstd.rlib",
        "rust/lib/rustlib/wasm32-wasip3/lib/libstd.rlib",
      ],
    );
  });

  it("rejects output attestation without a matching source preparation receipt", async () => {
    const root = await temporaryDirectory();
    const workDir = path.join(root, "work");
    const outDir = path.join(root, "output");
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "prepare-receipt.json"), "{}\n");

    await expect(
      execFileAsync(
        process.execPath,
        [script, "attest", "--work-dir", workDir, "--out-dir", outDir],
        {
          cwd: repoRoot,
        },
      ),
    ).rejects.toThrow("Prepare receipt does not match");
  });

  it("contains no moving source ref or unauthenticated producer download", async () => {
    const manifestText = await fs.readFile(
      path.join(producerRoot, "manifest.json"),
      "utf8",
    );
    const buildScript = await fs.readFile(
      path.join(producerRoot, "scripts", "build.sh"),
      "utf8",
    );
    const llvmConfigWrapper = await fs.readFile(
      path.join(producerRoot, "config", "wasm-llvm-config.sh.in"),
      "utf8",
    );
    expect(manifestText).not.toMatch(/"commit"\s*:\s*"(?:main|master|HEAD)"/);
    expect(manifestText).toContain('"sha256"');
    expect(buildScript).not.toContain("git clone");
    expect(buildScript).not.toMatch(/\bcurl\s+-/);
    for (const tool of [
      "clang",
      "lld",
      "llvm-ar",
      "llvm-nm",
      "llvm-ranlib",
      "llvm-config",
      "llvm-tblgen",
      "clang-tblgen",
    ]) {
      expect(buildScript).toContain(tool);
    }
    expect(buildScript).toContain(
      'cmake -E create_symlink lld "$LLVM_HOST/bin/wasm-ld"',
    );
    expect(buildScript).toContain('-DLLVM_NATIVE_TOOL_DIR="$LLVM_HOST/bin"');
    expect(buildScript).toContain(
      '"$LLVM_HOST/bin/llvm-config" --link-static --libnames',
    );
    expect(buildScript).not.toContain(
      'ninja -C "$BUILD_ROOT/llvm-host-build" -j "$JOBS" install',
    );
    expect(buildScript).not.toContain(
      'ninja -C "$BUILD_ROOT/llvm-build" -j "$JOBS" install',
    );
    expect(llvmConfigWrapper).toContain('[[ "$component" != "x86" ]]');
  });
});
