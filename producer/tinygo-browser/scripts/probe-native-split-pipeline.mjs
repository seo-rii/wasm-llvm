#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const THIS_FILE = fileURLToPath(import.meta.url);
const WASM_HEADER = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);
const LLVM_BITCODE_HEADER = Buffer.from([0x42, 0x43, 0xc0, 0xde]);
const THIN_LTO_CACHE_OPTION = "--thinlto-cache-dir";
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LINK_PLAN_CAPABILITIES = [
  "go-embed-objects",
  "target-cgo-c",
  "target-cxx-freestanding",
  "target-clang-assembly",
];
const NATIVE_OBJECT_SPECS = new Map([
  ["target-c", { sourceField: "CFiles", suffix: "target-c.bc", format: "llvm-bitcode", rank: 0 }],
  ["target-cxx", { sourceField: "CXXFiles", suffix: "target-cxx.bc", format: "llvm-bitcode", rank: 1 }],
  ["target-assembly", { sourceField: "SFiles", suffix: "target-assembly.o", format: "wasm-object", rank: 2 }],
]);
const CLI_PATH_OPTIONS = new Map([
  ["--object-root", "objectRootPath"],
  ["--link-plan", "linkPlanPath"],
  ["--lld-wasm", "lldWasmPath"],
  ["--wasm-opt", "wasmOptPath"],
  ["--unoptimized-wasm", "unoptimizedWasmPath"],
  ["--output-wasm", "outputWasmPath"],
  ["--expected-stdin", "expectedStdinPath"],
  ["--expected-stdout", "expectedStdoutPath"],
]);

export const NATIVE_SPLIT_PIPELINE_USAGE = [
  "Usage: node scripts/probe-native-split-pipeline.mjs \\",
  "  --object-root PATH --link-plan PATH --lld-wasm PATH --wasm-opt PATH \\",
  "  --unoptimized-wasm PATH --output-wasm PATH \\",
  "  --expected-stdin PATH --expected-stdout PATH",
  "",
  "Consumes the upstream TinyGo objects/link-plan.json v4 split output, runs the",
  "wasm-llvm raw WASI LLD, applies Binaryen wasm-opt, and executes the result.",
  "Every host path is explicit. Link plans containing --thinlto-cache-dir are rejected.",
].join("\n");

export function parseNativeSplitPipelineArgs(argv, cwd = process.cwd()) {
  if (argv.some((argument) => argument === "--help" || argument === "-h")) {
    return { help: true };
  }

  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (!argument.startsWith("-")) {
      throw new Error(
        `Unexpected positional argument ${argument}; every path needs a named option`,
      );
    }
    if (
      argument === THIN_LTO_CACHE_OPTION ||
      argument.startsWith(`${THIN_LTO_CACHE_OPTION}=`)
    ) {
      throw new Error(
        `The native split pipeline forbids ${THIN_LTO_CACHE_OPTION}`,
      );
    }
    const property = CLI_PATH_OPTIONS.get(argument);
    if (!property) throw new Error(`Unknown option: ${argument}`);
    if (parsed[property]) throw new Error(`Duplicate option: ${argument}`);

    const value = argv[index + 1];
    if (value === undefined || value === "--" || CLI_PATH_OPTIONS.has(value)) {
      throw new Error(`Option ${argument} requires a path`);
    }
    parsed[property] = path.resolve(cwd, value);
    index += 1;
  }

  for (const [option, property] of CLI_PATH_OPTIONS) {
    if (!parsed[property]) throw new Error(`Missing required option ${option}`);
  }
  return { help: false, ...parsed };
}

export function validateNativeLinkPlan(linkPlan) {
  if (!linkPlan || typeof linkPlan !== "object" || Array.isArray(linkPlan)) {
    throw new Error("link-plan.json must contain an object");
  }
  if (
    linkPlan.schemaVersion !== 4 ||
    linkPlan.format !== "wasm-llvm-tinygo-link-plan-v4" ||
    !SHA256_PATTERN.test(linkPlan.compilerSha256 ?? "") ||
    JSON.stringify(linkPlan.capabilities) !== JSON.stringify(LINK_PLAN_CAPABILITIES)
  ) {
    throw new Error("link-plan.json identity differs from compile protocol v4");
  }
  if (
    linkPlan.linker !== "wasm-ld" ||
    linkPlan.output !== "program.unoptimized.wasm"
  ) {
    throw new Error("link-plan.json linker output differs from compile protocol v4");
  }
  if (
    !Array.isArray(linkPlan.compilerPackages) ||
    linkPlan.compilerPackages.length === 0 ||
    linkPlan.compilerPackages.some(
      (packagePath) => typeof packagePath !== "string" || packagePath.length === 0,
    ) ||
    new Set(linkPlan.compilerPackages).size !== linkPlan.compilerPackages.length
  ) {
    throw new Error("link-plan.json compiler package identity is invalid");
  }
  if (!Array.isArray(linkPlan.objects) || linkPlan.objects.length === 0 || linkPlan.objects.length > 1024) {
    throw new Error("link-plan.json objects must contain 1 to 1024 entries");
  }
  const objectPaths = new Set();
  let seenEmbed = false;
  for (const [index, object] of linkPlan.objects.entries()) {
    const kind = index === 0 ? "program" : object?.kind;
    const nativeSpec = NATIVE_OBJECT_SPECS.get(kind);
    if (index !== 0 && !nativeSpec && kind !== "embed") {
      throw new Error(`link-plan.json object ${index} has an invalid kind`);
    }
    if (kind === "embed") seenEmbed = true;
    if (nativeSpec && seenEmbed) {
      throw new Error("link-plan.json target-native objects have invalid order");
    }
    const suffix = nativeSpec?.suffix ?? `${kind}.o`;
    const expectedPath = `objects/${String(index).padStart(4, "0")}-${suffix}`;
    const expectedFormat = nativeSpec?.format ?? "wasm-object";
    if (
      !object ||
      typeof object !== "object" ||
      object.kind !== kind ||
      object.path !== expectedPath ||
      object.format !== expectedFormat ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes <= 0 ||
      object.bytes > 128 * 1024 * 1024 ||
      !SHA256_PATTERN.test(object.sha256 ?? "") ||
      objectPaths.has(object.path)
    ) {
      throw new Error(`link-plan.json object ${index} is invalid`);
    }
    if (nativeSpec) {
      if (
        typeof object.importPath !== "string" ||
        object.importPath.length === 0 ||
        object.sourceField !== nativeSpec.sourceField ||
        !isSafeRelativePath(object.sourcePath) ||
        !SHA256_PATTERN.test(object.sourceSha256 ?? "")
      ) {
        throw new Error(`link-plan.json target-native object ${index} has invalid source evidence`);
      }
      validateDependencies(object.dependencies, `object ${index}`);
    } else if (kind === "embed") {
      if (
        typeof object.importPath !== "string" ||
        object.importPath.length === 0 ||
        !isSafeRelativePath(object.sourcePath) ||
        !SHA256_PATTERN.test(object.sourceSha256 ?? "") ||
        object.embeddedFileHash !== object.sourceSha256.slice(0, 32)
      ) {
        throw new Error(`link-plan.json embed object ${index} has invalid source evidence`);
      }
    }
    objectPaths.add(object.path);
  }
  if (!Array.isArray(linkPlan.cgoInputs) || linkPlan.cgoInputs.length > 1024) {
    throw new Error("link-plan.json CGo inputs must be an array with at most 1024 entries");
  }
  let previousCGoIdentity = "";
  const cgoIdentities = new Set();
  for (const [index, input] of linkPlan.cgoInputs.entries()) {
    const identity = `${input?.importPath ?? ""}\0${input?.sourcePath ?? ""}`;
    if (
      !input ||
      typeof input.importPath !== "string" ||
      input.importPath.length === 0 ||
      !isSafeRelativePath(input.sourcePath) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes <= 0 ||
      input.bytes > 16 * 1024 * 1024 ||
      !SHA256_PATTERN.test(input.sha256 ?? "") ||
      cgoIdentities.has(identity) ||
      (index !== 0 && identity <= previousCGoIdentity)
    ) {
      throw new Error(`link-plan.json CGo input ${index} is invalid`);
    }
    validateDependencies(input.dependencies, `CGo input ${index}`);
    cgoIdentities.add(identity);
    previousCGoIdentity = identity;
  }
  if (!Array.isArray(linkPlan.runtimeInputs) || linkPlan.runtimeInputs.length < 2) {
    throw new Error("link-plan.json runtime inputs are invalid");
  }
  for (const [index, input] of linkPlan.runtimeInputs.entries()) {
    const expectedKind =
      index === 0
        ? "compiler-rt"
        : index === linkPlan.runtimeInputs.length - 1
          ? "wasi-libc"
          : "extra-file";
    if (
      !input ||
      input.kind !== expectedKind ||
      typeof input.path !== "string" ||
      !path.isAbsolute(input.path) ||
      (expectedKind === "extra-file" &&
        (typeof input.source !== "string" || input.source.length === 0))
    ) {
      throw new Error(`link-plan.json runtime input ${index} is invalid`);
    }
  }
  if (
    JSON.stringify(linkPlan.optimizer) !==
    JSON.stringify({
      tool: "wasm-opt",
      input: "program.unoptimized.wasm",
      output: "program.wasm",
      arguments: [
        "--asyncify",
        "-O1",
        "-g",
        "program.unoptimized.wasm",
        "--output",
        "program.wasm",
      ],
    })
  ) {
    throw new Error("link-plan.json optimizer plan differs from compile protocol v4");
  }
  if (
    !Array.isArray(linkPlan.arguments) ||
    linkPlan.arguments.some(
      (argument) => typeof argument !== "string" || argument.length === 0,
    )
  ) {
    throw new Error(
      "link-plan.json arguments must be an array of non-empty strings",
    );
  }
  if (linkPlan.arguments[0] === "wasm-ld") {
    throw new Error(
      "link-plan.json arguments must omit the wasm-ld executable name",
    );
  }
  for (const argument of linkPlan.arguments) {
    if (
      new RegExp(`(?:^|[=,])${THIN_LTO_CACHE_OPTION}(?:$|[=,])`, "u").test(
        argument,
      )
    ) {
      throw new Error(
        `link-plan.json contains forbidden ${THIN_LTO_CACHE_OPTION} argument`,
      );
    }
  }
  const orderedInputs = [
    linkPlan.objects[0].path,
    ...linkPlan.runtimeInputs.slice(0, -1).map((input) => input.path),
    ...linkPlan.objects.slice(1).filter((object) => NATIVE_OBJECT_SPECS.has(object.kind)).map((object) => object.path),
    linkPlan.runtimeInputs.at(-1).path,
    ...linkPlan.objects.slice(1).filter((object) => object.kind === "embed").map((object) => object.path),
  ];
  let previousInputIndex = -1;
  for (const input of orderedInputs) {
    const positions = linkPlan.arguments
      .map((argument, index) => (argument === input ? index : -1))
      .filter((index) => index !== -1);
    if (positions.length !== 1 || positions[0] <= previousInputIndex) {
      throw new Error(`link-plan.json arguments have invalid input ordering for ${input}`);
    }
    previousInputIndex = positions[0];
  }
  if (linkPlan.arguments.filter((argument) => argument === linkPlan.output).length !== 1) {
    throw new Error("link-plan.json arguments must reference its output exactly once");
  }
  for (const argument of linkPlan.arguments) {
    if (argument.startsWith("objects/") && !objectPaths.has(argument)) {
      throw new Error(`link-plan.json arguments reference unknown object ${argument}`);
    }
  }
  return linkPlan;
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validateDependencies(dependencies, label) {
  if (!Array.isArray(dependencies) || dependencies.length > 4096) {
    throw new Error(`link-plan.json ${label} dependencies are invalid`);
  }
  let previousIdentity = "";
  let totalBytes = 0;
  for (const [index, dependency] of dependencies.entries()) {
    const identity = `${dependency?.scope ?? ""}\0${dependency?.path ?? ""}`;
    if (
      !dependency ||
      !["root", "workspace"].includes(dependency.scope) ||
      !isSafeRelativePath(dependency.path) ||
      !Number.isSafeInteger(dependency.bytes) ||
      dependency.bytes < 0 ||
      dependency.bytes > 16 * 1024 * 1024 ||
      !SHA256_PATTERN.test(dependency.sha256 ?? "") ||
      (index !== 0 && identity <= previousIdentity)
    ) {
      throw new Error(`link-plan.json ${label} dependency ${index} is invalid`);
    }
    totalBytes += dependency.bytes;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new Error(`link-plan.json ${label} dependencies exceed 64 MiB`);
    }
    previousIdentity = identity;
  }
}

export function materializeNativeLinkArguments(
  linkPlan,
  { objectRootPath, unoptimizedWasmPath },
) {
  validateNativeLinkPlan(linkPlan);
  const objectPaths = new Map(
    linkPlan.objects.map((object) => [
      object.path,
      path.join(objectRootPath, ...object.path.split("/")),
    ]),
  );
  const objectReferences = new Map(
    linkPlan.objects.map((object) => [object.path, 0]),
  );
  let outputReferences = 0;
  const arguments_ = linkPlan.arguments.map((argument) => {
    const objectPath = objectPaths.get(argument);
    if (objectPath) {
      objectReferences.set(argument, objectReferences.get(argument) + 1);
      return objectPath;
    }
    if (argument === linkPlan.output) {
      outputReferences += 1;
      return unoptimizedWasmPath;
    }
    return argument;
  });
  for (const [objectPath, references] of objectReferences) {
    if (references !== 1) {
      throw new Error(`link-plan.json arguments must reference ${objectPath} exactly once`);
    }
  }
  if (outputReferences === 0) {
    throw new Error("link-plan.json arguments do not reference its output");
  }
  return arguments_;
}

export async function runWasiModule({
  modulePath,
  args,
  stdin = Buffer.alloc(0),
  env = {},
  preopens = { "/": "/" },
}) {
  const captureDirectory = await mkdtemp(
    path.join(os.tmpdir(), "tinygo-native-wasi-"),
  );
  const stdinPath = path.join(captureDirectory, "stdin");
  const stdoutPath = path.join(captureDirectory, "stdout");
  const stderrPath = path.join(captureDirectory, "stderr");
  await writeFile(stdinPath, stdin);
  const [stdinHandle, stdoutHandle, stderrHandle] = await Promise.all([
    open(stdinPath, "r"),
    open(stdoutPath, "w+"),
    open(stderrPath, "w+"),
  ]);

  let exitCode = 0;
  let executionError;
  try {
    const [{ WASI }, moduleBytes] = await Promise.all([
      import("node:wasi"),
      readFile(modulePath),
    ]);
    const wasi = new WASI({
      args,
      env,
      preopens,
      returnOnExit: true,
      stdin: stdinHandle.fd,
      stdout: stdoutHandle.fd,
      stderr: stderrHandle.fd,
      version: "preview1",
    });
    const module = await WebAssembly.compile(moduleBytes);
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    exitCode = wasi.start(instance) ?? 0;
  } catch (error) {
    executionError = error;
  } finally {
    await Promise.all([
      stdinHandle.close(),
      stdoutHandle.close(),
      stderrHandle.close(),
    ]);
  }

  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath),
    readFile(stderrPath),
  ]);
  await rm(captureDirectory, { recursive: true, force: true });
  if (executionError) {
    const diagnostic = stderr
      .subarray(0, MAX_DIAGNOSTIC_BYTES)
      .toString("utf8")
      .trim();
    throw new Error(
      `WASI module ${modulePath} failed${diagnostic ? `: ${diagnostic}` : ""}`,
      { cause: executionError },
    );
  }
  return { exitCode, stdout, stderr };
}

export async function runNativeSplitPipeline(
  options,
  { runWasiModuleImpl = runWasiModule, execFileImpl = execFileAsync } = {},
) {
  if (typeof options.objectRootPath !== "string" || !path.isAbsolute(options.objectRootPath)) {
    throw new Error("object root path must be explicit and absolute");
  }
  const objectRootMetadata = await stat(options.objectRootPath).catch((error) => {
    throw new Error(`Cannot read object root at ${options.objectRootPath}`, { cause: error });
  });
  if (!objectRootMetadata.isDirectory()) {
    throw new Error(`object root is not a directory: ${options.objectRootPath}`);
  }
  const inputPaths = [
    ["link plan", options.linkPlanPath],
    ["raw WASI LLD", options.lldWasmPath],
    ["Binaryen wasm-opt", options.wasmOptPath],
    ["expected stdin", options.expectedStdinPath],
    ["expected stdout", options.expectedStdoutPath],
  ];
  for (const [label, inputPath] of inputPaths) {
    if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) {
      throw new Error(`${label} path must be explicit and absolute`);
    }
    const metadata = await stat(inputPath).catch((error) => {
      throw new Error(`Cannot read ${label} at ${inputPath}`, { cause: error });
    });
    if (!metadata.isFile())
      throw new Error(`${label} is not a file: ${inputPath}`);
  }
  for (const [label, outputPath] of [
    ["unoptimized Wasm", options.unoptimizedWasmPath],
    ["output Wasm", options.outputWasmPath],
  ]) {
    if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
      throw new Error(`${label} path must be explicit and absolute`);
    }
  }
  if (options.unoptimizedWasmPath === options.outputWasmPath) {
    throw new Error(
      "Unoptimized and optimized Wasm outputs must use different paths",
    );
  }

  const [linkPlanSource, expectedStdin, expectedStdout] = await Promise.all([
    readFile(options.linkPlanPath, "utf8"),
    readFile(options.expectedStdinPath),
    readFile(options.expectedStdoutPath),
  ]);
  let linkPlan;
  try {
    linkPlan = JSON.parse(linkPlanSource);
  } catch (error) {
    throw new Error(`Invalid link-plan.json at ${options.linkPlanPath}`, {
      cause: error,
    });
  }
  const linkArguments = materializeNativeLinkArguments(linkPlan, options);

  let totalObjectBytes = 0;
  for (const [index, object] of linkPlan.objects.entries()) {
    const objectPath = path.join(options.objectRootPath, ...object.path.split("/"));
    const metadata = await stat(objectPath).catch((error) => {
      throw new Error(`Cannot read object ${index} at ${objectPath}`, { cause: error });
    });
    if (!metadata.isFile() || metadata.size !== object.bytes) {
      throw new Error(`object ${index} size differs from link-plan.json`);
    }
    totalObjectBytes += object.bytes;
    if (totalObjectBytes > 256 * 1024 * 1024) {
      throw new Error("link-plan.json object set exceeds 256 MiB");
    }
    const bytes = await readFile(objectPath);
    if (createHash("sha256").update(bytes).digest("hex") !== object.sha256) {
      throw new Error(`object ${index} SHA-256 differs from link-plan.json`);
    }
    const expectedHeader = object.format === "llvm-bitcode" ? LLVM_BITCODE_HEADER : WASM_HEADER;
    if (
      bytes.length < expectedHeader.length ||
      !bytes.subarray(0, expectedHeader.length).equals(expectedHeader)
    ) {
      const format = object.format === "llvm-bitcode" ? "LLVM bitcode" : "WebAssembly";
      throw new Error(`object ${index} does not have an ${format} header: ${objectPath}`);
    }
  }

  for (const [label, wasmPath] of [["raw WASI LLD", options.lldWasmPath]]) {
    const bytes = await readFile(wasmPath);
    if (
      bytes.length < WASM_HEADER.length ||
      !bytes.subarray(0, WASM_HEADER.length).equals(WASM_HEADER)
    ) {
      throw new Error(
        `${label} does not have a WebAssembly header: ${wasmPath}`,
      );
    }
  }
  await Promise.all([
    mkdir(path.dirname(options.unoptimizedWasmPath), { recursive: true }),
    mkdir(path.dirname(options.outputWasmPath), { recursive: true }),
  ]);

  const linkResult = await runWasiModuleImpl({
    modulePath: options.lldWasmPath,
    args: ["wasm-ld", ...linkArguments],
    stdin: Buffer.alloc(0),
  });
  if (linkResult.exitCode !== 0) {
    const stderr = linkResult.stderr
      .subarray(0, MAX_DIAGNOSTIC_BYTES)
      .toString("utf8")
      .trim();
    throw new Error(
      `raw WASI LLD exited with code ${linkResult.exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  const unoptimizedBytes = await readFile(options.unoptimizedWasmPath).catch(
    (error) => {
      throw new Error("raw WASI LLD did not produce the requested output", {
        cause: error,
      });
    },
  );
  if (
    unoptimizedBytes.length < WASM_HEADER.length ||
    !unoptimizedBytes.subarray(0, WASM_HEADER.length).equals(WASM_HEADER)
  ) {
    throw new Error("raw WASI LLD output does not have a WebAssembly header");
  }

  try {
    await execFileImpl(
      options.wasmOptPath,
      [
        "--asyncify",
        "-O1",
        "-g",
        options.unoptimizedWasmPath,
        "--output",
        options.outputWasmPath,
      ],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(
      `Binaryen wasm-opt failed for ${options.unoptimizedWasmPath}`,
      {
        cause: error,
      },
    );
  }
  const outputBytes = await readFile(options.outputWasmPath).catch((error) => {
    throw new Error("Binaryen wasm-opt did not produce the requested output", {
      cause: error,
    });
  });
  if (
    outputBytes.length < WASM_HEADER.length ||
    !outputBytes.subarray(0, WASM_HEADER.length).equals(WASM_HEADER)
  ) {
    throw new Error(
      "Binaryen wasm-opt output does not have a WebAssembly header",
    );
  }

  const execution = await runWasiModuleImpl({
    modulePath: options.outputWasmPath,
    args: [options.outputWasmPath],
    stdin: expectedStdin,
  });
  if (execution.exitCode !== 0) {
    const stderr = execution.stderr
      .subarray(0, MAX_DIAGNOSTIC_BYTES)
      .toString("utf8")
      .trim();
    throw new Error(
      `Final Wasm exited with code ${execution.exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  if (!execution.stdout.equals(expectedStdout)) {
    const expected = expectedStdout
      .subarray(0, MAX_DIAGNOSTIC_BYTES)
      .toString("utf8");
    const actual = execution.stdout
      .subarray(0, MAX_DIAGNOSTIC_BYTES)
      .toString("utf8");
    throw new Error(
      `Final stdout mismatch\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }

  return {
    exitCode: execution.exitCode,
    stdout: execution.stdout.toString("utf8"),
    unoptimizedWasmPath: options.unoptimizedWasmPath,
    outputWasmPath: options.outputWasmPath,
  };
}

export async function runNativeSplitPipelineCli(argv = process.argv.slice(2)) {
  const options = parseNativeSplitPipelineArgs(argv);
  if (options.help) {
    console.log(NATIVE_SPLIT_PIPELINE_USAGE);
    return null;
  }
  const result = await runNativeSplitPipeline(options);
  process.stdout.write(result.stdout);
  console.error(
    `Verified native TinyGo split pipeline: ${result.outputWasmPath}`,
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  runNativeSplitPipelineCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
