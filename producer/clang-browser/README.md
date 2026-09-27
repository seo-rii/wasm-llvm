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
producer then builds Clang/LLD/clangd, trims the sysroot, and packages the result. It also downloads
the immutable MemFS payload pinned by commit and SHA-256 in the producer manifest, so a clean output
directory is sufficient.

Before linking clangd, the producer prepares a separate `clangd-include` directory containing
shared headers and only the selected `TARGET_TRIPLE` headers. It resolves SDK header aliases while
copying, so excluding other WASI targets cannot leave dangling links. The complete selected C/C++
headers remain available to clangd; the later compiler sysroot dependency pruning does not affect
this directory. The include tree remains mounted at `/usr/include` in the worker.

```sh
pnpm build:clang
```

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
