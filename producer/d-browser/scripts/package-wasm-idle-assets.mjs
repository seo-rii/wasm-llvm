import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultSourceDir = path.resolve(repoRoot, "build", "wasm-idle-root");
const defaultTargetDir = path.resolve(repoRoot, "dist", "wasm-idle");

const inputAssets = [
  { source: "ldc2.wasm", target: "bin/ldc2.wasm" },
  { source: "lld.js", target: "bin/lld.js" },
  { source: "lld.wasm", target: "bin/lld.wasm" },
  { source: "lld.data", target: "bin/lld.data" },
  { source: "ldc2.conf.tar.zst", target: "etc/ldc2.conf.tar.zst" },
  { source: "imports.tar.zst", target: "lib/imports.tar.zst" },
  { source: "runtime-libs.tar.zst", target: "lib/runtime-libs.tar.zst" },
];

const USAGE = `Usage: node scripts/package-wasm-idle-assets.mjs [--source DIR] [--out DIR] [--version VERSION]

Packages a completed LDC WASI build into the wasm-idle asset contract.

Defaults:
  --source ${path.relative(repoRoot, defaultSourceDir)}
  --out    ${path.relative(repoRoot, defaultTargetDir)}
`;

function parseArgs(argv) {
  const options = {
    sourceDir: process.env.LDC_WASM_BUILD_ROOT || defaultSourceDir,
    targetDir: defaultTargetDir,
    version: process.env.LDC_WASM_VERSION || "ldc-dev",
  };
  function readOptionValue(index, optionName) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${optionName} requires a value`);
    }
    return value;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE.trimEnd());
      process.exit(0);
    }
    if (arg === "--source") {
      options.sourceDir = readOptionValue(index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      options.targetDir = readOptionValue(index, arg);
      index += 1;
      continue;
    }
    if (arg === "--version") {
      options.version = readOptionValue(index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.version) {
    throw new Error("--version must not be empty");
  }
  return {
    sourceDir: path.resolve(options.sourceDir),
    targetDir: path.resolve(options.targetDir),
    version: options.version,
  };
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const options = parseArgs(process.argv.slice(2));
const copiedAssets = [];

await fs.rm(options.targetDir, { recursive: true, force: true });
await fs.mkdir(options.targetDir, { recursive: true });

for (const asset of inputAssets) {
  const sourcePath = path.join(options.sourceDir, asset.source);
  const targetPath = path.join(options.targetDir, asset.target);
  const bytes = await fs.readFile(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, bytes);
  copiedAssets.push({
    asset: asset.target,
    size: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  });
}

const manifest = {
  manifestVersion: 1,
  name: "ldc-wasm",
  version: options.version,
  defaultTarget: "wasm32-wasi",
  compiler: {
    ldc2: {
      asset: "bin/ldc2.wasm",
      argv0: "ldc2",
    },
    config: {
      asset: "etc/ldc2.conf.tar.zst",
    },
    imports: {
      asset: "lib/imports.tar.zst",
    },
    runtimeLibraries: {
      asset: "lib/runtime-libs.tar.zst",
    },
    linker: {
      kind: "emscripten-lld",
      argv0: "wasm-ld",
      js: {
        asset: "bin/lld.js",
      },
      wasm: {
        asset: "bin/lld.wasm",
      },
      data: {
        asset: "bin/lld.data",
      },
    },
  },
  targets: {
    "wasm32-wasi": {
      artifactFormat: "wasi-core-wasm",
      execution: {
        kind: "wasi-preview1",
      },
    },
  },
};

const buildInfo = {
  generatedAt: new Date().toISOString(),
  source: path.relative(repoRoot, options.sourceDir),
  assets: copiedAssets,
};

await fs.writeFile(
  path.join(options.targetDir, "runtime-manifest.v1.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await fs.writeFile(
  path.join(options.targetDir, "runtime-build.json"),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
);

console.log(`Packaged ldc-wasm assets in ${options.targetDir}`);
