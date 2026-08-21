#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  loadTinyGoProducerContract,
  sha256,
  validateTinyGoCompilerReceipt,
} from "./source-contract.mjs";
import {
  runNativeSplitPipeline,
  runWasiModule,
  validateNativeLinkPlan,
} from "./probe-native-split-pipeline.mjs";

const execFileAsync = promisify(execFile);
const THIS_FILE = fileURLToPath(import.meta.url);
const PRODUCER_ROOT = path.resolve(path.dirname(THIS_FILE), "..");
const COMPILER_RECEIPT_FORMAT = "wasm-llvm-tinygo-browser-compiler-v5";
const RUNTIME_CLOSURE_FORMAT = "wasm-llvm-tinygo-runtime-closure-v2";
const RUNTIME_PROFILE_ID = "wasip1-asyncify-precise-o1";
const MAX_GO_LIST_BYTES = 64 * 1024 * 1024;
const SOURCE_FILE_FIELDS = [
  "GoFiles",
  "CgoFiles",
  "CFiles",
  "CXXFiles",
  "SFiles",
  "EmbedFiles",
];
const NATIVE_OBJECT_FIELDS = new Map([
  ["target-c", "CFiles"],
  ["target-cxx", "CXXFiles"],
  ["target-assembly", "SFiles"],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256Buffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const options = {};
  const flags = new Map([
    ["--compiler", "compilerPath"],
    ["--root", "rootPath"],
    ["--build-receipt", "buildReceiptPath"],
    ["--source-receipt", "sourceReceiptPath"],
    ["--native-tinygo", "nativeTinyGoPath"],
    ["--native-goroot", "nativeGoRootPath"],
    ["--lld-wasm", "lldWasmPath"],
    ["--wasm-opt", "wasmOptPath"],
    ["--fixture", "fixturePath"],
    ["--stdin", "stdinPath"],
    ["--stdout", "stdoutPath"],
    ["--work-dir", "workDir"],
    ["--producer-receipt", "producerReceiptPath"],
  ]);
  if (argv.some((argument) => argument === "--help" || argument === "-h")) {
    return { help: true };
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    const property = flags.get(argument);
    if (!property) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a path`);
    }
    if (options[property]) throw new Error(`Duplicate option: ${argument}`);
    options[property] = path.resolve(value);
    index += 1;
  }
  for (const [flag, property] of flags) {
    if (!options[property]) throw new Error(`${flag} is required`);
  }
  return { help: false, ...options };
}

export function parseConcatenatedJSON(source) {
  const values = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    assert(source[index] === "{", `go list JSON value ${values.length} is not an object`);
    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          values.push(JSON.parse(source.slice(start, index)));
          break;
        }
      }
    }
    assert(depth === 0 && !inString, "go list emitted truncated JSON");
  }
  assert(values.length > 0, "go list emitted no packages");
  return values;
}

function replacePathPrefix(value, sourceRoot, destinationRoot) {
  if (typeof value === "string") {
    if (value === sourceRoot) return destinationRoot;
    if (value.startsWith(`${sourceRoot}${path.sep}`)) {
      return path.join(destinationRoot, value.slice(sourceRoot.length + 1));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replacePathPrefix(entry, sourceRoot, destinationRoot));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replacePathPrefix(entry, sourceRoot, destinationRoot),
      ]),
    );
  }
  return value;
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export async function normalizePackageGraph(packages, { rootPath, fixtureDir }) {
  const gorootPackages = packages.filter((pkg) => pkg?.Goroot === true);
  const syntheticRoots = new Set(
    gorootPackages.map((pkg) => pkg?.Root).filter((root) => typeof root === "string"),
  );
  assert(syntheticRoots.size === 1, "go list must identify one synthetic GOROOT");
  const [syntheticRoot] = syntheticRoots;
  const normalized = packages.map((pkg) =>
    replacePathPrefix(pkg, syntheticRoot, rootPath),
  );
  for (const pkg of normalized) {
    assert(
      typeof pkg.ImportPath === "string" && pkg.ImportPath.length > 0,
      "go list package is missing ImportPath",
    );
    assert(
      typeof pkg.Dir === "string" && path.isAbsolute(pkg.Dir),
      `go list package ${pkg.ImportPath} is missing an absolute Dir`,
    );
    assert(
      isInside(pkg.Dir, rootPath) || isInside(pkg.Dir, fixtureDir),
      `package ${pkg.ImportPath} escapes the root and fixture preopens: ${pkg.Dir}`,
    );
    for (const field of SOURCE_FILE_FIELDS) {
      const files = pkg[field] ?? [];
      assert(Array.isArray(files), `package ${pkg.ImportPath} ${field} is not an array`);
      for (const file of files) {
        assert(
          typeof file === "string" && file.length > 0 && !path.isAbsolute(file),
          `package ${pkg.ImportPath} has an invalid ${field} entry`,
        );
        await access(path.join(pkg.Dir, file));
      }
    }
  }
  const serialized = normalized.map((pkg) => JSON.stringify(pkg)).join("\n") + "\n";
  assert(
    !serialized.includes(syntheticRoot),
    "normalized package graph retains the host synthetic GOROOT",
  );
  return { packages: normalized, serialized, syntheticRoot };
}

async function fileEvidence(filePath) {
  const bytes = await readFile(filePath);
  return { path: filePath, bytes: bytes.length, sha256: sha256Buffer(bytes) };
}

async function verifyLinkPlanSourceEvidence({
  linkPlan,
  packageGraph,
  fixtureDir,
  rootPath,
  expectedNativeSources,
}) {
  const packages = new Map(
    packageGraph.packages.map((pkg) => [pkg.ImportPath, pkg]),
  );
  const nativeEvidence = [];
  const dependencySets = [
    ...linkPlan.cgoInputs.map((input) => input.dependencies ?? []),
    ...linkPlan.objects
      .filter((object) => NATIVE_OBJECT_FIELDS.has(object.kind))
      .map((object) => object.dependencies ?? []),
  ];
  for (const input of linkPlan.cgoInputs) {
    const pkg = packages.get(input.importPath);
    assert(pkg, `CGo input identifies unknown package ${input.importPath}`);
    assert(
      (pkg.CgoFiles ?? []).includes(input.sourcePath),
      `CGo input is not bound to ${input.importPath}.CgoFiles`,
    );
    const evidence = await fileEvidence(path.join(pkg.Dir, input.sourcePath));
    assert(
      evidence.bytes === input.bytes && evidence.sha256 === input.sha256,
      `CGo input differs from package source ${input.sourcePath}`,
    );
    nativeEvidence.push({ path: input.sourcePath, sha256: input.sha256 });
  }
  for (const object of linkPlan.objects.filter((candidate) =>
    NATIVE_OBJECT_FIELDS.has(candidate.kind),
  )) {
    const pkg = packages.get(object.importPath);
    const sourceField = NATIVE_OBJECT_FIELDS.get(object.kind);
    assert(pkg, `target-native object identifies unknown package ${object.importPath}`);
    assert(
      object.sourceField === sourceField && (pkg[sourceField] ?? []).includes(object.sourcePath),
      `${object.kind} object is not bound to ${object.importPath}.${sourceField}`,
    );
    const evidence = await fileEvidence(path.join(pkg.Dir, object.sourcePath));
    assert(
      evidence.sha256 === object.sourceSha256,
      `${object.kind} object source differs from ${object.sourcePath}`,
    );
    nativeEvidence.push({ path: object.sourcePath, sha256: object.sourceSha256 });
  }
  for (const dependencies of dependencySets) {
    for (const dependency of dependencies) {
      const scopeRoot = dependency.scope === "root" ? rootPath : fixtureDir;
      const evidence = await fileEvidence(
        path.join(scopeRoot, ...dependency.path.split("/")),
      );
      assert(
        evidence.bytes === dependency.bytes &&
          evidence.sha256 === dependency.sha256,
        `native dependency differs from ${dependency.scope}:${dependency.path}`,
      );
    }
  }
  const expected = expectedNativeSources
    .map((source) => ({
      path: path.relative(fixtureDir, path.join(PRODUCER_ROOT, source.path)),
      sha256: source.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  nativeEvidence.sort((left, right) => left.path.localeCompare(right.path));
  assert(
    JSON.stringify(nativeEvidence) === JSON.stringify(expected),
    "link plan native sources differ from the locked CGo+C+C++/assembly fixture",
  );
}

async function loadRuntimeClosure({ rootPath, compilerEvidence }) {
  const manifestPath = path.join(
    rootPath,
    "runtime",
    RUNTIME_PROFILE_ID,
    "manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(manifest.format === RUNTIME_CLOSURE_FORMAT, "unexpected TinyGo runtime closure format");
  assert(manifest.compilerSha256 === compilerEvidence.sha256, "runtime closure compiler hash differs");
  assert(manifest.profile?.id === RUNTIME_PROFILE_ID, "runtime closure profile differs");
  const assets = [
    manifest.compilerRT,
    manifest.wasiLibc,
    ...Object.values(manifest.extraFiles ?? {}),
  ];
  assets.push(manifest.libCxx, manifest.libCxxAbi);
  assert(assets.length === 7, "runtime closure must contain exactly seven link inputs");
  for (const asset of assets) {
    assert(typeof asset?.path === "string", "runtime closure asset path is missing");
    const assetPath = path.join(rootPath, asset.path);
    assert(isInside(assetPath, rootPath), `runtime closure asset escapes root: ${asset.path}`);
    const evidence = await fileEvidence(assetPath);
    assert(
      evidence.bytes === asset.bytes && evidence.sha256 === asset.sha256,
      `runtime closure asset differs: ${asset.path}`,
    );
  }
  return {
    manifest,
    compilerRT: path.join(rootPath, manifest.compilerRT.path),
    wasiLibc: path.join(rootPath, manifest.wasiLibc.path),
    libCxx: path.join(rootPath, manifest.libCxx.path),
    libCxxAbi: path.join(rootPath, manifest.libCxxAbi.path),
    extraFiles: Object.fromEntries(
      Object.entries(manifest.extraFiles).map(([source, asset]) => [
        source,
        path.join(rootPath, asset.path),
      ]),
    ),
  };
}

export async function acceptBrowserCompiler(options, dependencies = {}) {
  const runWasi = dependencies.runWasiModule ?? runWasiModule;
  const runSplit = dependencies.runNativeSplitPipeline ?? runNativeSplitPipeline;
  const runNativeTinyGoList = dependencies.runNativeTinyGoList ?? (async () => {
    const result = await execFileAsync(
      options.nativeTinyGoPath,
      ["list", "-json", "-deps", "-target=wasip1", "."],
      {
        cwd: path.dirname(options.fixturePath),
        env: {
          ...process.env,
          GO111MODULE: "off",
          GOROOT: options.nativeGoRootPath,
          GOWORK: "off",
          TINYGOROOT: options.rootPath,
        },
        encoding: "utf8",
        maxBuffer: MAX_GO_LIST_BYTES,
      },
    );
    return result.stdout;
  });
  const contract = dependencies.contract ?? (await loadTinyGoProducerContract());
  const [buildReceipt, sourceReceiptSource, compilerEvidence, rootMetadata] =
    await Promise.all([
      readFile(options.buildReceiptPath, "utf8").then(JSON.parse),
      readFile(options.sourceReceiptPath),
      fileEvidence(options.compilerPath),
      stat(options.rootPath),
    ]);
  assert(buildReceipt.status === "passed", "browser compiler build receipt must be passed");
  assert(rootMetadata.isDirectory(), "TinyGo root must be an extracted directory");
  assert(
    buildReceipt.assets?.find((asset) => asset.path === "tinygo-compiler.wasm")?.sha256 ===
      compilerEvidence.sha256,
    "compiler differs from its passed build receipt",
  );
  assert(
    !(await lstat(options.workDir).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    })),
    `refusing to replace existing acceptance work directory ${options.workDir}`,
  );
  const expectedFixturePaths = {
    fixturePath: path.join(PRODUCER_ROOT, contract.manifest.acceptance.fixture),
    stdinPath: path.join(PRODUCER_ROOT, contract.manifest.acceptance.stdin),
    stdoutPath: path.join(PRODUCER_ROOT, contract.manifest.acceptance.stdout),
  };
  for (const [property, expectedPath] of Object.entries(expectedFixturePaths)) {
    assert(options[property] === expectedPath, `${property} differs from the locked acceptance fixture`);
  }
  const fixtureDir = path.dirname(options.fixturePath);
  const embedPath = path.join(PRODUCER_ROOT, contract.manifest.acceptance.embed);
  const [fixtureBytes, embedBytes, stdinBytes, stdoutBytes, nativeSourceEvidence, runtime] = await Promise.all([
    readFile(options.fixturePath),
    readFile(embedPath),
    readFile(options.stdinPath),
    readFile(options.stdoutPath),
    Promise.all(
      contract.acceptance.nativeSources.map(async (source) => ({
        ...source,
        actualSha256: sha256(
          await readFile(path.join(PRODUCER_ROOT, source.path)),
        ),
      })),
    ),
    loadRuntimeClosure({ rootPath: options.rootPath, compilerEvidence }),
  ]);
  assert(sha256(fixtureBytes) === contract.acceptance.sourceSha256, "acceptance source differs");
  assert(sha256(embedBytes) === contract.acceptance.embedSha256, "acceptance embed input differs");
  assert(sha256(stdinBytes) === contract.acceptance.stdinSha256, "acceptance stdin differs");
  assert(sha256(stdoutBytes) === contract.acceptance.stdoutSha256, "acceptance stdout differs");
  assert(
    nativeSourceEvidence.every((source) => source.actualSha256 === source.sha256),
    "acceptance native source differs",
  );

  const outputDir = path.join(options.workDir, "output");
  const temporaryDir = path.join(options.workDir, "tmp");
  const cacheDir = path.join(options.workDir, "cache");
  const homeDir = path.join(options.workDir, "home");
  await Promise.all([
    mkdir(outputDir, { recursive: true }),
    mkdir(temporaryDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);
  const rawPackageList = await runNativeTinyGoList();
  const packageGraph = await normalizePackageGraph(parseConcatenatedJSON(rawPackageList), {
    rootPath: options.rootPath,
    fixtureDir,
  });
  const packageJSONPath = path.join(options.workDir, "package-list.json");
  const requestPath = path.join(options.workDir, "request.json");
  await writeFile(packageJSONPath, packageGraph.serialized, "utf8");
  const request = {
    package: ".",
    packageJSON: packageJSONPath,
    workingDirectory: fixtureDir,
    outputDirectory: outputDir,
    temporaryDirectory: temporaryDir,
    target: "wasip1",
    opt: "1",
    gc: "precise",
    panicStrategy: "print",
    scheduler: "asyncify",
    debug: false,
    parallelism: 1,
    runtime: {
      compilerRT: runtime.compilerRT,
      wasiLibc: runtime.wasiLibc,
      libCxx: runtime.libCxx,
      libCxxAbi: runtime.libCxxAbi,
      extraFiles: runtime.extraFiles,
    },
  };
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const restrictedPreopens = {
    [options.rootPath]: options.rootPath,
    [fixtureDir]: fixtureDir,
    [options.workDir]: options.workDir,
  };
  const compilerRun = await runWasi({
    modulePath: options.compilerPath,
    args: ["tinygo-browser-adapter", requestPath],
    env: {
      GO111MODULE: "off",
      GOCACHE: cacheDir,
      GOROOT: options.rootPath,
      GOVERSION: contract.lock.goToolchain.version,
      GOWORK: "off",
      HOME: homeDir,
      PWD: fixtureDir,
      TINYGOROOT: options.rootPath,
      TINYGO_BROWSER_COMPILER_BUILD_ID: compilerEvidence.sha256,
      TMPDIR: temporaryDir,
    },
    preopens: restrictedPreopens,
  });
  assert(
    compilerRun.exitCode === 0,
    `browser compiler exited with ${compilerRun.exitCode}: ${compilerRun.stderr
      .subarray(0, 8 * 1024)
      .toString("utf8")
      .trim()}`,
  );
  assert(compilerRun.stderr.length === 0, `browser compiler stderr: ${compilerRun.stderr.toString("utf8")}`);

  const linkPlanPath = path.join(outputDir, "link-plan.json");
  const linkPlan = validateNativeLinkPlan(JSON.parse(await readFile(linkPlanPath, "utf8")));
  assert(
    linkPlan.compilerSha256 === compilerEvidence.sha256,
    "link plan compiler SHA-256 differs from the executed compiler",
  );
  await verifyLinkPlanSourceEvidence({
    linkPlan,
    packageGraph,
    fixtureDir,
    rootPath: options.rootPath,
    expectedNativeSources: contract.acceptance.nativeSources,
  });
  const unoptimizedWasmPath = path.join(outputDir, "program.unoptimized.wasm");
  const outputWasmPath = path.join(outputDir, "program.wasm");
  const finalization = await runSplit(
    {
      objectRootPath: outputDir,
      linkPlanPath,
      lldWasmPath: options.lldWasmPath,
      wasmOptPath: options.wasmOptPath,
      unoptimizedWasmPath,
      outputWasmPath,
      expectedStdinPath: options.stdinPath,
      expectedStdoutPath: options.stdoutPath,
    },
    {
      runWasiModuleImpl: (runOptions) =>
        runWasi({ ...runOptions, preopens: restrictedPreopens }),
    },
  );
  const [objectEvidence, linkPlanEvidence, finalWasmEvidence] = await Promise.all([
    Promise.all(
      linkPlan.objects.map(async (object) => ({
        ...(await fileEvidence(path.join(outputDir, ...object.path.split("/")))),
        path: object.path,
      })),
    ),
    fileEvidence(linkPlanPath),
    fileEvidence(outputWasmPath),
  ]);
  const receipt = {
    schemaVersion: 5,
    format: COMPILER_RECEIPT_FORMAT,
    producerId: contract.manifest.producerId,
    ...buildReceipt.compilerReceiptSeed,
    build: {
      ...buildReceipt.compilerReceiptSeed.build,
      finalization: {
        ...buildReceipt.compilerReceiptSeed.build.finalization,
        linkArguments: [...linkPlan.arguments],
      },
    },
    verification: {
      status: "passed",
      identityMode: "upstream-package-graph",
      compilerVersion: buildReceipt.nativeTinyGo.version,
      acceptance: {
        status: "passed",
        fixture: {
          sourceSha256: contract.acceptance.sourceSha256,
          nativeSources: contract.acceptance.nativeSources,
          embedSha256: contract.acceptance.embedSha256,
          stdinSha256: contract.acceptance.stdinSha256,
          stdoutSha256: contract.acceptance.stdoutSha256,
        },
        compile: {
          objects: objectEvidence,
          linkPlan: { ...linkPlanEvidence, path: "link-plan.json" },
          finalWasmSha256: finalWasmEvidence.sha256,
        },
        execution: {
          exitCode: finalization.exitCode,
          stdout: finalization.stdout,
          stdoutSha256: sha256Buffer(Buffer.from(finalization.stdout)),
        },
      },
    },
    assets: buildReceipt.assets.map((asset) => ({ ...asset })),
  };
  validateTinyGoCompilerReceipt(receipt, {
    manifest: contract.manifest,
    lock: contract.lock,
    sourceReceipt: JSON.parse(sourceReceiptSource),
    acceptance: contract.acceptance,
    manifestSha256: contract.inputs.manifestSha256,
    sourcesLockSha256: contract.inputs.sourcesLockSha256,
    sourceReceiptSha256: sha256(sourceReceiptSource),
  });
  assert(
    path.dirname(options.producerReceiptPath) === path.dirname(options.compilerPath),
    "producer receipt must be written beside compiler artifacts",
  );
  await writeFile(
    options.producerReceiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  return {
    receipt,
    packageCount: packageGraph.packages.length,
    packageJSONPath,
    requestPath,
    outputWasmPath,
  };
}

function usage() {
  return `Usage: node scripts/accept-browser-compiler.mjs --compiler PATH --root DIR --build-receipt PATH --source-receipt PATH --native-tinygo PATH --native-goroot DIR --lld-wasm PATH --wasm-opt PATH --fixture PATH --stdin PATH --stdout PATH --work-dir DIR --producer-receipt PATH

Runs the upstream TinyGo WASI compiler with only the extracted root, fixture,
and work directory preopened; finalizes with raw WASI LLD and Binaryen; executes
the locked fixture; and writes the strict producer receipt.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else {
      const result = await acceptBrowserCompiler(options);
      console.log(`passed: ${options.producerReceiptPath} (${result.packageCount} packages)`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
