# Clang browser producer

This producer builds the LLVM tools and data consumed by browser hosts. It contains no browser
runtime implementation. The source and toolchain defaults are recorded in `manifest.json`; a
completed build writes checksums and effective versions to `artifacts/clang-browser/toolchain.json`.

## Outputs

- `clang.zip`: raw WASI Clang driver module
- `lld.zip`: raw WASI LLD module
- `sysroot.tar.zip`: trimmed WASI C/C++ sysroot and Clang resource headers
- `memfs.zip`: bootstrap filesystem used by the external host runtime
- `clangd/clangd.js` and `clangd/clangd.wasm.gz`: Emscripten pthread clangd worker
- `clangd/clangd.headers.json.gz`: optional separately fingerprinted complete selected-target C/C++ and resource headers, produced with `CLANGD_SEPARATE_HEADERS=ON`
- `toolchain.json`: build receipt and SHA-256 hashes

The checked-in producer artifacts are inputs to deployment, not npm package contents. Run
`prepare:clang-release` to produce the directory that should be uploaded to static hosting.

## Rebuild

The full build requires CMake, Ninja, Git, tar, a downloader, and enough disk for native and WASI
LLVM builds. It downloads the pinned WASI SDK and Emscripten SDK, checks out the pinned LLVM tag,
applies the pinned YoWASP WASI-host patch, the checksum-pinned LLVM patch that preserves successful
WASI `close()` results instead of returning stale `errno`, and the checksum-pinned local patch that
limits the standalone LLD module to its WebAssembly driver. A separate checksum-pinned clangd patch
adds the Asyncify bridge that waits for browser-provided stdin before each JSON-RPC message. The
producer then builds Clang/LLD/clangd, trims the sysroot, and packages the result. It also rebuilds
MemFS from the small source files pinned by immutable revision, size and SHA-256 in the manifest.
The node table holds 8192 entries instead of 1024, leaving room for Objective-C headers and workspace
files after mounting the sysroot. A clean output directory is sufficient.

The WASI SDK clang driver normally runs any `wasm-opt` found on `PATH` after linking, so a host
Binaryen package would silently change the clang and wasm-ld bytes. The producer links them with
`--no-wasm-opt`, keeps the `target_features` section as the driver does for its own pass, and then runs `wasm-opt` from the pinned Emscripten SDK at the level the driver
would have used (`LLVM_MINSIZE_OPT` for `MinSizeRel`, `O3` for `Release`, `O2` for
`RelWithDebInfo`, none for `Debug`).

Before linking clangd, the producer prepares a separate `clangd-include` directory containing
shared headers and only the selected `TARGET_TRIPLE` headers. It resolves SDK header aliases while
copying, so excluding other WASI targets cannot leave dangling links. The complete selected C/C++
headers remain available to clangd; the later compiler sysroot dependency pruning does not affect
this directory. The default `CLANGD_SEPARATE_HEADERS=OFF` embeds it at `/usr/include` in clangd's
Wasm, preserving the two-asset worker contract.

With `CLANGD_SEPARATE_HEADERS=ON`, the linker omits the embedded tree. Packaging stores the complete
tree at `/usr/include` and the matching resource headers at `/lib/clang/<major>/include` in a
separately versioned gzip JSON asset. The runtime verifies and prepares that asset concurrently
with Wasm compilation, then mounts every header before document analysis. Embedded-header and
custom asset configurations remain supported. The selected execution sysroot is dependency-pruned
and cannot replace this complete clangd header tree.

The separated candidate passed C/C++ diagnostics, completion and pthread startup checks, but
current Chromium measurements showed slower readiness and first diagnostics. Header separation
therefore remains an opt-in configuration; shipped headers remain embedded. It shrinks raw Wasm
without guaranteeing a smaller combined download or faster startup.

```sh
pnpm build:clang
```

To build the separate-header variant in isolated work/output directories:

```sh
CLANGD_SEPARATE_HEADERS=ON \
  WASM_LLVM_TOOLCHAIN_WORK_DIR=/path/to/separated-work \
  WASM_LLVM_TOOLCHAIN_OUT_DIR=/path/to/separated-output \
  pnpm build:clang
```

To rebuild only MemFS with an existing WASI SDK 33 installation:

```sh
node producer/clang-browser/scripts/build-memfs.mjs \
  --wasi-sdk /path/to/wasi-sdk-33.0-x86_64-linux \
  --work-dir /path/to/memfs-work \
  --out-dir /path/to/memfs-output
```

This downloads five pinned source/license files, without cloning LLVM. Source hash failures stop
the build, including cached-file mismatches. Both the full build and this command use the same
helper. Its compatibility patch changes WASI API names and preserves the old module's abort trap;
the linker explicitly exports the original API and strips custom debug/name sections. Each build
checks the exact import/export set, function arities and 8188 usable file nodes, including a trap
at exhaustion. It writes `memfs.wasm`, deterministic `memfs.wasm.gz`, license notices, and
`memfs-build-receipt.json` with source, patched-source and builder hashes, SDK identity, commands,
capacity and output hashes. The full build places these under the output directory's `memfs-build/`.

The full build passes that receipt to the packager using `--memfs-receipt`. When packaging outputs
manually, pass the same option alongside `--memfs-wasm`; the receipt's directory must also contain
`LICENSE.llvm.txt` and `LICENSE.stb_sprintf.txt`. Packaging verifies the module against its receipt
and verifies both license notices. `toolchain.json` records the original receipt and sidecar hashes
under `memfs`, separately from the six runtime assets. `prepare:clang-release` verifies and copies
`memfs-build-receipt.json`, `LICENSE.memfs-llvm.txt` and `LICENSE.memfs-stb_sprintf.txt` into the release
root, preserving their metadata in `runtime-build.json`. Legacy/custom inputs without an explicit
MemFS receipt retain the existing packaging contract; an explicit missing or mismatched receipt or
license is an error.

The pinned 2019 LLVM release license is NCSA; `memfs.c` itself has no per-file license header.
The build preserves that license and selects the MIT option embedded in `stb_sprintf.h`, recording
the source's licensing context and modifications in the receipt.

Useful overrides:

- `LLVM_VERSION` with its required `LLVM_COMMIT`, plus `WASI_SDK_VERSION` and `EMSDK_VERSION`
- `YOWASP_WASI_PATCH_REPO` and `YOWASP_WASI_PATCH_COMMIT`
- `WASI_SDK_PATH` to use an existing SDK
- `WASM_LLVM_TOOLCHAIN_WORK_DIR` for build intermediates
- `WASM_LLVM_TOOLCHAIN_OUT_DIR` for producer artifacts
- `NINJA_JOBS` for build parallelism
- `LLVM_BUILD_TYPE` (default `MinSizeRel`) selects the WASI and clangd build configuration.
- `LLVM_MINSIZE_OPT=Oz|Os` (default `Oz`) selects size optimization for `MinSizeRel` C/C++
  compilation and final links, preserving `-DNDEBUG`. `Os` restores the previous optimization
  level for comparisons. Other build configurations and native TableGen remain unchanged.
- `CLANGD_LTO=ON|OFF` (default `ON`) controls link-time optimization of clangd. LLVM's
  CMake configuration adds `-flto` to C, C++, and linker flags together. Use `OFF` for an
  otherwise identical comparison build; Clang/LLD's existing WASI LTO settings are independent.
- `CLANGD_ASSERTIONS=ON|OFF` controls Emscripten runtime assertions. It defaults to `OFF`
  for optimized builds and `ON` for `LLVM_BUILD_TYPE=Debug`; explicitly set `ON` when
  diagnosing worker or Asyncify failures. This affects runtime checks, not source diagnostics.
- `CLANGD_TIDY_CHECKS=ON|OFF` (default `OFF`) excludes the built-in clang-tidy check modules
  from clangd. Compiler diagnostics, completion, navigation, and formatting remain available;
  clang-tidy-specific diagnostics and fixes require rebuilding with `ON`. A runtime
  `--clang-tidy` option cannot restore checks omitted at build time.
- `CLANGD_DECISION_FOREST=ON|OFF` (default `OFF`) omits the generated completion ranking
  model. LLVM 22 falls back to heuristic ranking; completion stays available, but suggestion
  order can change. Set `ON` to restore the model for quality and size comparisons; forcing
  `--ranking-model=decision_forest` at runtime requires a build with the model enabled.
- `CLANGD_SEPARATE_HEADERS=ON|OFF` (default `OFF`) keeps complete selected-target headers embedded
  by default. `ON` packages the header tree and matching resource headers separately with
  compressed/raw fingerprints and preserves their virtual filesystem paths. Switching modes
  requires relinking clangd and packaging matching assets and receipts together.

Speed comparisons for the WASI clang/wasm-ld modules that run on every browser compile:

- `LLVM_HOT_PATH_OPT=none|O2|O3` (default `none`) compiles the sources under `LLVM_HOT_PATH_DIRS`
  at that level while the rest of the module keeps `LLVM_MINSIZE_OPT`. The CMake compiler launcher
  `scripts/hot-path-launcher.sh` rewrites the flag per source; LTO keeps the per-function level.
  `LLVM_HOT_PATH_DIRS` is a comma-separated list of LLVM checkout paths and defaults to
  `clang/lib/Lex,clang/lib/Basic,llvm/lib/Support`. These flags
  optimize the execution compiler itself; they do not change user-program optimization or clangd.
- `CLANG_WASM_OPT=default|O2|O3` (default `default`) replaces the build type's level for the pinned
  Binaryen pass over the linked clang and wasm-ld modules.
- `--compiler-only` stops after those two modules and writes them with `compiler-build.json` to
  `WASM_LLVM_TOOLCHAIN_OUT_DIR/compiler`, skipping clangd and packaging.

`scripts/benchmark-compiler.mjs` compares builds against a baseline. It reports raw and level-9 gzip
sizes, SHA-256 identities, module compilation time, and compile/link latency of C,
`<bits/stdc++.h>`, template-heavy and `-O0 -g` workloads in Node. The report separates execution
time from preparation and instantiation, preserves every sample, and links and runs each source
to verify its output. `--enforce` fails when output differs or any module grows by more than
`--max-growth` percent (default 10) in raw or gzip bytes:

```sh
node producer/clang-browser/scripts/benchmark-compiler.mjs \
  --sysroot artifacts/clang-browser/sysroot.tar.zip \
  --baseline artifacts/clang-browser \
  --candidate raw-oz=/path/to/raw-oz \
  --candidate baseline-o3=/path/to/baseline-o3 \
  --candidate narrow-oz=/path/to/narrow-oz \
  --candidate narrow-o3=/path/to/narrow-o3 \
  --runs 5 --enforce --json /path/to/node-comparison.json
```

Each directory's `compiler-build.json`, `toolchain.json`, and optional `benchmark-provenance.json`
are included with receipt-file hashes. For post-processing experiments, the latter records the
pinned Binaryen executable/version/hash, exact command, source-build receipt, and input/output
module hashes. `SOURCES`, `WORKLOADS`, and `EXPECTED_OUTPUT` are exported for browser probes to
use equivalent workloads.

Node measurements use local bytes and a fresh WASI instance for each invocation. They omit network
transfer and persistent-cache reloads; V8 tiering and browser preparation can affect the outcome.
Earlier Node improvement percentages are reference data and do not predict browser improvements.
Measure Binaryen `O3` from raw linker outputs separately from narrow selective `O2` with the existing
Binaryen level, then measure their combination. Their improvement percentages must not be added.
Verify that the pinned existing-level pass over the same raw inputs reproduces the shipped hashes.
If it differs, retain that matched raw-input control for attributing the Binaryen-only effect and
report the comparison against shipped artifacts separately.

Keep the shipped baseline until measured first program output and warm operation justify the
compressed-byte increase under both normal and constrained networks. Record empty-cache startup,
persistent-cache reload, preparation stages, emitted output, and compiler diagnostics separately.


LTO requires recompiling clangd's libraries and can increase link time and peak build memory.
Use separate work/output directories for comparisons and record both compressed and raw Wasm
sizes. Recipe changes require new artifacts, receipts, and browser acceptance before promotion;
the checked-in artifacts are not regenerated merely by editing this build script.

`Oz` prioritizes size more aggressively than `Os`. Compare compiler execution and clangd
diagnostic/completion latency as well as download size before promoting a newly built bundle.

To compare only the header trimming against the previous build settings, use
`LLVM_MINSIZE_OPT=Os CLANGD_LTO=OFF CLANGD_ASSERTIONS=ON CLANGD_TIDY_CHECKS=ON
CLANGD_DECISION_FOREST=ON`. Change one setting at a time in separate work/output directories.
Validate C, C++, and Objective-C diagnostics/completion and regenerate consumer integrity records
when adopting new artifacts. Asyncify remains enabled with its normal indirect-call analysis:
the stdin wait is reached through the virtual JSON transport loop, so narrowing instrumentation
requires a rebuilt artifact and verified suspend/resume call paths first.

To package raw outputs from another build:

```sh
pnpm package:clang -- \
  --clang-wasm /path/to/clang.wasm \
  --lld-wasm /path/to/wasm-ld.wasm \
  --sysroot /path/to/wasi-sysroot \
  --memfs-wasm /path/to/memfs.wasm \
  --clangd-js /path/to/clangd.js \
  --clangd-wasm /path/to/clangd.wasm \
  --clangd-include /path/to/complete/clangd-include \
  --clangd-resource-include /path/to/resource/include \
  --llvm-version 22.1.8 \
  --llvm-commit ca7933e47d3a3451d81e72ac174dcb5aa28b59d1 \
  --wasi-sdk-version 33 \
  --emsdk-version 6.0.0
```

## Verify and prepare

```sh
pnpm verify:clang-artifacts
pnpm smoke:clang-artifacts
pnpm prepare:clang-release
```

`verify:clang-artifacts` checks every artifact against `toolchain.json`.
Both verification commands reject clangd assets that omit either the loader-side
`Module.stdinReady` callback or the WebAssembly import wired to `__asyncjs__waitForStdin`.
Optimized Emscripten builds shorten import names when assertions are disabled. Verification
parses the loader without executing it, resolves the generated import table and namespace,
and requires the matching function import in Wasm. Ambiguous or unsupported mappings are rejected.
`smoke:clang-artifacts` also opens the archives, compiles the Clang, LLD, and clangd WebAssembly
modules, and checks the sysroot and MemFS payloads. `prepare:clang-release` writes the externally
hosted bundle to `out/clang-browser` by default, including `runtime-manifest.v1.json` and
`runtime-build.json` for consumers.
