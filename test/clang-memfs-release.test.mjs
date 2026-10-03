import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(repo, "producer/clang-browser/scripts");
const producer = JSON.parse(
  await readFile(
    path.join(repo, "producer/clang-browser/manifest.json"),
    "utf8",
  ),
);
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (bytes) => ({ bytes: bytes.length, sha256: sha(bytes) });
const sidecars = [
  "memfs-build-receipt.json",
  "LICENSE.memfs-llvm.txt",
  "LICENSE.memfs-stb_sprintf.txt",
];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memfs-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, "artifacts");
  const releaseDir = path.join(root, "release");
  await writeFile(path.join(root, "module.wasm"), wasm);
  await writeFile(path.join(root, "sysroot.tar"), Buffer.alloc(1024));
  await writeFile(path.join(root, "clangd.js"), "Module.stdinReady;");
  const name = Buffer.from("__asyncjs__waitForStdin");
  const importSection = Buffer.from([
    1,
    3,
    ...Buffer.from("env"),
    name.length,
    ...name,
    0,
    0,
  ]);
  await writeFile(
    path.join(root, "clangd.wasm"),
    Buffer.concat([
      wasm,
      Buffer.from([1, 4, 1, 96, 0, 0, 2, importSection.length]),
      importSection,
    ]),
  );
  const source = producer.sources.memfs;
  const receipt = {
    format: "wasm-llvm-memfs-build-v1",
    maxNodes: source.maxNodes,
    abi: { maxNodes: source.maxNodes, usableNodes: source.maxNodes - 4 },
    source: {
      repository: source.repository,
      commit: source.commit,
      files: source.files,
    },
    patch: {
      originalSha256: source.files["memfs.c"].sha256,
      patchedSha256: "a".repeat(64),
      builderSha256: "b".repeat(64),
    },
    license: source.license,
    outputs: { "memfs.wasm": digest(wasm) },
  };
  const receiptPath = path.join(root, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt) + "\n");
  for (const name of ["LICENSE.llvm.txt", "LICENSE.stb_sprintf.txt"]) {
    await copyFile(
      path.join(repo, "test/fixtures/memfs", name),
      path.join(root, name),
    );
  }
  const packageArgs = [
    path.join(scripts, "package-toolchain.mjs"),
    "--clang-wasm",
    path.join(root, "module.wasm"),
    "--lld-wasm",
    path.join(root, "module.wasm"),
    "--memfs-wasm",
    path.join(root, "module.wasm"),
    "--sysroot",
    path.join(root, "sysroot.tar"),
    "--clangd-js",
    path.join(root, "clangd.js"),
    "--clangd-wasm",
    path.join(root, "clangd.wasm"),
    "--target-dir",
    artifactDir,
  ];
  return {
    root,
    artifactDir,
    releaseDir,
    receipt,
    receiptPath,
    package: (withReceipt = true) =>
      exec(
        process.execPath,
        [
          ...packageArgs,
          ...(withReceipt ? ["--memfs-receipt", receiptPath] : []),
        ],
        { cwd: repo },
      ),
    release: () =>
      exec(
        process.execPath,
        [path.join(scripts, "prepare-release.mjs"), releaseDir],
        {
          cwd: repo,
          env: {
            ...process.env,
            WASM_LLVM_CLANG_ARTIFACT_DIR: artifactDir,
            WASM_LLVM_CLANG_RELEASE_DIR: releaseDir,
            WASM_LLVM_LLDB_ARTIFACT_DIR: "",
            WASM_LLVM_WAMR_ARTIFACT_DIR: "",
          },
        },
      ),
  };
}

test("preserves the receipt and verified licenses through packaging and the official release", async (t) => {
  const f = await fixture(t);
  await f.package();
  await f.release();
  const toolchain = JSON.parse(
    await readFile(path.join(f.artifactDir, "toolchain.json")),
  );
  const build = JSON.parse(
    await readFile(path.join(f.releaseDir, "runtime-build.json")),
  );
  assert.deepEqual(toolchain.memfs.buildReceipt, f.receipt);
  assert.deepEqual(build.toolchain.memfs, toolchain.memfs);
  assert.equal(Object.keys(toolchain.assets).length, 6);
  assert.equal(build.assets.length, 6);
  for (const name of sidecars) {
    const bytes = await readFile(path.join(f.releaseDir, name));
    assert.deepEqual(bytes, await readFile(path.join(f.artifactDir, name)));
    assert.deepEqual(digest(bytes), toolchain.memfs.files[name]);
  }
});

test("retains legacy/custom packaging without an explicit MemFS receipt", async (t) => {
  const f = await fixture(t);
  await f.package(false);
  await f.release();
  const build = JSON.parse(
    await readFile(path.join(f.releaseDir, "runtime-build.json")),
  );
  assert.equal(build.toolchain.memfs, undefined);
  assert.equal(build.assets.length, 6);
  await assert.rejects(readFile(path.join(f.releaseDir, sidecars[0])), {
    code: "ENOENT",
  });
});

test("rejects an explicit missing receipt before writing package assets", async (t) => {
  const f = await fixture(t);
  await rm(f.receiptPath);
  await assert.rejects(f.package(), /ENOENT/);
  await assert.rejects(readFile(path.join(f.artifactDir, "memfs.zip")), {
    code: "ENOENT",
  });
});

test("rejects receipt output and pinned-source mismatches", async (t) => {
  const f = await fixture(t);
  const altered = structuredClone(f.receipt);
  altered.outputs["memfs.wasm"].sha256 = "0".repeat(64);
  await writeFile(f.receiptPath, JSON.stringify(altered));
  await assert.rejects(f.package(), /raw module SHA-256\/size mismatch/);
  altered.outputs = f.receipt.outputs;
  altered.source.commit = "0".repeat(40);
  await writeFile(f.receiptPath, JSON.stringify(altered));
  await assert.rejects(f.package(), /pinned source\/capacity contract/);
});

test("rejects missing or modified license notices before packaging", async (t) => {
  const f = await fixture(t);
  const license = path.join(f.root, "LICENSE.stb_sprintf.txt");
  await writeFile(license, "tampered");
  await assert.rejects(
    f.package(),
    /LICENSE.stb_sprintf.txt SHA-256\/size mismatch/,
  );
  await rm(license);
  await assert.rejects(f.package(), /ENOENT/);
});

test("release rejects altered or missing sidecars, even when a license metadata hash is replaced", async (t) => {
  const f = await fixture(t);
  await f.package();
  const name = "LICENSE.memfs-stb_sprintf.txt";
  await writeFile(path.join(f.artifactDir, name), "tampered");
  await assert.rejects(f.release(), /SHA-256\/size mismatch/);
  const metadata = JSON.parse(
    await readFile(path.join(f.artifactDir, "toolchain.json")),
  );
  metadata.memfs.files[name] = digest(Buffer.from("tampered"));
  await writeFile(
    path.join(f.artifactDir, "toolchain.json"),
    JSON.stringify(metadata),
  );
  await assert.rejects(f.release(), /SHA-256\/size mismatch/);
  await rm(path.join(f.artifactDir, name));
  await assert.rejects(f.release(), /ENOENT/);
});

test("release binds the copied receipt both to metadata and to the delivered MemFS archive", async (t) => {
  const f = await fixture(t);
  await f.package();
  const metadata = JSON.parse(
    await readFile(path.join(f.artifactDir, "toolchain.json")),
  );
  metadata.memfs.buildReceipt.maxNodes = 1024;
  await writeFile(
    path.join(f.artifactDir, "toolchain.json"),
    JSON.stringify(metadata),
  );
  await assert.rejects(f.release(), /receipt sidecar disagrees/);
  metadata.memfs.buildReceipt.maxNodes = f.receipt.maxNodes;
  await writeFile(
    path.join(f.artifactDir, "toolchain.json"),
    JSON.stringify(metadata),
  );
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  await writer.add(
    "memfs",
    new Uint8ArrayReader(Buffer.concat([wasm, Buffer.from([0, 1, 0])])),
  );
  await writeFile(path.join(f.artifactDir, "memfs.zip"), await writer.close());
  await assert.rejects(f.release(), /raw module SHA-256\/size mismatch/);
});
