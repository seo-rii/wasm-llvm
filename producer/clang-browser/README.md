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
`Module.stdinReady` callback or the WebAssembly `__asyncjs__waitForStdin` import.
`smoke:clang-artifacts` also opens the archives, compiles the Clang, LLD, and clangd WebAssembly
modules, and checks the sysroot and MemFS payloads. `prepare:clang-release` writes the externally
hosted bundle to `out/clang-browser` by default, including `runtime-manifest.v1.json` and
`runtime-build.json` for consumers.
