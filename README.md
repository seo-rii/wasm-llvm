# wasm-llvm

Browser-loadable LLVM toolchains and reusable language runtime profiles. `wasm-idle` consumes this
package and keeps only its UI, worker messaging, static asset synchronization, and editor wiring.

## Contents

- `artifacts/runtime-source/clang.zip`: raw WASI `clang` WebAssembly module
- `artifacts/runtime-source/lld.zip`: raw WASI `wasm-ld` WebAssembly module
- `artifacts/runtime-source/memfs.zip`: bootstrap filesystem used by the runtime
- `artifacts/runtime-source/sysroot.tar.zip`: trimmed WASI sysroot
- `artifacts/runtime-source/clangd/`: Emscripten pthread `clangd` module
- `artifacts/runtime-source/toolchain.json`: versions, resource paths, and asset hashes
- `runtime/core/`: shared compatibility and serialization helpers
- `runtime/clang/`: C/C++ compiler, linker, WASI execution, and debug runtime
- `runtime/emscripten-lld/`: canonical LLVM 16.0.4 Emscripten LLD JS/WASM/data validation and manifest rewriting
- `runtime/nim/`: versioned contract for Nim's browser Clang/LLD bundle
- `runtime/objective-c/`: libobjc2/GNUstep/libffi build profile and worker runtime
- `runtime/rust/`: Rust LLVM 18.1.3 compiler and browser LLVM 16.0.4 cross-version contract
- `runtime/swift/`: full Swift browser compiler source build, packaging, and verification pipeline
- `runtime/tinygo/`: checksum-pinned TinyGo 0.40.1 emception LLVM 16.0.0 download and patching

Current packaged versions:

- LLVM `22.1.8`
- WASI SDK `33`
- Emscripten `6.0.0`

The Clang profile uses the packaged LLVM 22 toolchain. Swift retains its separately pinned upstream
Swift/LLVM checkout because the Swift frontend requires the matching LLVM revision and libraries;
the repository boundary is shared, but the compiler builds are not forced onto one LLVM binary.

## Install

Use the GitHub package directly until this is published to a package registry:

```bash
pnpm add github:seo-rii/wasm-llvm
```

Consumers can resolve the runtime source directory from Node:

```js
import { runtimeSourceDir, toolchainMetadataPath } from '@seo-rii/wasm-llvm';
```

Browser code imports only the language subpath it needs:

```js
const { BrowserClangRuntime } = await import('@seo-rii/wasm-llvm/runtime/clang');
const { installObjectiveCWorker } = await import('@seo-rii/wasm-llvm/runtime/objective-c');
```

Swift asset synchronization can reuse the published validators without importing compiler code:

```js
import { validateSwiftRuntimeManifest } from '@seo-rii/wasm-llvm/tooling/swift/runtime-manifest';
```

Language repositories retain their compiler frontends and consume only the matching LLVM profile:

```js
import {
  rewriteSharedEmscriptenLldAssets,
  validateSharedEmscriptenLldAssets
} from '@seo-rii/wasm-llvm/runtime/emscripten-lld';
import { validateNimLlvmProfile } from '@seo-rii/wasm-llvm/runtime/nim';
import { validateRustLlvmProfile } from '@seo-rii/wasm-llvm/runtime/rust';
import { syncEmceptionRuntime } from '@seo-rii/wasm-llvm/runtime/tinygo';
```

These are independent, versioned profiles. Clang WASI, Emscripten LLD, Rust's LLVM worker, Swift's
pinned LLVM checkout, and emception are not assumed to be binary-compatible.

For package-manager installs that enforce package exports, asset files are available under:

```js
import.meta.resolve('@seo-rii/wasm-llvm/artifacts/runtime-source/toolchain.json');
```

## Verify Assets

```bash
pnpm install
pnpm verify:assets
pnpm check
pnpm test
pnpm validate:clang
pnpm swift:test
```

`verify:assets` checks that every required runtime asset exists and matches the hashes in
`toolchain.json`. `validate:clang` also compiles and executes real C and C++ programs in the WASI
runtime. The Swift suite validates source checkout, build receipts, packaging, browser execution
contracts, and stdin fixtures.

## Objective-C Profile

The Objective-C profile builds real upstream components rather than a language subset:

- libobjc2 `v2.3`
- GNUstep Base `base-1_31_1`
- libffi `v3.6.0`

```bash
pnpm build:objective-c
pnpm test:objective-c:libffi
pnpm test:objective-c:foundation
```

Set `LLVM_AR` when the host archiver cannot be discovered from the wasm-llvm build directory.

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
