import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  loadRuntimeClosure,
  normalizePackageGraph,
  parseConcatenatedJSON,
} from "../scripts/accept-browser-compiler.mjs";

const temporaryDirectories = [];

test("accepts the six-input precise runtime and rejects stale Boehm inputs or corrupted assets", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "tinygo-runtime-closure-"));
  temporaryDirectories.push(rootPath);
  const prefix = "runtime/wasip1-asyncify-precise-o1";
  await mkdir(path.join(rootPath, prefix), { recursive: true });
  const manifest = {
    format: "wasm-llvm-tinygo-runtime-closure-v2",
    compilerSha256: "a".repeat(64),
    profile: { id: "wasip1-asyncify-precise-o1" },
    extraFiles: {},
  };
  for (const [key, name, format] of [
    ["compilerRT", "compiler-rt.a", "static-archive"],
    ["wasiLibc", "wasi-libc.a", "static-archive"],
    ["libCxx", "libcxx.a", "static-archive"],
    ["libCxxAbi", "libcxxabi.a", "static-archive"],
    ["src/runtime/asm_tinygowasm.S", "extra-0.o", "wasm-object"],
    ["src/internal/task/task_asyncify_wasm.S", "extra-1.o", "wasm-object"],
  ]) {
    const bytes = Buffer.from(`verified ${name}`);
    const asset = {
      path: `${prefix}/${name}`,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format,
    };
    await writeFile(path.join(rootPath, asset.path), bytes);
    if (key.startsWith("src/")) manifest.extraFiles[key] = asset;
    else manifest[key] = asset;
  }
  const manifestPath = path.join(rootPath, prefix, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const input = { rootPath, compilerEvidence: { sha256: manifest.compilerSha256 } };
  const closure = await loadRuntimeClosure(input);
  assert.equal(Object.keys(closure.extraFiles).length, 2);
  assert.equal(
    closure.extraFiles["src/internal/task/task_asyncify_wasm.S"],
    path.join(rootPath, prefix, "extra-1.o"),
  );

  const stale = structuredClone(manifest);
  stale.extraFiles["src/runtime/gc_boehm.c"] = manifest.extraFiles["src/runtime/asm_tinygowasm.S"];
  await writeFile(manifestPath, JSON.stringify(stale));
  await assert.rejects(loadRuntimeClosure(input), /only the stack and Asyncify task objects/u);

  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(rootPath, prefix, "extra-1.o"), "corrupted");
  await assert.rejects(loadRuntimeClosure(input), /runtime closure asset differs/u);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("parses the concatenated go list object stream without confusing braces in strings", () => {
  const source = [
    JSON.stringify({ ImportPath: "first", Doc: "literal { brace } and \\\"quote\\\"" }),
    JSON.stringify({ ImportPath: "second", GoFiles: ["main.go"] }),
  ].join("\n");
  assert.deepEqual(parseConcatenatedJSON(source), [
    { ImportPath: "first", Doc: "literal { brace } and \\\"quote\\\"" },
    { ImportPath: "second", GoFiles: ["main.go"] },
  ]);
  assert.throws(() => parseConcatenatedJSON(""), /emitted no packages/u);
  assert.throws(
    () => parseConcatenatedJSON('{"ImportPath":"truncated"'),
    /truncated JSON/u,
  );
  assert.throws(
    () => parseConcatenatedJSON('[{"ImportPath":"array"}]'),
    /is not an object/u,
  );
});

test("normalizes one synthetic GOROOT and rejects paths outside the root and fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinygo-package-root-"));
  temporaryDirectories.push(root);
  const rootPath = path.join(root, "root");
  const fixtureDir = path.join(root, "fixture");
  await Promise.all([
    mkdir(path.join(rootPath, "src", "fmt"), { recursive: true }),
    mkdir(fixtureDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(rootPath, "src", "fmt", "print.go"), "package fmt\n"),
    writeFile(path.join(fixtureDir, "main.go"), "package main\n"),
  ]);
  const syntheticRoot = "/host/synthetic-go-root";
  const packages = [
    {
      Dir: `${syntheticRoot}/src/fmt`,
      ImportPath: "fmt",
      Root: syntheticRoot,
      Goroot: true,
      GoFiles: ["print.go"],
    },
    {
      Dir: fixtureDir,
      ImportPath: "_/fixture",
      GoFiles: ["main.go"],
      CgoCXXFLAGS: ["-DTINYGO_CXX_SCALE=2"],
      CgoLDFLAGS: ["-L${SRCDIR}"],
    },
  ];
  const normalized = await normalizePackageGraph(packages, {
    rootPath,
    fixtureDir,
  });
  assert.equal(normalized.packages.length, 2);
  assert.equal(normalized.packages[0].Dir, path.join(rootPath, "src", "fmt"));
  assert.deepEqual(normalized.packages[1].CgoCXXFLAGS, ["-DTINYGO_CXX_SCALE=2"]);
  assert.deepEqual(normalized.packages[1].CgoLDFLAGS, ["-L${SRCDIR}"]);
  assert.doesNotMatch(normalized.serialized, /host\/synthetic-go-root/u);

  await assert.rejects(
    normalizePackageGraph(
      [
        packages[0],
        { Dir: path.join(root, "escape"), ImportPath: "escape", GoFiles: [] },
      ],
      { rootPath, fixtureDir },
    ),
    /escapes the root and fixture preopens/u,
  );
  await assert.rejects(
    normalizePackageGraph(
      [{ ...packages[0], GoFiles: ["/absolute.go"] }],
      { rootPath, fixtureDir },
    ),
    /invalid GoFiles entry/u,
  );
  await assert.rejects(
    normalizePackageGraph(
      [{ ...packages[0], CgoCXXFLAGS: "-DTINYGO_CXX_SCALE=2" }],
      { rootPath, fixtureDir },
    ),
    /CgoCXXFLAGS is not an array/u,
  );
});
