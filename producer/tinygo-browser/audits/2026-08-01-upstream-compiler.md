# Upstream TinyGo 0.40.1 WASI compiler audit

Date: 2026-08-01

> Follow-up: the later
> [package-graph provider audit](./2026-08-01-package-graph-provider.md) closes the package-discovery
> blocker described in this point-in-time compiler audit. Its remaining protocol and resource
> blockers supersede the package-JSON statements below.
>
> The later [compile protocol v2 audit](./2026-08-01-compile-protocol-v2.md) supersedes the
> protocol-v1 object-handoff evidence below and closes generated `go:embed` object publication.

## Result

The source-pinned producer built a real upstream TinyGo compiler for `wasm32-wasip1`. Node's WASI
host ran that compiler artifact without a custom compiler import shim, produced `program.o` and
`link-plan.json` for the acceptance fixture, and the emitted object completed the external
LLD/Binaryen pipeline and executed successfully.

This closes the producer-side compiler feasibility question from the 2026-07-30 audit. A later
2026-08-01 consumer run also loaded the same compiler and reduced root in headless Chromium,
compiled the 43-package fixture through the browser WASI shim, ran raw WASI LLD and Binaryen 129,
and executed the result with exact stdin/stdout. Public TinyGo remains disabled because arbitrary
browser workspaces still need an upstream-derived `go list -deps -json` provider; the consumer does
not substitute a handwritten import scanner or silently fall back to its old subset.

## Locked identity

- TinyGo 0.40.1 commit: `db9f1182f5f2a64ea496752899626578d2b313a7`
- go-llvm commit: `b8f170971e747fec20a03b25a4490f627140709a`
- TinyGo LLVM 20.1.1 fork commit: `670759811adc85df52f410d7306788fabfc6242d`
- Go bootstrap: `go1.24.6.linux-amd64`
- source receipt SHA-256:
  `2e266ef94fd1065e68feb9c912c021bb297bad51d94c409eb4f02f4ce2deb277`
- LLVM WASI receipt SHA-256:
  `9725a7ba2c1ecb9595c30a4675beaafeed9f2cf5625edf1f64c4cb80bb78610b`
- compiler build receipt SHA-256:
  `cc62a6a5f9d564e354f5986a77be16e51c4bdb6637b560110a9e01d1baea5ab1`
- strict producer receipt SHA-256:
  `1e997040de626b37cb324ecddbc661605ae74c57d94b641b8ce2fa21cd340c49`

The source receipt verifies the clean TinyGo checkout and recursive submodules. The compiler build
receipt binds the manifest, source lock, source receipt, LLVM receipt, build script, registered
patches, Go toolchain archive, and produced assets.

The registered compatibility patch hashes used by the passing build are:

- TinyGo WASI adapter:
  `3e6680293ee53540f4d11a86171fd75ff04e1f5de713b763f11a6b050c3d0a92`
- go-llvm WASI cgo alias:
  `cb9999cc739a022442ac0a3d6ee9442f765b67e5c481a86e58d34ca848546a38`
- Go toolchain WASI process compatibility:
  `1e3d01e435ec4410355dd7160f9c45b93e825eb20eb679246292729e8b483e57`

## Produced assets

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `tinygo-compiler.wasm` | 61,589,017 | `47fd8f7e52d32c13f2264019758a7907e5500967582525d3146b96a39c0ea38e` |
| `tinygoroot.tar.gz` | 23,579,645 | `688540578e9981db3b900db07c764a2d56ee41a09a0d64ce51376bd4ec13ac70` |

The final compiler imports 28 functions and every import module is exactly
`wasi_snapshot_preview1`; the producer now rejects `env` and all other modules.

The root archive is deterministic (`tar --sort=name --mtime=@0 --owner=0 --group=0` followed by
`gzip -n -9`). It merges Go 1.24.6's standard library with TinyGo's overrides, target files, and
the exact runtime link closure for `wasip1-asyncify-precise-o1`; it deliberately omits TinyGo's
board-oriented `lib` tree. The extracted root is about 120 MiB, down from the earlier 6.6 GiB
prototype, and the compressed artifact is about 94% smaller than the earlier 390 MB archive.

## Why this is upstream TinyGo

The linked adapter was compiled by native TinyGo, not by the standard Go compiler. Its verified
package graph contains:

- `github.com/tinygo-org/tinygo/builder`
- `github.com/tinygo-org/tinygo/cgo`
- `github.com/tinygo-org/tinygo/compiler`
- `github.com/tinygo-org/tinygo/interp`
- `github.com/tinygo-org/tinygo/loader`
- `github.com/tinygo-org/tinygo/transform`
- `tinygo.org/x/go-llvm`

The producer fails if custom replacement identities such as `wasmbridge`, `tinygobackend`, or
`tinygofrontend` appear. The adapter narrows orchestration to an object/link-plan protocol; it does
not parse or translate the Go language itself.

## Closed producer blockers

The formal build incorporates the fixes that were only diagnostic probes in the earlier audit:

- pointer-only Wasm C ABI wrappers for structure-valued libclang calls and cursor callbacks;
- cgo aliases required by the TinyGo and go-llvm generated bindings;
- a GC-owned aligned-allocation path and a filtered WASI libc archive without `dlmalloc.c.obj`, so
  malloc/free ownership does not cross allocators;
- the compiler-rt 128-bit builtins required by the LLVM/C++ closure;
- direct link objects for TinyGo's Wasm stack helper and the libclang ABI wrapper;
- a pinned Go 1.24.6 process-API compatibility patch, synchronous host jobs, scheduler `none`, and
  an 8 MiB compiler stack; and
- deterministic capture of TinyGo-generated embed objects that would otherwise disappear with its
  temporary work directory.

## Compiler execution evidence

The compiler artifact ran under Node WASI with the prepared TinyGo root, the exact
`go list -deps -json` stream, user sources, cache, temporary directory, and output directory
mounted in the filesystem. It exited with status 0 and emitted:

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `program.o` | 263,371 | `739c99b1965ad7fadba7dc8e607776e61f877ac7f4621b1bf703f042d311db84` |
| `link-plan.json` | 2,729 | `c63674509d1f62e7b1ffc1b789f0c848de0f01648fd3644d7f2d76ff0da3cb62` |

The link plan declares schema version 1, identifies the seven required upstream compiler packages,
and supplies the runtime object/archive closure plus `wasm-opt` arguments. It omits
`--thinlto-cache-dir`, whose directory operation is unsupported by the raw WASI linker host.

Compile protocol v1 intentionally fails if a target package contains `CgoFiles`, `CFiles`, or
`CXXFiles`. An object-only handoff cannot yet publish every target-native object without silently
dropping semantics. This target-package restriction is independent from the compiler's own
cgo-enabled libclang/go-llvm implementation.

## Finalization and execution evidence

External LLD and Binaryen consumed the adapter outputs:

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `program.unoptimized.wasm` | 160,186 | `0392891de53f692dc48116f834b9d09b2ca7a36da006527d6c02a68d988d2c6e` |
| `program.wasm` | 248,864 | `54addef701705f696f9318df37c801179e2771f10d6cef1802b144f9d3250435` |

Node WASI then ran `program.wasm` with exit status 0, zero stderr bytes, and exact stdout:

```text
hello Ada count=2 total=3
```

The fixture covers maps, slices, a struct, a method, an interface, and stdin. The raw object and
unoptimized Wasm hashes are identical in the producer acceptance, the wasm-idle browser-WASI Node
probe, and headless Chromium. Native Binaryen 108 produced the tabled 248,864-byte final module;
the pinned browser Binaryen 129 build produced a valid 247,642-byte module with SHA-256
`eb3c137ed25ac3478e4a6a3fac9c6bb7d1e0fb896d88fa4e965384dccd1ea8c8`.

## wasm-idle browser evidence

The independent `wasm-idle/runtimes/wasm-tinygo/src/upstream-runtime.ts` path:

- verifies the producer receipt plus compiler, root, and raw LLD sizes and SHA-256 values;
- extracts the bounded gzip/tar root while rejecting traversal, links, duplicate files, and
  unsupported archive entries;
- mounts only `/tinygo-root`, `/workspace`, and `/work` for the compiler and only the required root
  and work preopens for LLD;
- requires the caller's exact normalized package JSON and rejects target CGo/C/C++ inputs;
- accepts only the fixed protocol-v1 runtime closure and exact LLD/Binaryen plan; and
- never runs the program during compilation or falls back to the AST-to-C harness.

Headless Chromium 149 compiled all 43 packages, reproduced `program.o` SHA-256
`739c99b1...d311db84` and unoptimized Wasm SHA-256 `0392891d...988d2c6e`, then executed the
Binaryen 129 result with exit 0, empty stderr, and exact stdout `hello Ada count=2 total=3\n`.
The final post-validation Node consumer receipt has SHA-256
`a8c84369586e2d05ff2be60293c410ccf2d3af0f46dbe87a2d4b642cfc19392d`; the corresponding
Chromium receipt has SHA-256
`adf87fbfab722385e7d4116bb9e73da4809db317cd132c2fa7a49f1894a89233`.

## Readiness decision

The result establishes that the producer is an upstream TinyGo implementation and that the
compiler/object/finalizer split works in Chromium. `readiness.ready` remains false because the
browser API currently requires a caller-supplied exact package graph and compile protocol v1 still
rejects target CGo/C/C++ source inputs.

The formal-v4 producer receipt binds `manifest.json` byte-for-byte, including its earlier
pre-consumer `blockedOn` snapshot. That text is intentionally not rewritten retrospectively because
doing so would invalidate the preserved receipt. The next formal producer build must replace it
with the current package-discovery, target-native-input, and resource-budget blockers recorded
here.

Before public enablement, wasm-idle must:

1. produce exact package JSON for arbitrary browser workspaces with an upstream Go/TinyGo-derived
   tool instead of a handwritten JavaScript parser;
2. make synchronous compiler/LLD execution interruptible and enforce wall-clock and memory budgets;
3. extend the object handoff for target CGo/C/C++ files; and
4. add broader Chromium differential fixtures for generics, package initialization, goroutines,
   and channels before registering `TINYGO` publicly.
