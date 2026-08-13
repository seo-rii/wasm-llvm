# wasm-llvm

`wasm-llvm` is a producer-only repository for browser-hosted compiler artifacts. It records source
pins, patches, build recipes, packaging scripts, artifact manifests, build receipts, and focused
verification. Browser execution code, filesystem adapters, worker hosts, and language runtime APIs
are owned by consumers such as `wasm-idle`.

The root npm project is private and exists only as a command surface for Node-based build tools.
It has no exports, publication lifecycle, or installable JavaScript API. Compiler modules,
sysroots, archives, generated workers, and release bundles must be uploaded to external static
hosting and loaded by URL from the consuming application.

## Producers

| Producer       | Pinned inputs                                                                                    | Produced or verified artifacts                                      | Documentation                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Clang          | LLVM 22.1.8, WASI SDK 33, emsdk 6.0.0, YoWASP WASI-host and local close/LLD/clangd-stdin patches | Clang, LLD, sysroot, MemFS, clangd, receipt                         | [`producer/clang-browser`](producer/clang-browser/README.md)                   |
| COBOL          | GnuCOBOL 3.2, GMP 6.3.0, WASI SDK 33                                                             | `cobc`, rootfs, C sysroot, receipt                                  | [`producer/cobol-browser`](producer/cobol-browser/README.md)                   |
| Emscripten LLD | LLVM 16.0.4 canonical import                                                                     | JS/Wasm/data bundle and receipt                                     | [`producer/emscripten-lld-browser`](producer/emscripten-lld-browser/README.md) |
| LLDB           | LLVM 22.1.8, emsdk 6.0.0, shared-ring transport and browser plugin patches                       | `lldb-web-dap` JS/Wasm/pthread worker, manifest, receipt            | [`producer/lldb-browser`](producer/lldb-browser/README.md)                     |
| Objective-C    | libobjc2 2.3, robin-map 1.4.0, GNUstep Base 1.31.1, libffi 3.6.0                                 | `libobjc.a`, headers, optional Foundation/libffi archives, receipts | [`producer/objective-c-browser`](producer/objective-c-browser/README.md)       |
| Rust           | Rust 1.99.0, rust-lang LLVM 22.1.8, wasi-libc and libstdc++ commits                              | Full `rustc.wasm`, target libraries, receipt                        | [`producer/rust-browser`](producer/rust-browser/README.md)                     |
| Swift          | Swift 6.3.3, official Wasm SDK, pinned LLVM/Swift/SwiftSyntax patches                            | Swift compiler modules, SDK bundle, manifests and receipts          | [`producer/swift-browser`](producer/swift-browser/README.md)                   |
| TinyGo         | TinyGo 0.40.1, pinned go-llvm, TinyGo LLVM 20.1.1                                                | Upstream compiler, reduced root, strict receipt, Chromium consumer acceptance | [`producer/tinygo-browser`](producer/tinygo-browser/README.md)                 |
| WAMR           | WAMR 2.4.5, emsdk 6.0.0, browser RSP transport patch                                            | Interpreter/debug-stub JS/Wasm/pthread worker and receipt           | [`producer/wamr-browser`](producer/wamr-browser/README.md)                     |

`artifacts/clang-browser` and `artifacts/cobol-browser` hold verified producer outputs currently
tracked for deployment. The Emscripten LLD canonical import remains next to its producer at
`producer/emscripten-lld-browser/artifacts`. None of these paths are npm package contents.

## Setup and focused checks

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm verify:clang-artifacts
pnpm smoke:clang-artifacts
pnpm verify:cobol-artifacts
pnpm verify:emscripten-lld-artifacts
pnpm producer:rust:verify
pnpm swift:doctor
```

These checks validate repository boundaries, Node syntax, source and patch locks, checked-in
artifact hashes, archive structure, WebAssembly validity, and producer receipts. They do not run
the large LLVM, Rust, or Swift source builds.

## Build and release commands

The root scripts delegate to a producer; implementation details and required native tools are in
each producer README.

```bash
# Clang/LLD/clangd
pnpm build:clang
pnpm package:clang -- --help
pnpm prepare:clang-release

# LLDB debug adapter
pnpm prepare:lldb -- --plan
pnpm build:lldb -- --plan
pnpm package:lldb -- --help

# WAMR debug target
pnpm prepare:wamr -- --source /path/to/wasm-micro-runtime
pnpm build:wamr -- --source /path/to/wasm-micro-runtime --build /path/to/build --emsdk /path/to/emsdk
pnpm package:wamr -- --build /path/to/build --output /path/to/wamr-artifacts

# GnuCOBOL
WASI_SDK_PATH=/opt/wasi-sdk pnpm build:cobol
pnpm prepare:cobol-release

# Objective-C
WASI_SDK_PATH=/opt/wasi-sdk pnpm build:objective-c
WASI_SDK_PATH=/opt/wasi-sdk pnpm probe:objective-c:foundation
WASI_SDK_PATH=/opt/wasi-sdk pnpm probe:objective-c:libffi

# Rust
pnpm producer:rust:prepare
pnpm producer:rust:build

# Swift
pnpm --dir producer/swift-browser run bootstrap:source -- --help
pnpm --dir producer/swift-browser run build:browser-compiler -- --help
pnpm --dir producer/swift-browser run package:from-plan -- --help

# TinyGo upstream compiler plans (dry-run unless --execute is supplied)
pnpm build:tinygo-llvm-wasi -- --help
pnpm build:tinygo-browser -- --help
pnpm accept:tinygo-browser -- --help
pnpm probe:tinygo-native-split -- --help
pnpm verify:tinygo-artifacts -- --help

# Legacy LLVM 16 worker synchronization (not a TinyGo compiler)
pnpm sync:tinygo -- out/tinygo-browser/emception.worker.js
```

Large builds write to producer-specific work or output directories. A release directory is a
handoff to static hosting, not a publishable npm payload. Consumers must resolve an explicit URL,
fetch the corresponding manifest or receipt, and verify hashes before loading compiler assets.

The Clang release assembler also creates `runtime-manifest.v2.json` when both debugger artifact
directories are supplied:

```bash
WASM_LLVM_LLDB_ARTIFACT_DIR=/path/to/lldb-artifacts \
WASM_LLVM_WAMR_ARTIFACT_DIR=/path/to/wamr-artifacts \
WASM_LLVM_CLANG_RELEASE_DIR=/path/to/release \
pnpm prepare:clang-release
```

That bundle pins the Clang/LLDB revision, WAMR revision, patch receipt, capabilities, and all six
debug asset hashes. Normal execution still uses the browser WebAssembly engine; consumers
lazy-load this LLDB/WAMR pair only for source-debug sessions.

## Reproduction contract

Each source-built producer keeps its immutable upstream references and local patch hashes in
`manifest.json`. Build scripts resolve and record the effective source commits and tool versions.
Receipts bind those inputs to output sizes and SHA-256 hashes. When a source, patch, build script,
or toolchain pin changes, regenerate the affected artifacts and receipt together; never reuse a
receipt from an older producer state.

The Emscripten LLD directory is the exception: it preserves an imported canonical artifact whose
original build invocation is unavailable. Its manifest and receipt verify provenance and bytes,
but the repository deliberately does not invent a reproduction command for it.

## Ownership boundary

This repository may contain Node scripts that download, patch, compile, package, or verify
compiler assets. It must not contain browser runtime TypeScript, package exports, self-imports from
`@seo-rii/wasm-llvm`, package-relative static asset loading, or npm publication hooks. The
`scripts/check-repository.mjs` check enforces that boundary.
