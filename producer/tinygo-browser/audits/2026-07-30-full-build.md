# TinyGo 0.40.1 browser-host build audit

Date: 2026-07-30

> Historical result: the blockers recorded here were closed by the registered producer patch set
> on 2026-08-01. The source-pinned upstream compiler Wasm was built and executed successfully; see
> [the completed compiler audit](2026-08-01-upstream-compiler.md). Browser consumer acceptance is
> still pending.

## Result

The source-pinned LLVM/Clang/libclang/LLD cross-build passed. A diagnostic upstream TinyGo
self-host build then reached `wasm-ld`, but no valid `tinygo-compiler.wasm` was produced. Browser
readiness remains false.

This is not evidence for a custom Go subset. The build package graph contained upstream TinyGo
`builder`, `cgo`, `compiler`, `interp`, `loader`, and `transform`, together with the pinned
`tinygo.org/x/go-llvm` module.

## Locked inputs

- TinyGo 0.40.1: `db9f1182f5f2a64ea496752899626578d2b313a7`
- go-llvm: `b8f170971e747fec20a03b25a4490f627140709a`
- TinyGo LLVM 20.1.1: `670759811adc85df52f410d7306788fabfc6242d`
- YoWASP WASI host patch: `1516a9b2d598e438845abd68fb32c5bc3b3e1418`
- Local LLVM WASI C API patch SHA-256:
  `30465ad38c2b1088a67b6a8db0014e9bf8aed0525d8382f97ecd312459567c4c`
- WASI SDK 33.0, target `wasm32-wasip1`

All recursive TinyGo submodules were initialized at the gitlinks recorded by the TinyGo commit.

## Passed LLVM stage

The executable CMake/Ninja stage produced a passed
`wasm-llvm-tinygo-llvm-wasi-static-v1` receipt:

- 106 static archives;
- 210,586,374 aggregate archive bytes;
- static `libclang.a`: 1,438,430 bytes;
- `libclang.a` SHA-256:
  `920cd4211bc77c60d09f92f89b7c45e3ae68737b9f4c16002ddedb7cd56adcd2`;
- required Clang C API, LLVM C API, and generated configuration headers present and hashed;
- TinyGo and go-llvm host-support C++ archives compiled for Wasm and their required bridge symbols
  verified with `llvm-nm`.

The same build reran after source-lock changes and reported `ninja: no work to do`, while
revalidating all recorded outputs.

## Native backend boundary

Separately, native upstream TinyGo compiled the acceptance fixture to `program.o`. wasm-llvm raw
WASI LLD linked it, Binaryen optimized it, and execution produced:

```text
hello Ada count=2 total=3
```

This proves the TinyGo-object to wasm-llvm finalization boundary, not a browser-hosted TinyGo
compiler.

## Diagnostic self-host progress

The self-host diagnostic used native TinyGo 0.40.1 with LLVM 20.1.1 and Go 1.24.6. Temporary,
unregistered compatibility probes were required to pass earlier host-library failures:

- TinyGo cgo aliases for generated `_Cgo_unsigned`;
- `C._Bool` in the built-in Clang/LLD bridge;
- WASI environment-backed `GOROOT`, `GOPATH`, `GOVERSION`, and `GOCACHE`;
- a matching `_Cgo_unsigned` alias in go-llvm.

These probes are diagnostic evidence only. They are not a passed producer patch set and cannot
support a release receipt.

With those probes, upstream TinyGo generated its main LLVM bitcode object and invoked the final
Wasm linker.

## Blocking libclang ABI mismatch

LLD reported 19 function-signature mismatches. TinyGo cgo flattened structure fields into direct
Wasm parameters, while Clang used the target's indirect C ABI. Representative examples were:

```text
clang_getTypeSpelling
  TinyGo declaration: (i32, i32, i32, i32) -> void
  libclang definition: (i32, i32) -> void

clang_getCString
  TinyGo declaration: (i32, i32) -> i32
  libclang definition: (i32) -> i32

clang_getFileLocation
  TinyGo declaration: (i32, i32, i32, i32, i32, i32, i32) -> void
  libclang definition: (i32, i32, i32, i32, i32) -> void
```

The affected values include `CXType`, `CXString`, `CXToken`, `CXSourceLocation`, and
`CXSourceRange`. The existing cursor trampolines and visitor callbacks also carry structures by
value and therefore need auditing, even where LTO kept both sides in one temporary object and LLD
did not emit a cross-object warning.

The safe direction is a pointer-only C shim for every structure-valued call and callback, followed
by executing the compiler against a cgo-using fixture. `--no-warn-mismatch` or a linker cast would
hide an invalid call ABI.

## Blocking allocator closure

Without WASI libc, final linkage also lacked `aligned_alloc`, `isalpha`, `tolower`, `realpath`,
`statvfs`, and pthread mutex/condition functions. Adding `-lc` resolved that closure, but WASI
SDK's `libc.a` stores `aligned_alloc` in `dlmalloc.c.obj` together with strong definitions of:

```text
malloc
free
calloc
realloc
```

TinyGo's Wasm runtime deliberately exports those same four symbols from its GC-aware allocator.
The resulting duplicate definitions are real allocator ownership conflicts. Allowing duplicate
symbols could send allocation and deallocation through different allocators.

A future implementation must either provide a GC-compatible `aligned_alloc`/free design in the
TinyGo runtime, or build a compatible libc++/libc++abi closure that does not require the WASI
dlmalloc member. Over-aligned C++ allocation and collection liveness must be tested before either
approach is accepted.

## Readiness decision

No compiler Wasm, TinyGo root archive, or browser acceptance receipt was issued. Public TinyGo
support must remain disabled until:

1. the pointer-only libclang ABI layer passes real compiler execution;
2. one allocator owns every C/C++ allocation path;
3. the compatibility changes are source-locked and reproduced by the formal producer;
4. wasm-idle supplies the package graph, VFS, LLD/Binaryen finalization, and acceptance receipt.
