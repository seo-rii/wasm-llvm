# wasm-llvm

Browser-loadable LLVM/Clang toolchain assets used by `wasm-idle`.

This package contains the binary toolchain inputs and the rebuild scripts. Runtime integration,
editor wiring, execution, and debug control stay in `wasm-idle`.

## Contents

- `artifacts/runtime-source/clang.zip`: raw WASI `clang` WebAssembly module
- `artifacts/runtime-source/lld.zip`: raw WASI `wasm-ld` WebAssembly module
- `artifacts/runtime-source/memfs.zip`: bootstrap filesystem used by the runtime
- `artifacts/runtime-source/sysroot.tar.zip`: trimmed WASI sysroot
- `artifacts/runtime-source/clangd/`: Emscripten pthread `clangd` module
- `artifacts/runtime-source/toolchain.json`: versions, resource paths, and asset hashes

Current packaged versions:

- LLVM `22.1.8`
- WASI SDK `33`
- Emscripten `6.0.0`

## Install

Use the GitHub package directly until this is published to a package registry:

```bash
pnpm add github:seo-rii/wasm-llvm
```

Consumers can resolve the runtime source directory from Node:

```js
import { runtimeSourceDir, toolchainMetadataPath } from '@seo-rii/wasm-llvm';
```

For package-manager installs that enforce package exports, asset files are available under:

```js
import.meta.resolve('@seo-rii/wasm-llvm/artifacts/runtime-source/toolchain.json');
```

## Verify Assets

```bash
pnpm install
pnpm verify:assets
pnpm check
```

`verify:assets` checks that every required runtime asset exists and matches the hashes in
`toolchain.json`.

## Rebuild Toolchain

This is a large build. It clones LLVM, downloads WASI SDK and Emscripten inputs, builds raw WASI
`clang`/`wasm-ld`, builds Emscripten pthread `clangd`, trims the sysroot, and refreshes
`artifacts/runtime-source`.

```bash
LLVM_VERSION=22.1.8 \
WASI_SDK_VERSION=33 \
EMSDK_VERSION=6.0.0 \
pnpm build:toolchain
```

Useful overrides:

- `WASM_LLVM_TOOLCHAIN_WORK_DIR`: build cache directory
- `WASM_LLVM_TOOLCHAIN_OUT_DIR`: output directory for packaged runtime assets
- `NINJA_JOBS`: CMake/Ninja parallelism
- `YOWASP_WASI_PATCH_REPO` and `YOWASP_WASI_PATCH_COMMIT`: WASI host patch source

The legacy `WASM_CLANG_TOOLCHAIN_WORK_DIR` and `WASM_CLANG_TOOLCHAIN_OUT_DIR` variables are still
accepted as aliases.

## Package Existing Outputs

If another build already produced the raw modules, package them directly:

```bash
pnpm package:toolchain -- \
  --clang-wasm /path/to/clang.wasm \
  --lld-wasm /path/to/wasm-ld.wasm \
  --sysroot /path/to/wasi-sysroot \
  --clangd-js /path/to/clangd.js \
  --clangd-wasm /path/to/clangd.wasm \
  --llvm-version 22.1.8 \
  --wasi-sdk-version 33 \
  --emsdk-version 6.0.0
```

The package script writes deterministic single-entry zips for `clang`, `lld`, and the sysroot,
copies `memfs.zip` and `clangd`, then regenerates `toolchain.json`.
