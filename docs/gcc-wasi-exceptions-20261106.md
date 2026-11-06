# GCC/WASI C++ exceptions — issue 66

This work adds an explicit C++ exception profile to the real GCC frontend,
Wasm backend, GNU libstdc++/libsupc++, and native Wasm unwinder. It is a local
implementation in the issue 66 worktrees. Native and Chromium/Node SDK
qualification is complete. The final local evidence is
`out/issue66/final-qualification.json` (SHA-256
`6055c57668164e2a0b6b3be5e514cbe62f66726d5871b609f83a9b1222ffc3ad`).

## Profile

The SDK request opts in with `exceptions: true`. The compiler uses
`-mexception-handling -fexceptions`. The initial qualified profile is ordinary
private memory with modern `try_table`, `catch_ref`, exception references, and
`throw_ref`. It requires an engine that actually executes that instruction path.
Default requests retain their previous options and runtime providers.

The exception profile has three separate static providers:

- `lib/wasm32-wasi-eh/libstdc++.a`
- `lib/wasm32-wasi-eh/libsupc++.a`
- `lib/wasm32-wasi-eh/libunwind.a`

It uses `--wrap=__main_void`, `--wrap=__wasm_call_ctors`,
`--wrap=__wasm_call_dtors`, and `--wrap=exit` for the real GNU uncaught-exception
boundaries. GNU exception matching, allocation, cleanup, `exception_ptr`, and
termination remain GNU runtime behavior. The LLVM unwinder is the exact pinned
WASI SDK archive, including its full license.

Explicit TLS, shared memory, atomics, SIMD, coverage, and embedded debugging are
not admitted in combination with this profile. These combinations require their
own execution qualification. The ordinary profiles remain independently tested.
General mixed-toolchain C++ exceptions and arbitrary host exception
interoperability are not established by this work.

## Implementation

GCC patch 0027 implements the target exception register interface, 32-bit unwind
words and selectors, modern exception instructions, and GNU indexed exception
tables. Per-region exception references preserve rethrows and cleanup resumption.
Resume is represented as an actual throwing call in RTL so GCC cannot infer that
a cleanup-only callee is nonthrowing and remove its caller's catch handler.
Exception specification strings retain token separation for C++98 `throw()`
code in the full GNU library.

Patch 0028 builds the exception-enabled GNU runtime. Its public headers are byte
identical to the ordinary GNU runtime's 862 headers. GNU's static emergency
exception pool is configured through the upstream build option; ordinary
exception objects still use GNU allocation. No arbitrary fixed object-count
limit replaces the allocator.

WABT patch 0006 preserves tag symbols and tag-index relocations for modern and
legacy transport. It validates relocation type, offset, width, symbol kind,
duplicates, and overlaps. Qualification includes separate objects with different
local tag orders so a wrong throw/catch pair cannot accidentally mask a relocation
error. Legacy transport does not enable legacy exception instructions in the SDK.

## Completed native evidence

The current source has 28 GCC patches and six WABT patches. Every result below is
bound to the current compiler/source and actual input bytes:

- The backend compiles 14 fixture programs across 18 translation units and runs
  four actual unwind ABI layout programs. Driver checks include C++98 exception
  specifications and real LLVM unwinder partial links.
- The full GNU exception library builds, with ordinary and exception public
  headers checked for exact equality.
- Forty-six actual GNU/GCC executions pass across `-O0` and `-O2`: 14 backend,
  14 runtime, and 18 library executions.
- Those executions cover ordered handlers, inheritance adjustment, multiple
  translation units, stack cleanup, nested rethrow, exception references,
  `exception_ptr`, repeated allocation, failed RTTI operations, standard library
  throws, signed/unsigned 128-bit and binary128 exception types, and uncaught or
  `noexcept` termination at main, constructor, destructor, and `exit` boundaries.
- Independent reopening rebuilds the full GNU library, reassembles original and
  canonical object representations, and executes fresh and retained programs.
- The frozen production SDK planner compiles and executes the same 46 programs,
  plus a default stdin/stdout control. All 47 retained programs also pass an
  independent execution. This is planner/native evidence, not browser compiler
  qualification. The final candidate matches every plan and all 1,097 native
  sysroot files, with 13 separately qualified atomics, TLS, and coverage files.
- All 29 inherited native regression steps pass, with the separately qualified
  13-case core suite bringing the total to 26 inherited suites. The first run's
  27 successful steps retain their exact reports and 27,691 output-file hashes;
  DWARF and relaxed SIMD pass in a fresh run after correcting the harness's
  required temporary directory. The original failed controller remains failed.
- Seventeen atomics/TLS regression steps and their strict reopens pass, including
  GNU libatomic's 44 executions and GNU TLS's 32 executions. The private TLS libc
  is actually rebuilt against the current inputs.
- The frozen SDK passes 405 tests, 37 package/budget checks, and unchanged plans
  for 968 WASI and 36 x86 requests. A fresh install measures 2,832,114 bytes,
  194 files, and four dependencies. Current x86 GCC 13/16 compatibility passes
  eight Chromium compiles and four native programs plus retained reexecution.
- WABT qualification passes 16 assembler fixtures, nine malformed relocation
  rejections, six linked programs in Node and Chromium Workers, and actual
  reference-object round trips. These assembler/reference results are separate
  from GCC language implementation evidence.

Current local evidence is under `out/issue66/backend/qualification-v2`,
`out/eh-runtime-v2`, `out/issue66/gnu-runtime-work/native-full-v1`,
`out/issue66/gnu-runtime-work/full-reopen-*-v1-result.json`, and
`out/issue66/wabt-qualification-v6`. Failed and interrupted earlier runs remain
preserved and are not counted as passing evidence.

## Completed browser and package qualification

The Wasm-host compiler builds from the same source28 profile. Actual Chromium
compilation and Chromium/Node execution pass all 46 exception cases plus a
default stdin/stdout control. The 47 retained programs also pass independent
execution. Separate object requests cover all 46 exception cases. Four real
Node engine configurations, request rejection, pre-aborted requests, and Worker
disposal controls pass.

All 856 ordinary browser cases, 70 atomics cases, and 40 TLS cases pass with the
new compiler and bundle. Retained-result inspection also passes. The ordinary
cases retain their default requests and contain neither exception nor atomic
instructions. These 1,012 feature cases and the additional default execution
control use the frozen SDK; its 405 files remain unchanged. Existing x86 GCC
13/16 behavior is covered by the separate eight-compile/four-program matrix.

Package v2 completes all native/runtime reopens and preserves 268,085 inputs.
Its 1,110-file sysroot consists of the 1,097 native-plan files and exactly 13
qualified providers. The original package manifest remains `unverified`; the
private status-only qualification candidate has SHA-256
`3d774d4be5fd46af346fdccbb0748b79c37f3c7ff444ff5145ab673bf627e85b`.
The candidate preserves the original bundle's 207 files. Final acceptance
reopens 283,166 file identities and checks the exact source, compiler, fixtures,
archives, headers, licenses, and completed execution evidence.

Failed preparation and aggregation attempts remain preserved. Package v1 failed
while writing a nested provenance path; an actual filesystem regression now
covers that path and exclusive file creation. The first inherited browser
attempt failed before execution because its local dependency alias was missing.
The next attempt completed all 856 cases, then its inspection wrapper rejected
a successful inspector's different JSON format. That controller remains failed;
the final evidence joins its successful execution step with a fresh successful
inspection job and verifies all 2,566 retained output files. The earlier failed
final aggregator is likewise preserved beside the successful final-v3 job.
