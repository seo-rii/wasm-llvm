# LLDB browser producer

This producer builds the browser-only LLDB debug adapter used by `wasm-llvm`.
It does not launch a WebAssembly program itself. The resulting worker controls
a separate interpreter/runtime GDB stub through LLDB's `ProcessWasm` plugin.

The source baseline is intentionally fixed to LLVM 22.1.8:

```text
tag:    llvmorg-22.1.8
commit: ca7933e47d3a3451d81e72ac174dcb5aa28b59d1
```

`sources.lock.json` is the machine-readable source/overlay lock. `manifest.json`
describes the build and artifact contracts. A packaged build contains:

```text
lldb-web-dap.js
lldb-web-dap.wasm          # uncompressed; runtime fetches these exact bytes
lldb-web-dap.pthread.mjs   # registry bootstrap for LLDB-created pthreads
debug-manifest.json
lldb-browser.receipt.json
```

## Architecture

The worker keeps DAP and target traffic separate:

```text
wasm-idle UI
  ↕ DAP (shared-ring-v1 channel "dap")
lldb-web-dap
  ↕ GDB RSP (wasm-messageport://SESSION, shared-ring-v1 channel "rsp")
WAMR target worker
```

`ConnectionMessagePort` implements `lldb_private::Connection`. The small
`0001-process-gdb-remote-messageport.patch` changes only the connection factory
inside `ProcessGDBRemote::ConnectToDebugserver()` (plus its CMake source list):
`wasm-messageport://` selects the browser connection while every existing URL
continues to use `ConnectionFileDescriptor`.

The shared-memory wire contract is documented in
`contracts/shared-ring-v1.md`. It is a byte stream, not a packet transport:
RSP framing, escaping, partial reads/writes, ACK mode, and interrupt bytes stay
inside the existing LLDB/WAMR protocol implementations. DAP uses its standard
`Content-Length` framing over a different ring pair.

## Build scope

The product link is static and starts from these LLDB plugins:

- `ProcessWasm`
- `ProcessGDBRemote`
- `DynamicLoaderWasmDYLD`
- `ObjectFileWasm`
- `SymbolVendorWasm`
- `SymbolFileDWARF`
- `TypeSystemClang`
- C and C++ language support
- the `ScriptInterpreterNone` fallback

LLVM 22.1.8 has static-library dependencies between some of these components,
so the linker may retain a small transitive closure. Only the roots above are
registered as product capabilities. The producer explicitly disables Python,
Lua, libedit, curses, protocol servers, tests, examples, native platform
launching, the interactive LLDB CLI, and shared/dynamically loaded plugins.
General Clang expression evaluation is not an advertised capability of this
artifact.

`DynamicLoaderWasmDYLD` is required even though the program is already mounted
in LLDB's MEMFS before attach. Its attach hook asks the GDB remote stub for the
loaded Wasm module and assigns the runtime module id to the object sections.
Without those section load addresses, source breakpoints remain pending and
stopped PCs cannot be resolved back to DWARF lines. `SymbolVendorWasm` preserves
LLVM's Wasm symbol-loading path for modules that use external debug sections;
embedded DWARF continues to be handled directly by `SymbolFileDWARF`.

`ScriptInterpreterNone` is a required non-scripting fallback even though
Python and Lua are disabled. LLDB's formatter matching always asks the
`Debugger` for a script interpreter before it builds native C/C++ formatter
candidates. A release build compiles out the upstream assertion that the
fallback plugin exists, so omitting this static root turns the first DAP
`variables` request into a null indirect call. The browser producer registers
only the inert `None` implementation; this does not enable expression
evaluation or an embedded scripting language.

The browser build intentionally omits libxml2. Upstream
`ProcessGDBRemote::GetLoadedModuleList()` refuses to read
`qXfer:libraries:read` when no XML parser is linked, so the producer patches
`ProcessWasm` to parse the constrained single-module `<library>` response
implemented by Wasm debug stubs. The parser extracts only the module path and
absolute section base needed by `DynamicLoaderWasmDYLD`; the generic GDB remote
implementation and non-Wasm targets are unchanged.

LLVM 22.1.8 also assigns every synthetic Wasm unwind frame a CFA of zero.
Recursive calls share the same symbol scope, so LLDB can otherwise collapse
their `StackID`s and evaluate a selected parent frame through frame zero.
`0007-wasm-recursive-frame-cfa.patch` derives the synthetic CFA from call
depth. Unlike the concrete frame index, call depth keeps a caller's identity
stable when a callee is pushed and orders deeper frames as younger, which is
required for LLDB's step-over plan to continue through a C++ function call.
Its upstream-style GDB remote regression selects two recursive frames through
the normal variable API, verifies ordered and distinct CFAs and values, and
requires both `qWasmLocal:0;...` and `qWasmLocal:1;...` requests. The producer
contract test additionally pins the patch content and hash.

LLVM's generic plugin lookup accepts its predicate as `std::function`.
`0008-plugin-predicate-template.patch` keeps that short-lived lookup predicate
concrete so the Emscripten compiler can emit a direct or inlined call across
pthread entry paths. The product `variables` regression was separately traced
to the missing `ScriptInterpreterNone` registration above. The template
hardening remains isolated to the browser patch queue; native LLVM stays at the
exact 22.1.8 source revision.

The Emscripten build uses pthreads and enables `PROXY_TO_PTHREAD`. LLDB's
blocking native `main` therefore runs on a pool worker while the LLDB module
worker remains available for Emscripten's proxied filesystem and runtime
operations. The UI and target still run in separate workers, and LLDB's own
C++ threads continue to use the same pool.

Emscripten 6.0.0 does not propagate arbitrary modularized `Module` properties
to those pthread realms. The producer therefore packages
`lldb-web-dap.pthread.mjs`. The host provides its URL through the supported
`mainScriptUrlOrBlob` module option. The shared-ring library bootstraps each
allocated worker before Emscripten sends that worker its load message, and the
sidecar installs the registry before importing the generated module. This
design follows the pinned Emscripten 6.0.0 `libpthread.js`, `modularize.js`, and
`runtime_pthread.js` startup order; changing the Emscripten revision requires
revalidating that contract.

The generated module requires `SharedArrayBuffer` and a cross-origin-isolated
browser context. Debug assets must be lazy-loaded; they are not intended for
the normal `WebAssembly.instantiate()` execution path.

The web C and C++ compile flags map the prepared LLVM source root to
`/llvm-project` and the Emscripten build root to `/lldb-web-build`. LLDB retains
many assertion and diagnostic `__FILE__` strings, so leaving host paths intact
makes the final Wasm bytes and even their size depend on the checkout location.
Both aliases are recorded in `manifest.json` and are part of the producer
receipt provenance. After linking, the producer scans the final Wasm bytes and
refuses to package an artifact that still contains either prepared absolute
root.

The module exports Emscripten's canonical `HEAPU8` view in addition to `FS`
and `callMain`. The browser worker uses only its backing buffer length to
report monotonic linear-memory growth; debugger memory contents never cross
the worker boundary through this telemetry path. Because Emscripten refreshes
the canonical view after memory growth, consumers must read `module.HEAPU8`
for every sample rather than retain an older typed array.

## Commands

The scripts are deliberately split so source mutation, compilation, and
packaging remain auditable:

```sh
node producer/lldb-browser/scripts/prepare.mjs
node producer/lldb-browser/scripts/build.mjs
node producer/lldb-browser/scripts/package.mjs \
  --js /path/to/lldb-web-dap.js \
  --wasm /path/to/lldb-web-dap.wasm \
  --worker /path/to/lldb-web-dap.pthread.mjs
node producer/lldb-browser/scripts/verify.mjs
```

Preparation checks out the exact locked revision, verifies every checked-in
patch/overlay hash, copies the browser overlays, and applies the patches.
Building expects the locked Emscripten SDK to be active (or `EMSDK` to point at
it), creates native TableGen tools first, and then configures the Emscripten
build. Packaging writes hash-addressed receipt and runtime manifest metadata.
It also measures a deterministic gzip representation (`level: 9`, `mtime: 0`)
without changing the runtime-facing uncompressed asset. Receipt verification
recomputes that representation and enforces both a 48 MiB uncompressed budget
and an 18 MiB gzip budget for `lldb-web-dap.wasm`; the current product is
42,723,828 bytes raw and 14,931,236 bytes compressed. A larger binary requires
an explicit reviewed budget change.

For a network- and disk-free review of the producer:

```sh
node producer/lldb-browser/scripts/prepare.mjs --plan
node producer/lldb-browser/scripts/build.mjs --plan
node --test producer/lldb-browser/test/producer.test.mjs
```

The plan modes never clone, patch, configure, or build LLVM.
Pull requests and `main` pushes run this producer contract together with the
paired WAMR producer contract in the `LLDB browser producer contracts`
workflow. The gate verifies locked hashes, patch structure, transport
overlays, pthread sidecars, and receipt/manifest behavior without downloading
or rebuilding the full LLVM and WAMR binaries. It also verifies the published
product bundle under `artifacts/runtime-source`: every LLDB and WAMR path in
`runtime-manifest.v2.json` must exist and match its recorded SHA-256 digest.

The weekly schedule also performs full clean LLDB and WAMR product builds. It
checks out the exact pinned WAMR revision, reuses the LLDB producer's pinned
Emscripten SDK, builds WAMR from two distinct clean source and build roots,
requires their verified packages to be byte-reproducible, and keeps the primary
LLDB/WAMR packages as a seven-day workflow artifact. The verifiers recompute
asset hashes, deterministic gzip receipts, and Wasm size budgets. This catches
producer, Emscripten, reproducibility, and size regressions even when no
maintainer has requested a release build. The same schedule runs the real
native C command and LLDB-DAP attach baselines; either job can still be selected
independently with `build_product=true` or `native_baseline=true` in a manual
dispatch. The native job verifies the official LLVM and WASI SDK archive
digests, builds the exact WAMR commit, recompiles the DWARF fixture, runs
`llvm-dwarfdump --verify`, and then executes both native baseline runners. It
uses a digest-pinned Debian container because the official LLDB binary has
fixed Python 3.11 and ICU 72 shared-library dependencies. See
`test/native-wasm-debug/README.md` for the command transcript contract and
manual invocation.

Maintainers can request the full pinned LLDB/WAMR rebuild and a seven-day
downloadable artifact without making the ordinary contract gate expensive:

```sh
gh workflow run lldb-browser.yml \
  -f build_product=true \
  -f native_baseline=false
```

Contract runs and product runs use separate concurrency groups. A later
pull-request or `main` contract push may replace an older contract run, but it
cannot cancel an in-flight product build; product rebuilds queue behind one
another for the same ref.

Before publishing a rebuilt debugger, produce it from two distinct empty work
directories and compare the verified packages:

```sh
node producer/lldb-browser/scripts/prepare.mjs \
  --work-dir /tmp/wasm-lldb-clean-a
node producer/lldb-browser/scripts/build.mjs \
  --work-dir /tmp/wasm-lldb-clean-a \
  --out-dir /tmp/wasm-lldb-artifacts-a
node producer/lldb-browser/scripts/prepare.mjs \
  --work-dir /tmp/wasm-lldb-clean-b
node producer/lldb-browser/scripts/build.mjs \
  --work-dir /tmp/wasm-lldb-clean-b \
  --out-dir /tmp/wasm-lldb-artifacts-b
node producer/lldb-browser/scripts/verify-reproducibility.mjs \
  /tmp/wasm-lldb-artifacts-a \
  /tmp/wasm-lldb-artifacts-b
```

The comparison first performs the full package verification on both
directories. It then requires identical receipt provenance, raw and
deterministic-gzip metadata for every runtime asset, and an identical debug
manifest. Comparing one directory with itself is rejected so the check cannot
accidentally pass without two builds.

The product bundle is generated from verified producer outputs:

```sh
WASM_LLVM_LLDB_ARTIFACT_DIR=/path/to/lldb/artifacts \
WASM_LLVM_WAMR_ARTIFACT_DIR=/path/to/wamr/artifacts \
node producer/clang-browser/scripts/prepare-release.mjs /path/to/release
```

Only the V2 manifest and its `debug/` subtree are needed by a consumer that
already provisions the Clang assets separately. Consumers should pin a
`wasm-llvm` commit and verify the six manifest hashes before launching either
worker. The uncompressed Wasm files are intentional: the runtime must mount
the exact bytes whose hashes were checked.

Useful overrides:

- `WASM_LLVM_LLDB_WORK_DIR`: checkout/build workspace
- `WASM_LLVM_LLDB_OUT_DIR`: packaged artifact directory
- `LLVM_SOURCE_DIR`: already checked-out LLVM monorepo
- `EMSDK`: locked Emscripten SDK checkout
- `NINJA_JOBS`: build parallelism

## Host startup contract

Create the LLDB module with `noInitialRun: true`, install the
`shared-ring-v1` registry and pthread sidecar URL before the factory resolves,
mount the program and sources under `/workspace`, then pass the session id as
the only argument:

```js
let exitCode;
let abortReason;
const lldb = await createLldbWebDapModule({
  noInitialRun: true,
  wasmLldbSharedRingV1: registry,
  mainScriptUrlOrBlob: new URL("lldb-web-dap.pthread.mjs", import.meta.url)
    .href,
  onExit(code) {
    exitCode = code;
  },
  onAbort(reason) {
    abortReason = reason;
  },
});

lldb.FS.mkdirTree("/workspace");
lldb.FS.writeFile("/workspace/program.wasm", programBytes);
lldb.callMain([sessionId]);
```

Invoke `callMain` only inside the dedicated LLDB Worker because DAP processing
blocks until disconnect. Treat `onExit` and `onAbort` as the adapter lifecycle
signals; do not treat returning from a host wrapper around `callMain` as a
target-process exit. The registry must be present in the initial factory
argument, not assigned afterward. The producer propagates it to all Emscripten
pthread realms, and connection ids remain realm-independent because LLDB can
open on one thread and read or interrupt on another.
