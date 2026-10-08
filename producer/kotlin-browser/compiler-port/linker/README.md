# Official compiler memory KLIB serialization and linker host

This source port keeps the selected official FIR metadata serializer, common IR serializer,
`JsIrModuleSerializer`, `ModulesStructure`, mandatory dependency generation, inline-body loading,
and linker post-processing. It changes source-path carriers, library lookup and logical output I/O.
It is an internal compiler component. Kotlin language readiness remains false.

The selected source is Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`.
`sources.lock.json` binds each original Git blob/SHA-256 to its generated portable bytes and the
small `patches/in-memory-linker.patch`. `update-patch.py` verifies the existing source closure;
it writes portable upstream copies only under ignored `out/` and leaves originals intact.
`prepare.mjs` verifies, applies and reverses the patch, then asserts the retained core algorithm bodies.

`prepareLinkerSources({ sourceRoot, outputRoot })` returns 21 selected sources plus five common host
files, their hashes and explicit source-set exclusions. Prepare this family and
[`../klib/prepare.mjs`](../klib/prepare.mjs) in separate directories, then combine exact source paths.
The memory KLIB family and [`../host/LibraryPath.kt`](../host/LibraryPath.kt) are required.
Unrelated JVM/native CLI, ZIP, incremental-cache and filesystem-loader shells are excluded.
Only the real manifest-layout declaration is retained from `KlibImpl.kt` in this source variant.

The production boundaries are:

- `MemoryKlibInput(path, files)` receives a canonical absolute virtual path and a bounded,
  hash-verified immutable `VerifiedKlibFileSet`.
- `loadMemoryWebKlibs(configuration, inputs, target="wasm-wasi", friends, included)` keeps the
  official platform/ABI, duplicate-name and Wasm special-compatibility checks. Missing approved
  locations, compatibility problems, duplicate names and skipped special checks fail.
- `serializeModuleIntoMemoryKlib(...)` invokes the official FIR metadata/IR serialization and
  component writers, returning a real `KotlinLibrary`. The initial profile requires empty
  `cleanFiles`; incremental source sessions are excluded, while full rebuild semantics remain.
- `KotlinLibrary.requireMemoryKlibFiles()` exposes its attached immutable output/input index
  for the next verified-memory lookup. A library without that index fails explicitly.
- Original `ModulesStructure` and `loadIrForSingleModule` consume the resulting libraries.
  `ExternalDependenciesGenerator.generateUnboundSymbolsAsDependencies()` and linker
  `postProcess` remain mandatory and unchanged outside the removed incremental-cache argument.

The caller must retain the actual `SingleModuleFrontendOutput` list alongside
`Fir2IrActualizedResult`, then construct official `Fir2KlibMetadataSerializer`.
Discarding the FIR output list would discard the metadata serializer's file inventory.

`MemoryKlibOutput` owns a bounded logical directory, preserves original per-file IR sorting,
big-endian/varint/declaration-ID layouts, nullable-table checks, metadata grouping, manifest
versions and target lists. Writes fail after duplicate/shadow/root-escape/limit errors and
produce no completed library. The result is verified again before it is passed to a reader.
Maximum decoded output is 128 MiB, each file 64 MiB, and files/directories each 16,384.
`MemoryKlibOutputLimits` lets an approved profile tighten those four budgets, and
`KlibWriter.writeIntoMemory(path, limits)` accepts that policy. Raising a budget above the hard
limits is rejected. The unit exercises limit boundaries with small tightened budgets.
These are host policy, not a WasmGC heap limit.

The JVM metadata writer uses locale-sensitive `String.format` for fragment ordinals; this
profile fixes the reference locale to ROOT and emits equivalent ASCII decimal names.
Manifest property text uses the original sorted, UTF-8 Java-properties escaping rules.
Malformed UTF-16 fails, matching the JVM filesystem writer's UTF-8 encoder policy.
JAR `Implementation-Version` is read from real verified bytes; continuations join byte sequences
before decoding, and absent files alone return null. A missing attached index never bypasses
compatibility checking. The bounded reader validates main/extra sections and has explicit
1 MiB manifest, 64 KiB physical line and 16,384-header limits.

`build-probe.mjs` and `browser-probe.mjs` are separate observers, outside production
`commonSources`. They repackage genuine rebuilt stdlib metadata/main/inlinable-IR bytes through
the official selected component writers and compare existing JVM, portable JVM and actual
Chromium Worker output. No fixture code emits FIR, Kotlin IR or user-program Wasm.
The observers deliberately reverse synthetic sort paths before invoking the writer; they preserve
all real table payloads and declaration IDs. They also compare JAR version parsing against
`java.util.jar.Manifest` and exercise finite output/lookup/compatibility guards.

The portable probes use the same selected compiler source build flags as C, including
`-Xname-based-destructuring=complete`. The byte-identical original util-io/filesystem reference
sources mix legacy and new syntax, so that one JVM reference build uses `only-syntax` instead.
All remaining flags, original source bodies and actual commands are recorded in the receipt.
The official bootstrap version is `2.5.0-dev-10106`; its compiler source revision is not proved
equal to the candidate source revision and is never reported as candidate R0.

[The executed receipt](evidence/component-writer-byte-equality.json) records **61/61** required
results: one complete genuine stdlib writer output, 30 JAR manifest cases and 30 host guards.
Original selected JVM, portable JVM and actual Chromium 153.0.8010.12 Worker results matched
every byte of the **12,146,487-byte** observation stream (SHA-256
`dfe7d6984ab5c92f1b99ddeab866df1a8ad83dd0b270f9628e910408a25001a5`).
The main/inlinable IR, metadata, manifest and explicit-directory output are all compared.
JAR differential failures for bare CR and an unterminated continuation were corrected and
retested against the JDK with additional fixtures. Output budgets and poisoned/incomplete outputs,
approved-path lookup, target/platform/ABI rejection and verified JAR-version access are covered.
After hash-verified static preparation, the Worker executed offline with zero external requests
or requests during the probe. The isolated writer Wasm is **1,544,817 bytes**, not a full compiler.
Missing opt-in marker declarations in this isolated component produced warnings from the global
C flag union; the actual feature flags were used and the restricted logs are linked in the receipt.

Reproduce with the verified source cache and official bootstrap artifacts:

```sh
node producer/kotlin-browser/compiler-port/linker/build-probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output out/kotlin-linker-writer-probe
node producer/kotlin-browser/compiler-port/linker/browser-probe.mjs \
  --output out/kotlin-linker-writer-probe
```

Run long commands in restricted background logs as required by workspace rules.
Generated sources, packed KLIBs, Wasm and large snapshots stay under ignored `out/`.
Only bounded evidence is checked in.

Full source → KLIB → IR → program generation and full browser-hosted compiler execution have
not passed. The configuration-driven special-compatibility entry has been source-connected but
is not executed by the standalone writer unit. The writer probe cannot establish those gates
or substitute for semantic language tests. No total browser-memory cap, persistent offline
app shell, performance target or browser matrix is established here.
