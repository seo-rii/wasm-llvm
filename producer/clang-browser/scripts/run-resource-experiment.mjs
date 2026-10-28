#!/usr/bin/env node
// Keep rejected resource profiles in the report instead of losing later candidates.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(
    [
      "--consumer",
      "--fixtures",
      "--base-url",
      "--json",
      "--runs",
      "--profiles",
    ].includes(process.argv[i]) && process.argv[i + 1],
    "Invalid option",
  );
  args.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ["--consumer", "--fixtures", "--base-url", "--json"])
  assert(args.has(key), `Missing ${key}`);
const runs = Number(args.get("--runs") || 1);
assert(
  Number.isSafeInteger(runs) && runs > 0 && runs <= 10,
  "Invalid repeat count",
);
const profiles = (args.get("--profiles") || "unconstrained").split(",");
assert(
  profiles.length &&
    profiles.every((x) => ["unconstrained", "constrained"].includes(x)),
  "Invalid network profile",
);
const consumer = path.resolve(args.get("--consumer"));
const fixtureFile = path.resolve(args.get("--fixtures"));
const fixtureBytes = await readFile(fixtureFile);
const fixtures = JSON.parse(fixtureBytes);
assert(
  fixtures.experiment?.kind === "generated-resource-transform",
  "Expected resource experiment fixtures",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  experiment: fixtures.experiment,
  fixtureSha256: sha(fixtureBytes),
  consumerCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: consumer,
    encoding: "utf8",
  }).trim(),
  consumerTrackedDirty: !!execFileSync("git", ["diff", "HEAD", "--name-only"], {
    cwd: consumer,
    encoding: "utf8",
  }).trim(),
  consumerProbeSha256: sha(
    await readFile(path.join(consumer, "scripts/benchmark-clang-browser.mjs")),
  ),
  host: {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    node: process.version,
    initialLoadAverage: os.loadavg(),
  },
  runs,
  profiles,
  limitations: [
    "Generated artifact transforms, not source-built release candidates.",
    "Initial memory is declared capacity, not measured resident memory.",
    "Shared-host latency is screening evidence only; no production promotion is implied.",
  ],
  candidates: [],
};
// Fail fast on dependency/import errors before entering the long benchmark retries.
const require = createRequire(path.join(consumer, "package.json"));
const { chromium } = require("playwright-core");
const { resolveChromiumExecutable } = await import(
  pathToFileURL(path.join(consumer, "scripts/rust-browser-probe-lib.mjs"))
);
const { addBrowserTestCookies } = await import(
  pathToFileURL(path.join(consumer, "scripts/browser-test-cookies.mjs"))
);
const browser = await chromium.launch({
  headless: true,
  executablePath: await resolveChromiumExecutable(
    process.env.WASM_IDLE_CHROMIUM_EXECUTABLE || "",
  ),
  args: ["--no-sandbox"],
});
try {
  report.chromium = browser.version();
  const context = await browser.newContext();
  const pageUrl = new URL(
    "scripts/performance-browser.html",
    args.get("--base-url"),
  ).href;
  await addBrowserTestCookies(context, pageUrl);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      console.error(`HTTP ${response.status()}: ${response.url()}`);
  });
  await page.goto(pageUrl, { timeout: 30_000 });
  await page.waitForFunction(() => !!globalThis.performanceProbe, undefined, {
    timeout: 15_000,
  });
} finally {
  await browser.close();
}

const output = path.resolve(args.get("--json"));
await mkdir(path.dirname(output), { recursive: true });
const parts = await mkdtemp(
  path.join(path.dirname(output), ".resource-probe-"),
);
for (const [name, fixture] of Object.entries(fixtures.clangd)) {
  assert(/^[a-z0-9-]+$/.test(name), "Invalid candidate name");
  const partial = path.join(parts, `${name}.json`);
  const command = [
    "scripts/benchmark-clang-browser.mjs",
    "--fixtures",
    fixtureFile,
    "--json",
    partial,
    "--base-url",
    args.get("--base-url"),
    "--runs",
    String(runs),
    "--only",
    "clangd",
    "--variants",
    name,
    "--profiles",
    profiles.join(","),
  ];
  let stderr = "";
  const child = spawn(process.execPath, command, {
    cwd: consumer,
    stdio: ["ignore", "inherit", "pipe"],
  });
  child.stderr.on("data", (data) => {
    process.stderr.write(data);
    stderr = (stderr + data).slice(-16_384);
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let data;
  try {
    data = JSON.parse(await readFile(partial, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  report.candidates.push({
    name,
    profile: fixture.profile,
    integrity: fixture.integrity,
    exit: result,
    stderr: result.code === 0 ? undefined : stderr,
    data: data || null,
  });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
if (report.candidates.some((candidate) => candidate.exit.code !== 0))
  process.exitCode = 1;
