import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PRODUCER_ROOT = path.resolve(SCRIPT_DIR, "..");
export const REPO_ROOT = path.resolve(PRODUCER_ROOT, "..", "..");

export const LLVM_VERSION = "22.1.8";
export const LLVM_TAG = "llvmorg-22.1.8";
export const LLVM_REVISION = "ca7933e47d3a3451d81e72ac174dcb5aa28b59d1";
export const EMSCRIPTEN_VERSION = "6.0.0";
export const EMSCRIPTEN_REVISION = "d223ae73c6998296e3ab27cf81dc2c2c9fd383de";
export const TRANSPORT_CONTRACT = "shared-ring-v1";
export const CONNECTION_SCHEME = "wasm-messageport";
export const PTHREAD_WORKER_ASSET = "lldb-web-dap.pthread.mjs";
export const LLDB_WASM_SIZE_BUDGET_BYTES = 48 * 1024 * 1024;
export const LLDB_WASM_GZIP_SIZE_BUDGET_BYTES = 18 * 1024 * 1024;
export const REQUIRED_ASSETS = [
  "lldb-web-dap.js",
  "lldb-web-dap.wasm",
  PTHREAD_WORKER_ASSET,
];
export const REGISTERED_PLUGINS = [
  "lldbPluginProcessWasm",
  "lldbPluginProcessGDBRemote",
  "lldbPluginDynamicLoaderWasmDYLD",
  "lldbPluginObjectFileWasm",
  "lldbPluginSymbolVendorWasm",
  "lldbPluginSymbolFileDWARF",
  "lldbPluginTypeSystemClang",
  "lldbPluginCPlusPlusLanguage",
  "lldbPluginScriptInterpreterNone",
];
export const EXCLUDED_FEATURES = [
  "python",
  "lua",
  "libedit",
  "curses",
  "interactive-lldb-cli",
  "dynamic-plugin-loader",
  "native-platform-launchers",
  "protocol-servers",
  "tests",
  "examples",
  "arbitrary-expression-evaluation",
];

const sha256Pattern = /^[0-9a-f]{64}$/;

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

export function resolveProducerPath(relativePath, label = "producer path") {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path`);
  }
  const resolved = path.resolve(PRODUCER_ROOT, relativePath);
  const relative = path.relative(PRODUCER_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes producer/lldb-browser: ${relativePath}`);
  }
  return resolved;
}

export async function loadProducerMetadata() {
  const [manifest, sourcesLock] = await Promise.all([
    readJson(path.join(PRODUCER_ROOT, "manifest.json")),
    readJson(path.join(PRODUCER_ROOT, "sources.lock.json")),
  ]);
  validateProducerManifest(manifest);
  validateSourcesLock(sourcesLock);
  return { manifest, sourcesLock };
}

export function validateProducerManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error("manifest.json must use schemaVersion 1");
  }
  if (manifest.producerId !== "wasm-llvm/lldb-browser") {
    throw new Error("manifest.json has an unexpected producerId");
  }
  if (manifest.protocols?.transport !== TRANSPORT_CONTRACT) {
    throw new Error(`manifest transport must be ${TRANSPORT_CONTRACT}`);
  }
  if (manifest.protocols?.connectionScheme !== CONNECTION_SCHEME) {
    throw new Error(`manifest connection scheme must be ${CONNECTION_SCHEME}`);
  }
  if (!manifest.build?.pthreads || manifest.build?.proxyToPthread !== true) {
    throw new Error(
      "LLDB browser builds require pthreads with PROXY_TO_PTHREAD",
    );
  }
  if (manifest.build?.pthreadWorker !== PTHREAD_WORKER_ASSET) {
    throw new Error(`manifest pthread worker must be ${PTHREAD_WORKER_ASSET}`);
  }
  if (
    JSON.stringify(manifest.build.registeredPlugins) !==
    JSON.stringify(REGISTERED_PLUGINS)
  ) {
    throw new Error(
      "manifest registered plugin list differs from the producer contract",
    );
  }
  for (const feature of EXCLUDED_FEATURES) {
    if (!manifest.build.excludedFeatures?.includes(feature)) {
      throw new Error(`manifest does not exclude ${feature}`);
    }
  }
  for (const asset of REQUIRED_ASSETS) {
    if (!manifest.outputs?.includes(asset)) {
      throw new Error(`manifest does not declare ${asset}`);
    }
  }
}

export function validateSourcesLock(sourcesLock) {
  if (!sourcesLock || sourcesLock.schemaVersion !== 1) {
    throw new Error("sources.lock.json must use schemaVersion 1");
  }
  if (
    sourcesLock.llvm?.version !== LLVM_VERSION ||
    sourcesLock.llvm?.tag !== LLVM_TAG ||
    sourcesLock.llvm?.commit !== LLVM_REVISION
  ) {
    throw new Error(
      "sources.lock.json does not pin the required LLVM 22.1.8 revision",
    );
  }
  if (
    sourcesLock.emscripten?.version !== EMSCRIPTEN_VERSION ||
    sourcesLock.emscripten?.commit !== EMSCRIPTEN_REVISION
  ) {
    throw new Error(
      "sources.lock.json does not pin the required Emscripten revision",
    );
  }
  if (!Array.isArray(sourcesLock.patches) || sourcesLock.patches.length === 0) {
    throw new Error("sources.lock.json has no patches");
  }
  if (
    !Array.isArray(sourcesLock.overlays) ||
    sourcesLock.overlays.length === 0
  ) {
    throw new Error("sources.lock.json has no overlays");
  }

  const destinations = new Set();
  for (const patch of sourcesLock.patches) {
    resolveProducerPath(patch.path, "patch path");
    assertSha256(patch.sha256, `patch ${patch.path}`);
  }
  for (const overlay of sourcesLock.overlays) {
    resolveProducerPath(overlay.source, "overlay source");
    if (
      typeof overlay.destination !== "string" ||
      path.isAbsolute(overlay.destination) ||
      overlay.destination.split("/").includes("..")
    ) {
      throw new Error(`invalid overlay destination: ${overlay.destination}`);
    }
    if (destinations.has(overlay.destination)) {
      throw new Error(`duplicate overlay destination: ${overlay.destination}`);
    }
    destinations.add(overlay.destination);
    assertSha256(overlay.sha256, `overlay ${overlay.source}`);
  }
}

export async function verifyLockedInputs(sourcesLock) {
  const entries = [
    ...sourcesLock.patches.map((entry) => ({ ...entry, source: entry.path })),
    ...sourcesLock.overlays,
  ];
  for (const entry of entries) {
    const filePath = resolveProducerPath(entry.source);
    const actual = sha256(await fs.readFile(filePath));
    if (actual !== entry.sha256) {
      throw new Error(
        `locked input hash mismatch for ${entry.source}: expected ${entry.sha256}, got ${actual}`,
      );
    }
  }
}

export function getLockedPthreadWorkerSha256(sourcesLock) {
  const entry = sourcesLock.overlays.find(
    (overlay) =>
      overlay.destination === `lldb/tools/lldb-web-dap/${PTHREAD_WORKER_ASSET}`,
  );
  if (!entry) {
    throw new Error(
      "sources.lock.json does not lock the pthread worker sidecar",
    );
  }
  return entry.sha256;
}

export function createArtifactManifest({
  version,
  jsSha256,
  wasmSha256,
  workerSha256,
  patchesSha256,
  capabilities,
}) {
  assertSha256(jsSha256, "lldb-web-dap.js hash");
  assertSha256(wasmSha256, "lldb-web-dap.wasm hash");
  assertSha256(workerSha256, `${PTHREAD_WORKER_ASSET} hash`);
  assertSha256(patchesSha256, "LLDB patch set hash");
  return {
    manifestVersion: 1,
    version,
    debugger: {
      protocolVersion: 1,
      lldb: {
        js: "lldb-web-dap.js",
        wasm: "lldb-web-dap.wasm",
        worker: PTHREAD_WORKER_ASSET,
        sha256: wasmSha256,
        jsSha256,
        wasmSha256,
        workerSha256,
        wasmCompression: "none",
        llvmVersion: LLVM_VERSION,
        llvmRevision: LLVM_REVISION,
        patchesSha256,
      },
      transport: {
        scheme: CONNECTION_SCHEME,
        contract: TRANSPORT_CONTRACT,
        requiresSharedArrayBuffer: true,
      },
      capabilities: { ...capabilities },
    },
  };
}

export function createBuildReceipt({
  version,
  manifestSha256,
  sourcesLockSha256,
  jsBytes,
  wasmBytes,
  workerBytes,
  patchesSha256,
  buildFlags,
}) {
  assertSha256(manifestSha256, "producer manifest hash");
  assertSha256(sourcesLockSha256, "sources lock hash");
  assertSha256(patchesSha256, "LLDB patch set hash");
  const compressedWasm = gzipSync(wasmBytes, { level: 9, mtime: 0 });
  return {
    schemaVersion: 1,
    producer: {
      id: "wasm-llvm/lldb-browser",
      manifestSha256,
      sourcesLockSha256,
    },
    source: {
      llvmVersion: LLVM_VERSION,
      llvmTag: LLVM_TAG,
      llvmRevision: LLVM_REVISION,
      patchesSha256,
    },
    toolchain: {
      emscriptenVersion: EMSCRIPTEN_VERSION,
      emscriptenRevision: EMSCRIPTEN_REVISION,
    },
    build: {
      target: "wasm32-unknown-emscripten",
      pthreads: true,
      proxyToPthread: true,
      pthreadWorker: PTHREAD_WORKER_ASSET,
      registeredPlugins: [...REGISTERED_PLUGINS],
      excludedFeatures: [...EXCLUDED_FEATURES],
      flags: [...buildFlags],
    },
    version,
    assets: {
      "lldb-web-dap.js": {
        size: jsBytes.byteLength,
        sha256: sha256(jsBytes),
      },
      "lldb-web-dap.wasm": {
        size: wasmBytes.byteLength,
        sha256: sha256(wasmBytes),
        compressed: {
          format: "gzip",
          level: 9,
          size: compressedWasm.byteLength,
          sha256: sha256(compressedWasm),
        },
      },
      [PTHREAD_WORKER_ASSET]: {
        size: workerBytes.byteLength,
        sha256: sha256(workerBytes),
      },
    },
  };
}

export function validateArtifactManifest(artifactManifest) {
  if (!artifactManifest || artifactManifest.manifestVersion !== 1) {
    throw new Error("debug-manifest.json must use manifestVersion 1");
  }
  const lldb = artifactManifest.debugger?.lldb;
  if (
    lldb?.llvmVersion !== LLVM_VERSION ||
    lldb?.llvmRevision !== LLVM_REVISION ||
    lldb?.js !== "lldb-web-dap.js" ||
    lldb?.wasm !== "lldb-web-dap.wasm" ||
    lldb?.worker !== PTHREAD_WORKER_ASSET
  ) {
    throw new Error(
      "debug-manifest.json has invalid LLDB provenance or asset paths",
    );
  }
  assertSha256(lldb.jsSha256, "debug manifest JS hash");
  assertSha256(lldb.wasmSha256, "debug manifest Wasm hash");
  assertSha256(lldb.workerSha256, "debug manifest pthread worker hash");
  assertSha256(lldb.patchesSha256, "debug manifest patch set hash");
  if (lldb.sha256 !== lldb.wasmSha256 || lldb.wasmCompression !== "none") {
    throw new Error(
      "debug-manifest.json must expose an uncompressed Wasm hash",
    );
  }
  if (
    artifactManifest.debugger?.transport?.scheme !== CONNECTION_SCHEME ||
    artifactManifest.debugger?.transport?.contract !== TRANSPORT_CONTRACT ||
    artifactManifest.debugger?.transport?.requiresSharedArrayBuffer !== true
  ) {
    throw new Error("debug-manifest.json has an invalid transport contract");
  }
}

export function validateBuildReceipt(receipt) {
  if (!receipt || receipt.schemaVersion !== 1) {
    throw new Error("lldb-browser.receipt.json must use schemaVersion 1");
  }
  if (
    receipt.producer?.id !== "wasm-llvm/lldb-browser" ||
    receipt.source?.llvmVersion !== LLVM_VERSION ||
    receipt.source?.llvmTag !== LLVM_TAG ||
    receipt.source?.llvmRevision !== LLVM_REVISION ||
    receipt.toolchain?.emscriptenVersion !== EMSCRIPTEN_VERSION ||
    receipt.toolchain?.emscriptenRevision !== EMSCRIPTEN_REVISION
  ) {
    throw new Error(
      "LLDB browser receipt provenance does not match the source lock",
    );
  }
  assertSha256(receipt.producer.manifestSha256, "receipt manifest hash");
  assertSha256(receipt.producer.sourcesLockSha256, "receipt source lock hash");
  assertSha256(receipt.source.patchesSha256, "receipt patch set hash");
  if (!receipt.build?.pthreads || receipt.build?.proxyToPthread !== true) {
    throw new Error(
      "receipt does not prove the PROXY_TO_PTHREAD build setting",
    );
  }
  if (receipt.build?.pthreadWorker !== PTHREAD_WORKER_ASSET) {
    throw new Error("receipt does not identify the locked pthread worker");
  }
  if (
    JSON.stringify(receipt.build.registeredPlugins) !==
    JSON.stringify(REGISTERED_PLUGINS)
  ) {
    throw new Error(
      "receipt registered plugin list differs from the producer contract",
    );
  }
  for (const asset of REQUIRED_ASSETS) {
    const metadata = receipt.assets?.[asset];
    if (
      !metadata ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size <= 0
    ) {
      throw new Error(`receipt has invalid size for ${asset}`);
    }
    assertSha256(metadata.sha256, `receipt ${asset} hash`);
  }
  if (
    receipt.assets["lldb-web-dap.wasm"].size >
    LLDB_WASM_SIZE_BUDGET_BYTES
  ) {
    throw new Error(
      "lldb-web-dap.wasm exceeds its 48 MiB uncompressed size budget",
    );
  }
  const compressed = receipt.assets["lldb-web-dap.wasm"].compressed;
  if (
    compressed?.format !== "gzip" ||
    compressed?.level !== 9 ||
    !Number.isSafeInteger(compressed?.size) ||
    compressed.size <= 0
  ) {
    throw new Error(
      "lldb-web-dap.wasm receipt has invalid deterministic gzip metadata",
    );
  }
  assertSha256(compressed.sha256, "receipt compressed Wasm hash");
  if (compressed.size > LLDB_WASM_GZIP_SIZE_BUDGET_BYTES) {
    throw new Error(
      "lldb-web-dap.wasm exceeds its 18 MiB gzip size budget",
    );
  }
}

export function assertWasmHeader(bytes, label = "WebAssembly artifact") {
  if (
    bytes.byteLength < 8 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    throw new Error(`${label} is not a WebAssembly module`);
  }
}

export async function assertBrowserTransportArtifact(
  jsBytes,
  wasmBytes,
  workerBytes,
) {
  const jsSource =
    typeof jsBytes === "string" ? jsBytes : new TextDecoder().decode(jsBytes);
  for (const token of [
    "createLldbWebDapModule",
    "shared-ring-v1",
    "wasmLldbSharedRingV1",
    "SharedArrayBuffer",
    "Atomics.wait",
    "var entryFunction=__emscripten_proxy_main",
  ]) {
    if (!jsSource.includes(token)) {
      throw new Error(
        `lldb-web-dap.js is missing browser transport token: ${token}`,
      );
    }
  }

  const workerSource =
    typeof workerBytes === "string"
      ? workerBytes
      : new TextDecoder().decode(workerBytes);
  for (const token of [
    "wasm-lldb-shared-ring-v1-bootstrap",
    "globalThis.wasmLldbSharedRingV1",
    "import('./lldb-web-dap.js')",
  ]) {
    if (!workerSource.includes(token)) {
      throw new Error(
        `${PTHREAD_WORKER_ASSET} is missing bootstrap token: ${token}`,
      );
    }
  }

  assertWasmHeader(wasmBytes, "lldb-web-dap.wasm");
  const module = await WebAssembly.compile(wasmBytes);
  const importNames = new Set(
    WebAssembly.Module.imports(module)
      .filter((entry) => entry.kind === "function")
      .map((entry) => entry.name),
  );
  for (const importName of [
    "wasm_lldb_shared_ring_open",
    "wasm_lldb_shared_ring_read",
    "wasm_lldb_shared_ring_write",
    "wasm_lldb_shared_ring_interrupt",
    "wasm_lldb_shared_ring_close",
  ]) {
    if (!importNames.has(importName)) {
      throw new Error(
        `lldb-web-dap.wasm is missing transport import: ${importName}`,
      );
    }
  }
}

export function validateSharedRingEndpoint(endpoint) {
  if (
    !endpoint ||
    !Number.isSafeInteger(endpoint.connectionId) ||
    endpoint.connectionId <= 0
  ) {
    throw new Error("shared-ring-v1 endpoint requires a positive connectionId");
  }
  for (const direction of ["rx", "tx"]) {
    const ring = endpoint[direction];
    if (
      !ring ||
      typeof SharedArrayBuffer === "undefined" ||
      !(ring.control instanceof SharedArrayBuffer) ||
      !(ring.data instanceof SharedArrayBuffer)
    ) {
      throw new Error(
        `shared-ring-v1 ${direction} buffers must be SharedArrayBuffer`,
      );
    }
    const control = new Int32Array(ring.control);
    if (control.length < 6) {
      throw new Error(
        `shared-ring-v1 ${direction} control buffer is too small`,
      );
    }
    const capacity = Atomics.load(control, 4) >>> 0;
    if (
      capacity !== ring.data.byteLength ||
      capacity < 4096 ||
      capacity > 16 * 1024 * 1024 ||
      (capacity & (capacity - 1)) !== 0
    ) {
      throw new Error(`shared-ring-v1 ${direction} has an invalid capacity`);
    }
  }
}
