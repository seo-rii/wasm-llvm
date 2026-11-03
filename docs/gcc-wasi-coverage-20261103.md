# GCC/WASI gcov coverage qualification

The source20 GCC 17 profile qualifies explicit coverage for `wasm32-wasi`
programs, using single-threaded, non-atomic counter updates. The compiler host is a separately rebuilt Emscripten
Wasm module. Source20 denotes twenty pinned local patches, not GCC version 20.
The [machine-readable evidence](gcc-wasi-coverage-20261103.json)
records source, compiler, runtime, analysis-tool, input and artifact identities.

| Route | Program cases | Actual executions | Additional controls |
| --- | ---: | ---: | --- |
| Native GCC → Wasm → Node WASI | 28 | 32 | 8 notes/arcs cases, 120 unsupported-option diagnostics |
| Public SDK → Chromium GCC Worker → WASI | 24 | 28 Chromium + 28 same-artifact Node | assembly/object notes, mounts, byte transport, composition and legacy bundle guards |
| Direct Chromium GCC frontend | 8 metadata cases | compile/assemble/inspect | 116 unsupported-option diagnostics; four native driver-only diagnostics are excluded |
| Existing Worker matrix | 1,734 | 1,734 Chromium + 1,734 Node | strict object/ABI/opcode, weak-reference, RTTI, alias and target-feature controls |

The four `--coverage` driver cases are included in the 28 native cases. Browser
SDK compilation calls real `cc1`/`cc1plus` directly, so it does not claim a Wasm
host GCC driver route. Plain controls compile the identical original sources
without instrumentation and produce no profiles.

Coverage requests select GCC's ordinary arc/test-coverage passes. The official
`libgcov-driver.c` and `libgcov-merge.c` objects provide writing and merging;
there is no replacement counter runtime or private binary-format parser.
The Wasm backend does not register general static destructors, so the WASI-only
patch registers official `__gcov_exit` once through libc `atexit`. Later user
exit handlers and C++ destruction execute before that writer. The general
static-destructor limitation remains recorded locally as ARCH-002.

The fixtures check main and classify function counts, branch direction counts,
loop counts, multiple translation units, user exit handlers and C++ destruction.
A core run executes `main` once and `classify` six times; explicitly mounting
its previous profile for a second run doubles the exact counts. Exit fixtures
include a seventh classify call from the user callback/destructor. Both C and
C++ are compiled at O0 and O2. In the public SDK matrix, each execution host
supplies 16 covered runs and 20 official JSON documents.

Raw `.gcno` notes and recovered `.gcda` profiles are preserved byte for byte.
The matching native GCC 17 `gcov-dump` reads them; official
`gcov --json-format --branch-probabilities --branch-counts` produces JSON
format 2 with version word `B70 `, including its trailing space. The analysis
tool identities and corresponding pinned sources/build receipt are packaged as
provenance. The final manifest SHA-256 is `fae8c0c6e546959d6c45a5c754b2d83070b4ac4576de95276c009a55f9d0c6e4`.

The package gate reopens 122 runtime files and 1,620 native coverage files,
verifies exact compile/include/link plans and raw metadata, and reruns the
pinned gcov on private copies of every actual notes/data pair. It compares the
complete normalized JSON and independent counter expectations. Ten tampering
cases exercise compiler hashes, injected includes/libraries, header/sysroot and
archive search roots, merge history, raw profile substitution, JSON source paths
and counts. The actual-evidence gate suite passes 15 tests; the ordinary producer
unit suite passes 140 tests with that optional integration suite run separately.

All 25 inherited native suites retain the prior fixture identities. Their final
inspection reopens 30,527 artifact receipts and verifies 20,685 frozen inputs.
The existing Worker matrix additionally verifies 1,734 programs per execution
host, plus its strict-link, raw diagnostics, mixed weak-reference/RTTI object and
assembler target-feature controls. The final inspection records 1,504 objects,
1,504 WAT artifacts, 382 object signature checks and 979 required-opcode
inspections.

The matching SDK source is commit
`cb162403816453c8cd242e09a8f09a6bb1169f2f`. Its 185 SDK tests and 36 package tests,
isolated builds/type checks and exact offline packed consumer installation pass.
All 366 validated file identities match this commit; the retained evidence
binds the precommit test run and recorded diff to the committed source/dist,
including the sparse test file verified through Git.
The install measures 2,721,254 bytes, 182 files and four packages. The GCC package
grows 11,470 bytes with unchanged file/dependency sets; reviewed byte budgets
increase to 2.5 MiB + 98 KiB for GCC and 40 MiB + 697 KiB aggregate. Actual aggregate installation
is not claimed. New coverage capability omission normalizes to false for old
bundles; ordinary requests retain their prior behavior.

Existing GCC 13.3 and 16.2 x86 bundles remain unchanged. Combined, they pass
eight public SDK Worker compile cases and four actual native ELF stdin/stdout
executions (four compile cases and two ELF runs per bundle). Twenty-four direct
frontend cases cover ordinary compilation, existing `-p`
profiler calls, and gcov counter assembly/original notes. These are existing
frontend preservation checks; no x86 SDK coverage API or profile runtime is added.

The supported profile requires normal termination and an exact writable
`/profile` preopen. Notes and profiles remain tied to their original compilation.
PGO, value/condition/path profiling, atomic updates, info-section streaming,
manual gcov APIs, nested directory creation, host PID semantics and abrupt-exit
profile recovery remain outside the contract. Covered external binary
composition is rejected. See [the implementation and reproduction contract](../producer/gcc-wasi/COVERAGE.md).

Packaging intentionally emits `qualification.status: unverified`; that immutable
manifest is never rewritten. The separate completed host/target evidence above
qualifies its exact assets. No deployment or GitHub PR merge was performed.
