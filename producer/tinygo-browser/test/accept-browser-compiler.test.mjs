import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  normalizePackageGraph,
  parseConcatenatedJSON,
} from "../scripts/accept-browser-compiler.mjs";

const temporaryDirectories = [];

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
    },
  ];
  const normalized = await normalizePackageGraph(packages, {
    rootPath,
    fixtureDir,
  });
  assert.equal(normalized.packages.length, 2);
  assert.equal(normalized.packages[0].Dir, path.join(rootPath, "src", "fmt"));
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
});
