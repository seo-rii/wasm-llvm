import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fetchMemfsSources,
  verifyMemfsModule,
} from "../producer/clang-browser/scripts/build-memfs.mjs";

const bytes = Buffer.from("pinned source fixture");
const source = {
  repository: "https://github.com/binji/llvm-project",
  commit: "1".repeat(40),
  files: {
    "memfs.c": {
      path: "binji/memfs.c",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  },
};

test("downloads only immutable receipt-verified source and reuses a verified cache", async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "memfs-source-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  let downloads = 0;
  const fetchImpl = async (url) => {
    downloads++;
    assert.equal(
      url,
      `https://raw.githubusercontent.com/binji/llvm-project/${"1".repeat(40)}/binji/memfs.c`,
    );
    return new Response(bytes);
  };
  const first = await fetchMemfsSources({ workDir, source, fetchImpl });
  const second = await fetchMemfsSources({ workDir, source, fetchImpl });
  assert.equal(downloads, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(
    await readFile(path.join(first.directory, "memfs.c")),
    bytes,
  );
});

test("rejects altered download bytes before storing source", async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "memfs-corrupt-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  await assert.rejects(
    fetchMemfsSources({
      workDir,
      source,
      fetchImpl: async () => new Response(Buffer.alloc(bytes.length, 65)),
    }),
    /SHA-256\/size mismatch/,
  );
  await assert.rejects(readFile(path.join(workDir, "source/memfs.c")), {
    code: "ENOENT",
  });
});

test("fails closed for an altered cached source instead of silently downloading over it", async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "memfs-corrupt-cache-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  await mkdir(path.join(workDir, "source"));
  await writeFile(
    path.join(workDir, "source/memfs.c"),
    Buffer.alloc(bytes.length, 66),
  );
  let downloads = 0;
  await assert.rejects(
    fetchMemfsSources({
      workDir,
      source,
      fetchImpl: async () => {
        downloads++;
        return new Response(bytes);
      },
    }),
    /SHA-256\/size mismatch/,
  );
  assert.equal(downloads, 0);
});

test("rejects a valid Wasm module that lacks the MemFS ABI", async () => {
  await assert.rejects(
    verifyMemfsModule(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
    assert.AssertionError,
  );
});

test(
  "checks the real rebuilt MemFS ABI, every available file node, and exhaustion",
  {
    skip: !process.env.MEMFS_TEST_WASM,
  },
  async () => {
    const wasm = await readFile(process.env.MEMFS_TEST_WASM);
    const report = await verifyMemfsModule(wasm);
    assert.equal(report.maxNodes, 8192);
    assert.equal(report.usableNodes, 8188);
    assert.equal(report.imports.length, 5);
    assert.equal(report.exports.length, 30);
    // A mismatched capacity claim must also fail, rather than merely passing a small smoke.
    await assert.rejects(verifyMemfsModule(wasm, 1024), assert.AssertionError);
  },
);
