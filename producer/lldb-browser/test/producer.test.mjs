import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  CONNECTION_SCHEME,
  EMSCRIPTEN_REVISION,
  LLVM_REVISION,
  LLVM_TAG,
  LLVM_VERSION,
  PTHREAD_WORKER_ASSET,
  PRODUCER_ROOT,
  REGISTERED_PLUGINS,
  TRANSPORT_CONTRACT,
  createArtifactManifest,
  createBuildReceipt,
  loadProducerMetadata,
  sha256,
  validateArtifactManifest,
  validateBuildReceipt,
  validateSharedRingEndpoint,
  verifyLockedInputs,
} from "../scripts/contracts.mjs";
import { EMSCRIPTEN_LINK_FLAGS, createBuildPlan } from "../scripts/build.mjs";
import { parsePackageArgs } from "../scripts/package.mjs";
import { createPreparePlan } from "../scripts/prepare.mjs";

const execFileAsync = promisify(execFile);

test("source lock pins LLVM 22.1.8 and every patch/overlay hash", async () => {
  const { manifest, sourcesLock } = await loadProducerMetadata();
  assert.equal(sourcesLock.llvm.version, LLVM_VERSION);
  assert.equal(sourcesLock.llvm.tag, LLVM_TAG);
  assert.equal(sourcesLock.llvm.commit, LLVM_REVISION);
  assert.equal(sourcesLock.emscripten.commit, EMSCRIPTEN_REVISION);
  assert.equal(manifest.protocols.connectionScheme, CONNECTION_SCHEME);
  assert.equal(manifest.protocols.transport, TRANSPORT_CONTRACT);
  await verifyLockedInputs(sourcesLock);

  const destinations = sourcesLock.overlays.map((entry) => entry.destination);
  assert.equal(new Set(destinations).size, destinations.length);
  assert.ok(
    destinations.includes(
      "lldb/source/Plugins/Process/gdb-remote/ConnectionMessagePort.cpp",
    ),
  );
  assert.ok(destinations.includes("lldb/tools/lldb-web-dap/lldb-web-dap.cpp"));
  assert.ok(
    destinations.includes("lldb/tools/lldb-web-dap/lldb-web-dap.pthread.mjs"),
  );
  for (const patch of sourcesLock.patches) {
    await execFileAsync("git", [
      "apply",
      "--numstat",
      path.join(PRODUCER_ROOT, patch.path),
    ]);
  }
});

test("plan modes describe a proxied pthread, static, minimal WebAssembly LLDB build", async () => {
  const { sourcesLock } = await loadProducerMetadata();
  const options = {
    workDir: "/tmp/wasm-llvm-lldb-plan",
    sourceDir: "",
    emsdkDir: "",
    outDir: "/tmp/wasm-llvm-lldb-out",
    skipEmsdkInstall: false,
  };
  const preparePlan = createPreparePlan(options, sourcesLock);
  const buildPlan = createBuildPlan(options);

  assert.equal(preparePlan.llvm.commit, LLVM_REVISION);
  assert.equal(preparePlan.networkRequired, true);
  assert.equal(buildPlan.target, "lldb-web-dap");
  assert.deepEqual(buildPlan.registeredPlugins, REGISTERED_PLUGINS);
  assert.ok(
    buildPlan.registeredPlugins.includes("lldbPluginDynamicLoaderWasmDYLD"),
  );
  assert.ok(buildPlan.registeredPlugins.includes("lldbPluginSymbolVendorWasm"));
  assert.ok(
    buildPlan.registeredPlugins.includes("lldbPluginScriptInterpreterNone"),
    "variable format matching requires the non-scripting interpreter fallback",
  );
  for (const flag of [
    "-pthread",
    "-sPTHREAD_POOL_SIZE=8",
    "-sPROXY_TO_PTHREAD=1",
    "-sWASM_BIGINT=1",
  ]) {
    assert.ok(buildPlan.executableLinkFlags.includes(flag));
  }
  assert.ok(buildPlan.executableLinkFlags.includes("-sASSERTIONS=1"));
  assert.ok(!buildPlan.executableLinkFlags.includes("-sMINIFY_WASM_IMPORTS=0"));
  const incomingModuleApi = buildPlan.executableLinkFlags.find((flag) =>
    flag.startsWith("-sINCOMING_MODULE_JS_API="),
  );
  assert.match(incomingModuleApi, /'stdout'/);
  assert.match(incomingModuleApi, /'stderr'/);
  assert.equal(
    buildPlan.outputs.worker,
    "/tmp/wasm-llvm-lldb-plan/web-build/bin/lldb-web-dap.pthread.mjs",
  );

  const webConfigure = buildPlan.commands[2].arguments.join("\n");
  for (const definition of [
    "-DLLDB_ENABLE_PYTHON=OFF",
    "-DLLDB_ENABLE_LUA=OFF",
    "-DLLDB_ENABLE_LIBEDIT=OFF",
    "-DLLDB_ENABLE_CURSES=OFF",
    "-DLLDB_ENABLE_PROTOCOL_SERVERS=OFF",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DLLVM_TARGETS_TO_BUILD=WebAssembly",
  ]) {
    assert.match(
      webConfigure,
      new RegExp(definition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  for (const plugin of REGISTERED_PLUGINS) {
    assert.match(webConfigure, new RegExp(plugin));
  }
});

test("ProcessGDBRemote patch selects ConnectionMessagePort only for the browser scheme", async () => {
  const [patch, header, implementation] = await Promise.all([
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "patches",
        "0001-process-gdb-remote-messageport.patch",
      ),
      "utf8",
    ),
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "overlays/lldb/source/Plugins/Process/gdb-remote/ConnectionMessagePort.h",
      ),
      "utf8",
    ),
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "overlays/lldb/source/Plugins/Process/gdb-remote/ConnectionMessagePort.cpp",
      ),
      "utf8",
    ),
  ]);
  assert.match(patch, /ConnectionMessagePort::Supports\(connect_url\)/);
  assert.match(patch, /std::make_unique<ConnectionFileDescriptor>\(\)/);
  assert.match(
    patch,
    /add_lldb_library\(lldbPluginProcessGDBRemote PLUGIN[\s\S]*\+\s+ConnectionMessagePort\.cpp/,
  );
  assert.doesNotMatch(
    patch,
    /^\+.*target_sources\(lldbPluginProcessGDBRemote/m,
  );
  assert.match(header, /class ConnectionMessagePort final : public Connection/);
  assert.match(header, /wasm-messageport:\/\//);
  for (const operation of ["open", "read", "write", "interrupt", "close"]) {
    assert.match(
      implementation,
      new RegExp(`wasm_lldb_shared_ring_${operation}`),
    );
  }
});

test("browser host patch rejects native process launching without changing native hosts", async () => {
  const patch = await fs.readFile(
    path.join(
      PRODUCER_ROOT,
      "patches",
      "0005-browser-host-no-process-launch.patch",
    ),
    "utf8",
  );
  assert.match(patch, /if\(EMSCRIPTEN\)/);
  assert.match(
    patch,
    /list\(REMOVE_ITEM HOST_SOURCES[\s\S]*ProcessLauncherPosixFork\.cpp/,
  );
  assert.match(patch, /#elif !defined\(__EMSCRIPTEN__\)/);
  assert.match(
    patch,
    /launching native processes is unavailable in the browser/,
  );
  assert.doesNotMatch(patch, /^-.*ProcessLauncherWindows/m);
});

test("ProcessWasm reads its single-module library list without libxml2", async () => {
  const patch = await fs.readFile(
    path.join(
      PRODUCER_ROOT,
      "patches",
      "0006-process-wasm-library-list.patch",
    ),
    "utf8",
  );
  assert.match(
    patch,
    /ProcessWasm::GetLoadedModuleList\(\)[\s\S]*ReadExtFeature\("libraries", ""\)/,
  );
  assert.match(patch, /xml\.find\("<library "\)/);
  assert.match(patch, /xml\.find\("<section "/);
  assert.match(patch, /module\.set_base_is_offset\(false\)/);
  assert.doesNotMatch(patch, /XMLDocument/);
});

test("Wasm unwind patch gives recursive frames distinct synthetic CFAs", async () => {
  const { sourcesLock } = await loadProducerMetadata();
  const patchPath = "patches/0007-wasm-recursive-frame-cfa.patch";
  assert.ok(
    sourcesLock.patches.some((entry) => entry.path === patchPath),
    `${patchPath} must be pinned by sources.lock.json`,
  );

  const patch = await fs.readFile(path.join(PRODUCER_ROOT, patchPath), "utf8");
  assert.match(
    patch,
    /UnwindWasm::DoGetFrameInfoAtIndex[\s\S]*\+\s+const uint64_t call_depth = m_frames\.size\(\) - frame_idx;[\s\S]*\+\s+cfa = 0xffffffffULL - call_depth;/,
  );
  assert.match(patch, /Wasm frame identity stable as callees are pushed/i);
  assert.match(
    patch,
    /diff --git a\/lldb\/test\/API\/functionalities\/gdb_remote_client\/TestWasm\.py/,
  );
  assert.match(patch, /test_recursive_wasm_frames_use_distinct_cfas/);
  assert.match(patch, /self\.assertLess\(frame0\.GetCFA\(\), frame1\.GetCFA\(\)\)/);
  assert.match(patch, /self\.assertEqual\(frame1\.GetCFA\(\), 0xFFFFFFFE\)/);
  assert.match(patch, /qWasmLocal:1;2/);
});

test("browser plugin lookup avoids std::function callback dispatch", async () => {
  const { sourcesLock } = await loadProducerMetadata();
  const patchPath = "patches/0008-plugin-predicate-template.patch";
  assert.ok(
    sourcesLock.patches.some((entry) => entry.path === patchPath),
    `${patchPath} must be pinned by sources.lock.json`,
  );

  const patch = await fs.readFile(path.join(PRODUCER_ROOT, patchPath), "utf8");
  assert.match(
    patch,
    /diff --git a\/lldb\/source\/Core\/PluginManager\.cpp b\/lldb\/source\/Core\/PluginManager\.cpp/,
  );
  assert.match(patch, /template <typename Predicate>/);
  assert.match(
    patch,
    /FindEnabledInstance\(Predicate &&predicate\) const/,
  );
  assert.match(patch, /^\s+if \(predicate\(instance\)\)/m);
  assert.match(
    patch,
    /^-.*FindEnabledInstance\(std::function<bool\(const Instance &\)>\s+predicate\) const/m,
  );
});

test("patched LLDB browser artifacts use a new product version", () => {
  assert.equal(
    parsePackageArgs([]).version,
    `llvmorg-${LLVM_VERSION}-lldb-web-4`,
  );
});

test("browser DAP entry point selects the DAP logger unambiguously", async () => {
  const source = await fs.readFile(
    path.join(
      PRODUCER_ROOT,
      "overlays/lldb/tools/lldb-web-dap/lldb-web-dap.cpp",
    ),
    "utf8",
  );
  assert.match(source, /lldb_dap::Log::Mutex log_mutex/);
  assert.match(source, /lldb_dap::Log log\(llvm::nulls\(\), log_mutex\)/);
  assert.doesNotMatch(source, /^\s+Log(?::| )/m);
  assert.match(source, /#include "Handler\/RequestHandler\.h"/);
  assert.match(source, /#include "Handler\/ResponseHandler\.h"/);
  assert.match(source, /class BrowserPlatform final : public Platform/);
  assert.match(source, /Platform\(\/\*is_host_platform=\*\/true\)/);
  assert.match(source, /ArchSpec\("wasm32-unknown-unknown-wasm"\)/);
  assert.match(
    source,
    /Platform::SetHostPlatform\(std::make_shared<BrowserPlatform>\(\)\)/,
  );
  assert.match(source, /uint32_t\s+FindProcesses\(/);
  assert.match(source, /bool\s+GetProcessInfo\(/);
  assert.match(source, /Status ShellExpandArguments\(/);
});

test("browser DAP links the WebAssembly target and supplies browser HostInfo definitions", async () => {
  const [cmake, hostPatch, host, hostInfo] = await Promise.all([
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "overlays/lldb/tools/lldb-web-dap/CMakeLists.txt",
      ),
      "utf8",
    ),
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "patches",
        "0005-browser-host-no-process-launch.patch",
      ),
      "utf8",
    ),
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "overlays/lldb/source/Host/emscripten/HostEmscripten.cpp",
      ),
      "utf8",
    ),
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "overlays/lldb/source/Host/emscripten/HostInfoEmscripten.cpp",
      ),
      "utf8",
    ),
  ]);
  assert.match(cmake, /LINK_COMPONENTS\s+WebAssembly/);
  assert.match(
    hostPatch,
    /list\(APPEND HOST_SOURCES[\s\S]*emscripten\/HostEmscripten\.cpp/,
  );
  assert.match(hostPatch, /emscripten\/HostInfoEmscripten\.cpp/);
  for (const operation of [
    "Host::FindProcessesImpl",
    "Host::GetProcessInfo",
    "Host::ShellExpandArguments",
  ]) {
    assert.match(host, new RegExp(operation.replaceAll("::", "\\:\\:")));
  }
  for (const operation of [
    "HostInfoLinux::Initialize",
    "HostInfoLinux::Terminate",
    "HostInfoLinux::GetProgramFileSpec",
    "HostInfoLinux::ComputeHostArchitectureSupport",
  ]) {
    assert.match(hostInfo, new RegExp(operation.replaceAll("::", "\\:\\:")));
  }
  assert.match(hostInfo, /arch_32\.SetTriple\("wasm32-unknown-unknown-wasm"\)/);
  assert.match(hostInfo, /arch_64\.Clear\(\)/);
});

test("shared-ring-v1 endpoint rejects invalid buffers and accepts a valid pair", () => {
  const createRing = (capacity) => {
    const control = new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT);
    const data = new SharedArrayBuffer(capacity);
    Atomics.store(new Int32Array(control), 4, capacity);
    return { control, data };
  };
  const endpoint = {
    connectionId: 7,
    rx: createRing(4096),
    tx: createRing(8192),
  };
  assert.doesNotThrow(() => validateSharedRingEndpoint(endpoint));
  assert.throws(
    () => validateSharedRingEndpoint({ ...endpoint, connectionId: 0 }),
    /positive connectionId/,
  );
  assert.throws(
    () =>
      validateSharedRingEndpoint({
        ...endpoint,
        rx: createRing(5000),
      }),
    /invalid capacity/,
  );
});

test("receipt and debug manifest bind assets to locked provenance", () => {
  const jsBytes = new TextEncoder().encode(
    "createLldbWebDapModule shared-ring-v1",
  );
  const wasmBytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const workerBytes = new TextEncoder().encode("pthread worker");
  const manifestSha256 = sha256("manifest");
  const sourcesLockSha256 = sha256("lock");
  const receipt = createBuildReceipt({
    version: "test",
    manifestSha256,
    sourcesLockSha256,
    jsBytes,
    wasmBytes,
    workerBytes,
    patchesSha256: sha256("patches"),
    buildFlags: EMSCRIPTEN_LINK_FLAGS,
  });
  const artifactManifest = createArtifactManifest({
    version: "test",
    jsSha256: receipt.assets["lldb-web-dap.js"].sha256,
    wasmSha256: receipt.assets["lldb-web-dap.wasm"].sha256,
    workerSha256: receipt.assets[PTHREAD_WORKER_ASSET].sha256,
    patchesSha256: receipt.source.patchesSha256,
    capabilities: { breakpoints: true, evaluateExpressions: false },
  });

  assert.doesNotThrow(() => validateBuildReceipt(receipt));
  assert.doesNotThrow(() => validateArtifactManifest(artifactManifest));
  assert.equal(artifactManifest.debugger.lldb.llvmRevision, LLVM_REVISION);
  assert.equal(artifactManifest.debugger.lldb.wasmCompression, "none");
  assert.equal(
    artifactManifest.debugger.lldb.sha256,
    artifactManifest.debugger.lldb.wasmSha256,
  );
  assert.equal(
    artifactManifest.debugger.transport.contract,
    TRANSPORT_CONTRACT,
  );
  assert.equal(receipt.build.proxyToPthread, true);
  assert.equal(receipt.build.pthreadWorker, PTHREAD_WORKER_ASSET);
  assert.equal(artifactManifest.debugger.lldb.worker, PTHREAD_WORKER_ASSET);

  const oversizedReceipt = structuredClone(receipt);
  oversizedReceipt.assets["lldb-web-dap.wasm"].size = 48 * 1024 * 1024 + 1;
  assert.throws(
    () => validateBuildReceipt(oversizedReceipt),
    /48 MiB uncompressed size budget/,
  );
});

test("Emscripten shared-ring library is syntactically valid and exposes all imports", async () => {
  const [source, cmake] = await Promise.all([
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "overlays/lldb/tools/lldb-web-dap/library_lldb_shared_ring.js",
      ),
      "utf8",
    ),
    fs.readFile(
      path.join(
        PRODUCER_ROOT,
        "overlays/lldb/tools/lldb-web-dap/CMakeLists.txt",
      ),
      "utf8",
    ),
  ]);
  assert.doesNotThrow(() => new Function(source));
  for (const operation of ["open", "read", "write", "interrupt", "close"]) {
    assert.match(
      source,
      new RegExp(`wasm_lldb_shared_ring_${operation}: function`),
    );
  }
  assert.doesNotMatch(source, /__proxy/);
  assert.match(source, /installPthreadBootstrap/);
  assert.match(source, /Atomics\.wait/);
  assert.match(source, /connectionId/);
  assert.match(cmake, /lldb-web-dap-pthread-worker/);
  assert.match(cmake, /lldb-web-dap\.pthread\.mjs/);
  for (const flag of EMSCRIPTEN_LINK_FLAGS) {
    assert.match(
      cmake,
      new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("pthread sidecar installs the cloned registry before importing the generated module", async () => {
  const sidecarPath = path.join(
    PRODUCER_ROOT,
    "overlays/lldb/tools/lldb-web-dap/lldb-web-dap.pthread.mjs",
  );
  const source = await fs.readFile(sidecarPath, "utf8");
  await execFileAsync(process.execPath, ["--check", sidecarPath]);
  assert.match(source, /wasm-lldb-shared-ring-v1-bootstrap/);
  assert.ok(
    source.indexOf("globalThis.wasmLldbSharedRingV1 = registry") <
      source.indexOf("import('./lldb-web-dap.js')"),
  );
  assert.match(source, /pendingMessages/);
});

test("shared-ring library bootstraps existing and dynamically allocated pthread workers", async () => {
  const source = await fs.readFile(
    path.join(
      PRODUCER_ROOT,
      "overlays/lldb/tools/lldb-web-dap/library_lldb_shared_ring.js",
    ),
    "utf8",
  );
  const messages = [];
  const existingWorker = {
    postMessage(message) {
      messages.push({ worker: "existing", message });
    },
  };
  const dynamicWorker = {
    postMessage(message) {
      messages.push({ worker: "dynamic", message });
    },
  };
  const registry = { protocol: "shared-ring-v1", sessions: {} };
  const pthread = {
    unusedWorkers: [existingWorker],
    allocateUnusedWorker() {
      return dynamicWorker;
    },
  };
  const loadLibrary = new Function(
    "Module",
    "PThread",
    "ENVIRONMENT_IS_PTHREAD",
    "LibraryManager",
    "mergeInto",
    `${source}
var WasmLldbSharedRingV1 =
  LibraryWasmLldbSharedRingV1.$WasmLldbSharedRingV1;
WasmLldbSharedRingV1.installPthreadBootstrap();
return WasmLldbSharedRingV1;`,
  );
  const helper = loadLibrary(
    {
      mainScriptUrlOrBlob: "/assets/lldb-web-dap.pthread.mjs",
      wasmLldbSharedRingV1: registry,
    },
    pthread,
    false,
    { library: {} },
    Object.assign,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].worker, "existing");
  assert.equal(messages[0].message.registry, registry);
  assert.equal(messages[0].message.type, helper.PTHREAD_BOOTSTRAP_TYPE);

  assert.equal(pthread.allocateUnusedWorker(), dynamicWorker);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].worker, "dynamic");
  assert.equal(messages[1].message.registry, registry);
});

test("shared-ring read preserves pending-byte precedence over interrupt", async () => {
  const source = await fs.readFile(
    path.join(
      PRODUCER_ROOT,
      "overlays/lldb/tools/lldb-web-dap/library_lldb_shared_ring.js",
    ),
    "utf8",
  );
  const heap = new Uint8Array(64);
  const registry = {
    protocol: "shared-ring-v1",
    sessions: {},
  };
  const loadLibrary = new Function(
    "Module",
    "HEAPU8",
    "UTF8ToString",
    "LibraryManager",
    "mergeInto",
    `${source}
var WasmLldbSharedRingV1 =
  LibraryWasmLldbSharedRingV1.$WasmLldbSharedRingV1;
return {
  helper: WasmLldbSharedRingV1,
  library: LibraryManager.library
};`,
  );
  const libraryManager = { library: {} };
  const { helper, library } = loadLibrary(
    { wasmLldbSharedRingV1: registry },
    heap,
    () => "session",
    libraryManager,
    Object.assign,
  );
  const createRing = () => {
    const control = new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT);
    const data = new SharedArrayBuffer(4096);
    Atomics.store(new Int32Array(control), helper.CAPACITY, 4096);
    return { control, data };
  };
  const endpoint = {
    connectionId: 19,
    rx: createRing(),
    tx: createRing(),
  };
  registry.sessions.session = { dap: endpoint, rsp: endpoint };
  assert.equal(
    library.wasm_lldb_shared_ring_open(0, 7, helper.CHANNEL_RSP),
    19,
  );

  const rxControl = new Int32Array(endpoint.rx.control);
  new Uint8Array(endpoint.rx.data)[0] = 0x41;
  Atomics.store(rxControl, helper.WRITE, 1);
  Atomics.add(rxControl, helper.INTERRUPT, 1);
  Atomics.add(rxControl, helper.EPOCH, 1);

  assert.equal(library.wasm_lldb_shared_ring_read(19, 4, 1, 0), 1);
  assert.equal(heap[4], 0x41);
  assert.equal(
    library.wasm_lldb_shared_ring_read(19, 4, 1, 0),
    helper.RESULT_INTERRUPTED,
  );
});
