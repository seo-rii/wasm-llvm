# TinyGo browser producer

This producer separates three things that were previously easy to confuse:

- `scripts/sync.mjs` mirrors a patched LLVM 16 Emception worker. It can compile C and link Wasm,
  but it is not the TinyGo compiler.
- `scripts/probe-native-split-pipeline.mjs` proves the object/link split with native upstream
  TinyGo, wasm-llvm raw WASI LLD, and Binaryen. It is evidence for the backend boundary, not a
  browser compiler.
- `sources.lock.json`, `scripts/build-llvm-wasi.mjs`, and
  `scripts/build-browser-compiler.mjs` define a fail-closed path for a real upstream TinyGo browser
  compiler. It pins TinyGo 0.40.1, its exact `go-llvm` module revision and checksum, and the
  TinyGo LLVM 20.1.1 fork commit.
- `package-graph.lock.json` and `scripts/build-package-graph-provider.mjs` build the pinned Go
  1.24.6 `cmd/go` itself for WASI. This is the browser package selector; it is not a handwritten
  import scanner.

The full LLVM/Clang/LLD cross-build passed on 2026-07-30. On 2026-08-24 the source-locked producer
built a self-contained upstream TinyGo compiler Wasm and deterministic TinyGo root archive with
the Clang resource headers and generated wasi-libc header closure required by CGo, then compiled
and executed the acceptance fixture through external LLD and Binaryen. The
[completed-build audit](audits/2026-08-01-upstream-compiler.md) records the exact inputs, output
hashes, imports, and execution evidence. wasm-idle now also owns an independent receipt-verified
VFS/package-graph/compiler/raw-LLD/Binaryen path. The package provider matches the same pinned
native `cmd/go` JSON exactly, and a 45-package local-module workspace with `CgoFiles`, target
`CFile`/`CXXFile`/uppercase `.S`, and `go:embed` passed end to end in Node and headless Chromium.
Compile protocol v6 publishes TinyGo's program/embed objects, CGo source evidence, target-C,
hosted C++17 ThinLTO bitcode with libc++/libc++abi, and Clang assembler-with-cpp WebAssembly
objects with per-source dependency and object hashes for external LLD. Restricted CXXFLAGS and
library-oriented linker flags are preserved exactly; offline external modules use the standard
`vendor/modules.txt` and `-mod=vendor` contract. Before publishing native entries, the adapter uses
the pinned LLVM 20.1.1 bitreader and verifier for bitcode and LLVMObject's WebAssembly parser for
relocatable `.S` objects. `manifest.json` records `readiness.ready: true`, which enables the strict
verifier but does not replace it: only a fresh workflow run whose expanded fixture passes may issue
public artifacts.
The Emception worker and handwritten Go-to-C subset remain
ineligible as TinyGo implementations. See the
[package-graph audit](audits/2026-08-01-package-graph-provider.md) and the
[historical compile-protocol-v2 audit](audits/2026-08-01-compile-protocol-v2.md). The current
evidence is recorded in the [public-product audit](audits/2026-08-24-public-product.md); earlier
protocol audits remain point-in-time history.

## Prepare and verify upstream source identity

Prepare a shallow detached checkout and deterministic source receipt:

```sh
pnpm prepare:tinygo-source -- \
  out/tinygo-browser/source \
  out/tinygo-browser/tinygo-source-receipt.json
```

The receipt is based on more than a version label. Preparation verifies:

- the exact upstream Git commit and a clean worktree, including untracked files;
- recursively initialized submodules at the gitlinks pinned by that commit;
- the upstream `github.com/tinygo-org/tinygo` module and reference `main.go` entrypoint;
- byte-for-byte hashes for `builder`, `cgo/libclang`, `compiler`, `interp`, `loader`, and
  `transform` sources;
- the `tinygo.org/x/go-llvm` import, pseudo-version, full commit, and module checksums;
- the pinned TinyGo LLVM branch and commit; and
- the complete registered TinyGo adapter and LLVM/Clang WASI patch list and patch digests.

Recheck an existing source receipt without rewriting it:

```sh
pnpm verify:tinygo-source -- \
  out/tinygo-browser/source \
  out/tinygo-browser/tinygo-source-receipt.json
```

Modified sources or injected paths such as `wasmbridge/tinygobackend` fail this verification.

## Build the LLVM, Clang, libclang, and LLD host

The first build stage cross-compiles the pinned TinyGo LLVM 20.1.1 fork for `wasm32-wasip1`. It
uses native `llvm-tblgen` and `clang-tblgen`, and requires WASI SDK tools and libc++. The plan
includes static libclang, the Clang driver libraries, every LLD driver library used by upstream
`builder/lld.cpp`, and the LLVM static closure needed by `go-llvm`.

Generate a deterministic dry-run receipt:

```sh
pnpm build:tinygo-llvm-wasi -- \
  --source-root /path/to/tinygo-llvm-project \
  --wasi-sdk /path/to/wasi-sdk \
  --native-tool-dir /path/to/native-llvm/bin \
  --build-dir /path/to/tinygo-llvm-wasi-build \
  --receipt /path/to/tinygo-llvm-wasi-build.json
```

Use `--check-patch` to verify the locked revision and patch without modifying the checkout. Use
`--execute` only in an isolated checkout to apply the registered WASI platform patch and run
CMake/Ninja. A passed receipt hashes all static archives plus the Clang C API, LLVM C API, and
generated LLVM configuration headers. Merely producing a CMake plan does not satisfy readiness.

The 2026-07-30 execution produced a passed receipt for all 106 requested archives
(210,586,374 bytes total). Its static `libclang.a` is 1,438,430 bytes with SHA-256
`920cd4211bc77c60d09f92f89b7c45e3ae68737b9f4c16002ddedb7cd56adcd2`. This closes the
LLVM-platform-patch question; it does not by itself establish a working TinyGo compiler.

## Build the upstream TinyGo compiler adapter

The second stage validates a passed LLVM receipt, the clean TinyGo source receipt, the exact
`go-llvm` source tree, and a native TinyGo 0.40.1 bootstrap compiler using LLVM 20. It compiles the
six upstream C++ translation units that Go package metadata does not compile automatically:

- TinyGo `builder/cc1as.cpp`, `builder/clang.cpp`, and `builder/lld.cpp`;
- go-llvm `IRBindings.cpp`, `SupportBindings.cpp`, and `backports.cpp`.

Those files become two deterministic WASI static archives. The producer also compiles the
upstream `src/runtime/asm_tinygowasm.S` stack helper and the registered pointer-only
`cgo/libclang_stubs.c` ABI layer as direct link objects. The build verifies the real
`tinygo_clang_driver`, `tinygo_link`, `tinygo_validate_wasm_object`, and go-llvm bridge symbols with
`llvm-nm`; stub symbols are
forbidden. It then invokes the native TinyGo compiler on the patched upstream
`cmd/tinygo-browser-adapter`, never the standard Go compiler:

```sh
pnpm build:tinygo-browser -- \
  --source-root /path/to/clean-tinygo \
  --source-receipt /path/to/tinygo-source-receipt.json \
  --go-llvm-source-root /path/to/go-llvm \
  --llvm-receipt /path/to/tinygo-llvm-wasi-build.json \
  --tinygo /path/to/native/tinygo \
  --native-wasm-ld /path/to/wasm-ld \
  --go-toolchain-archive /path/to/go1.24.6.linux-amd64.zip \
  --artifact-dir /path/to/tinygo-browser-artifacts \
  --build-dir /path/to/tinygo-browser-build \
  --receipt /path/to/tinygo-browser-build.json \
  --execute
```

Without `--execute`, the command validates inputs and writes an intermediate dry-run receipt. The
executed 2026-08-10 hardened build produced a 70,294,650-byte `tinygo-compiler.wasm` with SHA-256
`441bfe526d407019137b8ede9c27b76dfcf91d4c3f789e4e24fdbcfa250697f8` and a 24,266,537-byte
deterministic `tinygoroot.tar.gz` with SHA-256
`1cdf9188dfcba8f49fd9a5755d24a409fda01c1f9272e83a8d4ecadd0b648082`. The reduced root merges
the pinned Go 1.24.6 standard library, TinyGo overrides and targets, the runtime link closure, and
the receipt-bound Clang/wasi-libc header closure while omitting unrelated board data. The build
captures TinyGo-generated embed and target-C/C++/assembly objects under deterministic names, links compiler-rt's
128-bit builtins and `libdl`, and rejects the final compiler if it retains any import outside
`wasi_snapshot_preview1`. The strict producer receipt has SHA-256
`69d10defa969431faf7e5b9067eaa19fea40ad91e85b9beaf6fed78d88928309`.

## Build the upstream package-graph provider

The provider cross-compiles the source-locked Go 1.24.6 `cmd/go` entrypoint to WASI. It runs a
field-limited `go list -deps -e -mod=readonly` with fixed TinyGo target tags, network module
resolution disabled, and the reduced TinyGo/Go root mounted read-only. The only source patch skips
advisory file locks on `wasip1`, where the browser host is single-process and the command is
read-only:

```sh
pnpm build:tinygo-package-graph -- \
  --go-toolchain-archive /path/to/v0.0.1-go1.24.6.linux-amd64.zip \
  --root-archive /path/to/tinygoroot.tar.gz \
  --fixture producer/tinygo-browser/fixtures/package-graph-module \
  --artifact-dir /path/to/package-graph-artifacts \
  --build-dir /path/to/package-graph-build \
  --receipt /path/to/package-graph-provider-receipt.json \
  --execute
```

The acceptance fixture proves a local module dependency, `tinygo.wasm` build selection, and
`go:embed`. Its complete JSON stream is compared exactly, after path canonicalization, with the
same pinned native `cmd/go`; a merely plausible graph is rejected.

## Browser compiler output contract

A completed producer build must publish exactly:

- `tinygo-compiler.wasm`;
- `tinygoroot.tar.gz`; and
- `producer-receipt.json`.

The compiler can expose the full upstream CLI or a narrow browser adapter. The adapter is not a
language reimplementation: its built package graph must contain upstream TinyGo `builder`,
`cgo/libclang`, `compiler`, `interp`, `loader`, `transform`, and `go-llvm`. Compile protocol v6
writes an ordered `objects/` set and `link-plan.json`: the program object is followed by sorted
target-C and hosted-C++17 ThinLTO bitcode, sorted Clang assembler-with-cpp objects, and
TinyGo-generated embed objects. It also binds exact approved C++ flags, restricted linker flags,
and offline vendoring evidence. The LLD plan inserts the receipt-bound runtime extras before the
target-native set and wasi-libc before embed objects. CGo/native source and dependency identities
are included in the plan. Target-C/C++ entries include exact LLVM toolchain, module-verifier,
triple, data-layout, TLS, constructor/destructor, and forbidden-ABI evidence; assembly entries bind
the relocatable-object profile, linking metadata version, and symbol-table presence. The browser
requires the exact evidence before finishing the link with wasm-llvm raw WASI LLD and Binaryen
`wasm-opt`.

The receipt binds the source-lock digest, source-receipt digest, all three upstream commits,
the upstream package graph, cgo-enabled in-process LLVM C API linkage, and both published output
hashes. The link plan must omit `--thinlto-cache-dir`, which fails with WASI `ENOSYS`. A recorded
version is not accepted as compiler identity on its own.

The checked-in acceptance fixture exercises real CGo, separate target C and hosted C++ files, an
uppercase preprocessed `.S` file, receipt-bound CXXFLAGS/linker flags, `go:embed`, maps, slices, a
struct, a method, an interface, generics, package initialization, a goroutine/channel handoff, and
stdin. A conforming receipt must record the complete object set and
`link-plan.json`, external LLD/Binaryen finalization, and execution output:

```text
hello Ada count=2 total=3 semantics=9/9 cgo=5/20 cxxasm=13
```

To reproduce the public readiness gate, rebuild the bound receipts and run the release verifier:

```sh
pnpm verify:tinygo-artifacts -- \
  out/tinygo-browser/artifacts \
  out/tinygo-browser/tinygo-source-receipt.json
```

The strict verifier validates the Wasm binary, scans it for upstream compiler package identities,
rejects custom `wasmbridge`, `cmd/tinygo-wasi`, `tinygobackend`, and `tinygofrontend` identities,
rejects non-WASI compiler imports, checks the TinyGo root gzip header, verifies every receipt-bound
size and SHA-256, and rejects a receipt without exact acceptance-fixture execution evidence.

The receipt-producing acceptance command is also exposed as
`pnpm accept:tinygo-browser -- <explicit named options>`. Its fail-closed parser requires every
input and output path; inspect `scripts/accept-browser-compiler.mjs` for the current option set.

## Remaining browser work

The compiler-host blockers from the initial audit are closed in the registered patch set. A
pointer-only C ABI layer covers structure-valued libclang calls and cursor callbacks. TinyGo's
GC allocator now supplies aligned allocation and the producer removes WASI libc's `dlmalloc.c.obj`
before final linkage, so a single allocator owns malloc/free paths. The build also uses a pinned
Go 1.24.6 bootstrap patch for unsupported WASI process APIs, synchronous host jobs, an 8 MiB stack,
and external LLD because the native TinyGo distribution's embedded LLD 20 crashes on this link.

wasm-idle now verifies the asset and producer-receipt hashes, extracts the bounded root, mounts
`tinygoroot`, user sources, cache/temp/output, invokes the compiler adapter, validates the exact
runtime/link plan, runs raw WASI LLD and pinned Binaryen 129, and executes the fixture in Chromium.
The producer and consumer each bind their own fixture's exact objects and Wasm. The consumer's
Node and Chromium results match one another byte-for-byte; the producer fixture has distinct source
and artifact hashes and is not incorrectly treated as the same build.

Package discovery is upstream-derived: wasm-idle runs the receipt-bound Go 1.24.6 `cmd/go` WASI
provider over the supplied module workspace and passes its normalized graph directly to the
compiler. Network module resolution remains deliberately disabled; `vendor/modules.txt` selects
the receipt-bound offline vendor mode and other workspaces remain `-mod=readonly`. Compiler,
package-graph, LLD, and Binaryen work runs in a disposable Worker with phase deadlines, abort
termination, and rewritten wasm32 linear-memory maxima.

Compile protocol v6 preserves the earlier embed, CGo/C, and target-native handoffs. Every
preprocessed target-native C, C++, and uppercase `.S` input uses `-Werror=date-time`. `CXXFiles`
are compiled by packaged Clang as C++17 ThinLTO bitcode with the receipt-bound WASI libc++ headers
and linked libc++/libc++abi archives. Exceptions, RTTI, threads, and target/toolchain overrides stay
disabled. LLVM 20.1.1 fully parses and verifies
every C/C++ module, checks the exact `wasm32-unknown-wasi` triple/data layout, and rejects TLS,
pre-initializers/initializers/finalizers, C++ runtime ABI symbols, and target features outside the
consumer's exact allowlist (`+bulk-memory`, `+bulk-memory-opt`, `+call-indirect-overlong`,
`+mutable-globals`, `+nontrapping-fptoint`, `+sign-ext`, `-multivalue`, and `-reference-types`).
C/C++ bitcode containing module/function inline assembly, global aliases, or indirect functions is
also rejected; uppercase `.S` files are the only supported assembly boundary and are compiled in
CGo packages as assembler-with-cpp relocatable WebAssembly objects. The
LLVMObject parser validates linking v2, symbols, and relocations before a policy scan rejects TLS,
initializer/finalizer segments, executable start/export state, shared or 64-bit memory, table64,
unknown memory/table limits flags, multiple imported-plus-defined memories or tables,
memory64/table64 relocations, exception tags, and target features outside that same allowlist. A
bounded Go pre-scan rejects oversized or overflowing u32 LEB fields before invoking LLVMObject.
Lowercase `.s`, non-CGo package assembly, and Go/Plan 9 assembly remain fail-closed. The
adapter sorts native and embed jobs deterministically, preserves
multiplicity, publishes deterministic object names, and binds source, transitive dependency, format,
and object hashes in the link plan. It accepts only policy-safe CXXFLAGS plus library search,
library selection, archive grouping, and mounted `.a`/`.o` linker inputs; all other native flag
semantics fail closed. Assembly inside the pinned GOROOT remains under upstream TinyGo's existing
standard-package intrinsic/replacement path. The browser adapter does not invent a Plan 9 assembler
for source forms that upstream TinyGo 0.40.1 itself does not load.

The checked-in native split-pipeline test proves the backend boundary on the acceptance fixture.
To inspect its explicit-path command surface, run:

```sh
pnpm probe:tinygo-native-split -- --help
```

## Legacy Emception worker

The existing worker synchronization remains available as LLVM infrastructure:

```sh
pnpm sync:tinygo -- out/tinygo-browser/emception.worker.js
```

The upstream URL is not immutable, so a changed response is rejected unless the producer manifest
and patch logic are reviewed together. The generated directory is intended for external static
hosting and is never included in an npm package. These assets do not satisfy the upstream compiler
output contract.
