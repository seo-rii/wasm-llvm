import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const USAGE = `Usage: node scripts/check-wasm-idle-assets.mjs [asset-dir]

Validates a finalized ldc-wasm asset directory. The default asset-dir is dist/wasm-idle.
`;

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE.trimEnd());
    process.exit(0);
  }
  if (argv.length > 1) {
    throw new Error(`unexpected arguments: ${argv.join(" ")}`);
  }
  return argv[0] ?? path.resolve("dist", "wasm-idle");
}

function assertAssetPath(assetPath) {
  if (typeof assetPath !== "string" || assetPath.length === 0) {
    throw new Error(`invalid asset path: ${String(assetPath)}`);
  }
  if (path.isAbsolute(assetPath)) {
    throw new Error(`asset path must be relative: ${assetPath}`);
  }
  const normalized = path.posix.normalize(assetPath);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== assetPath
  ) {
    throw new Error(
      `asset path must be normalized and stay inside the asset dir: ${assetPath}`,
    );
  }
  return normalized;
}

function collectAssetPaths(value, found = new Set()) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) collectAssetPaths(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "asset") found.add(assertAssetPath(child));
    collectAssetPaths(child, found);
  }
  return found;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function runCommandCapture(command, args) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `command failed (${code}): ${command} ${args.join(" ")}\n${Buffer.concat(
            stderr,
          ).toString("utf8")}`,
        ),
      );
    });
    child.on("error", reject);
  });
}

async function assertTarContains(tarPath, requiredEntries) {
  const output = await runCommandCapture("tar", ["--zstd", "-tf", tarPath]);
  const entries = new Set(
    output
      .split("\n")
      .map((entry) => entry.replace(/^\.\//, ""))
      .filter(Boolean),
  );
  for (const requiredEntry of requiredEntries) {
    if (!entries.has(requiredEntry)) {
      throw new Error(`${path.basename(tarPath)} is missing ${requiredEntry}`);
    }
  }
}

const assetDir = path.resolve(parseArgs(process.argv.slice(2)));
const manifestPath = path.join(assetDir, "runtime-manifest.v1.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (manifest.manifestVersion !== 1) {
  throw new Error(
    `unsupported manifestVersion in ${manifestPath}: ${manifest.manifestVersion}`,
  );
}
if (manifest.name !== "ldc-wasm") {
  throw new Error(
    `unexpected manifest name in ${manifestPath}: ${manifest.name}`,
  );
}

const assets = [...collectAssetPaths(manifest)].sort();
if (assets.length === 0) {
  throw new Error(`manifest does not reference any assets: ${manifestPath}`);
}

const checked = [];
for (const asset of assets) {
  const filePath = path.join(assetDir, asset);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`manifest asset is not a file: ${asset}`);
  }
  checked.push({
    asset,
    size: stat.size,
    sha256: await sha256File(filePath),
  });
}

const ldc2Bytes = await fs.readFile(path.join(assetDir, "bin", "ldc2.wasm"));
if (
  ldc2Bytes.length < 4 ||
  ldc2Bytes[0] !== 0x00 ||
  ldc2Bytes[1] !== 0x61 ||
  ldc2Bytes[2] !== 0x73 ||
  ldc2Bytes[3] !== 0x6d
) {
  throw new Error("bin/ldc2.wasm does not start with the WebAssembly magic");
}
const lldWasmBytes = await fs.readFile(path.join(assetDir, "bin", "lld.wasm"));
if (
  lldWasmBytes.length < 4 ||
  lldWasmBytes[0] !== 0x00 ||
  lldWasmBytes[1] !== 0x61 ||
  lldWasmBytes[2] !== 0x73 ||
  lldWasmBytes[3] !== 0x6d
) {
  throw new Error("bin/lld.wasm does not start with the WebAssembly magic");
}
const lldJs = await fs.readFile(path.join(assetDir, "bin", "lld.js"), "utf8");
if (!lldJs.includes("callMain") || !lldJs.includes("FS")) {
  throw new Error("bin/lld.js does not look like an Emscripten LLD module");
}
const lldDataStat = await fs.stat(path.join(assetDir, "bin", "lld.data"));
if (lldDataStat.size <= 0) {
  throw new Error("bin/lld.data is empty");
}

await assertTarContains(path.join(assetDir, "etc", "ldc2.conf.tar.zst"), [
  "ldc2.conf/30-compiler.conf",
  "ldc2.conf/50-target-default.conf",
  "ldc2.conf/55-target-wasm.conf",
]);
await assertTarContains(path.join(assetDir, "lib", "imports.tar.zst"), [
  "druntime/src/object.d",
  "druntime/src/core/stdc/stdio.d",
  "phobos/std/stdio.d",
  "jit-rt/d/ldc/dynamic_compile.d",
]);
await assertTarContains(path.join(assetDir, "lib", "runtime-libs.tar.zst"), [
  "lib/libdruntime-ldc.a",
  "lib/libphobos2-ldc.a",
  "lib/libclang_rt.builtins.a",
  "lib/crt1-command.o",
  "lib/libc.a",
  "lib/eh/libunwind.a",
]);

console.log(`Validated ${checked.length} ldc-wasm asset(s) in ${assetDir}`);
