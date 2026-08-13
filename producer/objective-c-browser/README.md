# Objective-C browser artifact producer

This producer builds the GNUstep `libobjc2` runtime as a WASI preview 1 (`wasm32-wasip1`) static archive and can
probe or package selected GNUstep Base and libffi inputs. It contains source preparation and
compiler tooling only. The worker, browser filesystem, module loader, and execution host belong
to the consuming application.

## Pinned inputs

`manifest.json` pins libobjc2, robin-map, GNUstep Base, libffi, and the expected WASI SDK family.
The scripts clone those revisions into a temporary cache and never import the former
`@seo-rii/wasm-llvm` runtime package.

## Toolchain

Install WASI SDK 33 and either set `WASI_SDK_PATH` or provide the individual paths:

```bash
export WASM_LLVM_CLANG=/opt/wasi-sdk/bin/clang
export WASM_LLVM_WASM_LD=/opt/wasi-sdk/bin/wasm-ld
export WASM_LLVM_WASI_SYSROOT=/opt/wasi-sdk/share/wasi-sysroot
export LLVM_AR=/opt/wasi-sdk/bin/llvm-ar
```

`WASM_LLVM_OBJECTIVE_C_CACHE_DIR` and
`WASM_LLVM_OBJECTIVE_C_FOUNDATION_CACHE_DIR` override the temporary source/build caches.
`WASM_LLVM_OBJECTIVE_C_OUTPUT_DIR` overrides the default `out/objective-c-browser` output.

## Build libobjc2

```bash
pnpm build:objective-c
```

The command writes `libobjc.a`, `headers.json`, and `producer-receipt.json`. The receipt records
the producer manifest hash, resolved source commits, native compiler identity, and output hashes.
These files are deployment inputs and are not npm package contents.
The archive uses the official WASI SDK mmap emulation and must be linked with
`-lwasi-emulated-mman`; the Clang producer retains that archive in its deployed sysroot.

## GNUstep and libffi probes

Compile one GNUstep Base source file after building libobjc2:

```bash
pnpm probe:objective-c:foundation -- NSObjCRuntime.m
```

Build the selected GNUstep Base archive and exported headers:

```bash
pnpm probe:objective-c:foundation -- --build-archive
```

Set `WASM_LLVM_OBJECTIVE_C_FOUNDATION_USE_LIBFFI=1` to include the pinned libffi objects. The
source limit can be reduced for investigation with
`WASM_LLVM_OBJECTIVE_C_FOUNDATION_SOURCE_LIMIT`.
The full archive build updates `producer-receipt.json` with every Objective-C, Foundation, and
libffi asset hash. Verify a deployment-ready output directory with
`pnpm verify:objective-c-artifacts`.

Run the strict libffi WASI backend probe with:

```bash
pnpm probe:objective-c:libffi
```

The compatibility shims model a single-threaded WASI target. Block-to-IMP executable trampolines
cannot be represented by core Wasm and remain intentionally disabled in the produced libobjc2
archive; this is recorded in the build receipt rather than hidden in browser runtime code.
