# GCC/WASI C++20 timezone database — issue 85

This implementation restores the real GNU libstdc++ timezone database in the
ordinary and exception-enabled private-memory runtimes. It also corrects the
Wasm member-function-pointer ABI used by GNU's timezone initialization. The
compiler, both GNU libraries, and package use the same complete source29 pin.

## Data and runtime contract

`producer/gcc-wasi/tzdb.lock.json` pins GNU's `tzdb.cc`, its public-domain
`tzdata.zi`, and the narrow single-thread cache patch. The database version is
2026b. The 107,518-byte data file has SHA-256
`e500467b589740d2c0311c844896f2f3727ffc4baff7e82d65d0f8c1e7e6f0c1`.
GNU's upstream `--with-libstdcxx-zoneinfo=static` option embeds it in the actual
library object. Guest timezone files and network access are unnecessary.

Database updates require updating the pin, rebuilding both libraries, and
repeating their execution qualification. `current_zone()` uses GNU's UTC
fallback when supported guest timezone files are absent; it does not discover
the browser or host timezone. Leap-second behavior follows the pinned database,
including its fixed expiry, rather than predicting future leap seconds.

The first admitted profile uses private memory without user TLS, shared memory,
or threads. Errors that throw require the existing explicit C++ exception
profile. The cache patch uses ordinary accesses only when GNU's thread support
is disabled. The original threaded atomic implementation and public
`std::atomic` behavior remain intact.

## Compiler correction

The initial real GNU metadata program compiled and linked with source28, then
trapped in both Node WASI and the Chromium GCC Worker. GNU's initialization sorts
timezone links through a member-function projection. A focused reproducer
showed that an odd Wasm table index was misread as the virtual-dispatch marker:
`std::invoke` of a `string_view`-returning member function trapped at index 1 and
succeeded at index 2 at both O0 and O2.

Patch `0029-wasm-member-function-pointer.patch` places that marker in the
adjustment word. The earlier eight focused source29 programs passed, including aggregate
returns, projections, virtual dispatch, inheritance adjustment, and null member
pointers. That native compiler also passed all 13 core programs. This ABI
change requires the GNU archives and browser compiler to use the same source29
profile; old archives cannot qualify the final package.

## Execution and package gates

The timezone fixtures contain six families at O0 and O2: database metadata,
system-time queries, local-time gaps/folds, aliases, typed errors, and leap-second
behavior. Ten programs use the ordinary runtime and two use the exception
runtime. Historical 2024 query expectations have an independent Python/TZif
oracle; its newer database is not substituted for the shipped GNU data.

The producer verifies the pinned data inside the actual `tzdb.o`, extracts and
compares that archive member, and inspects the object for atomic instructions
and unresolved atomic helpers. Native qualification uses the frozen production
SDK plans. Its reopener checks exact input identities and the merged sysroot,
recompiles the eight member-pointer and twelve timezone programs, compares their
bytes, and independently executes retained timezone programs.

Packaging requires both full GNU runtime builds and this execution proof before
advertising `capabilities.timezoneDatabase`. The SDK validates that capability
and the actual library provider. Default compiler arguments do not change.
The original package remains `unverified`. Browser qualification uses a
separate private candidate whose only manifest change is its status; the
candidate preserves every original bundle asset.

Failed source28 native/browser runs and unsuccessful aggregation attempts remain
in the earlier `wasm-llvm-tzdb-85-20261106` worktree. They are diagnostic history,
not successful qualification for this corrected producer.

## Historical native execution and corrected source pin

The earlier compiler had 29 GCC patches and six WABT source patches. Fresh WABT
native and Wasm-host builds and both full GNU archives were executed there. The ordinary
library passed its five existing tests and a separate real timezone metadata
test, including 341 zones, 257 links, 27 leap seconds, and the UTC fallback.

That merged sysroot contained exactly 1,097 files from base WASI, the
ordinary and exception GNU libraries, and the current GCC resource headers.
All eight member-pointer programs and all twelve timezone programs passed with
that sysroot. Independent reopening recompiled and executed both matrices,
compared fresh program bytes, and executed the twelve retained timezone
programs again. Its report remains in the earlier worktree at
`out/issue85/native/full-v1-reopened.json`.

The earlier timezone report is `out/issue85/native/full-v1/qualification.json`, SHA-256
`4e9dbc646ee41f70bee22c14438c8f1339efd5ee81d880422ffc3e7762a83a6b`.
The member-pointer dependency is
`out/issue85/pmf/native-pmf-final-v1/qualification.json`, SHA-256
`b93e59188c59b6fbc708b4d8b952d489695fa8e98dd200b2083c9fe45dad357e`.
These reports establish the functional correction. Their old complete source
lock prevents admitting them as final evidence for this worktree.

The earlier WABT binaries had the correct component source but a receipt bound
to the previous complete source lock. The native exception aggregate rejected
that receipt. Fresh builds produced different bytes, so the first GNU builds
remain historical and both final GNU variants use the fresh tools. The original
core13 report used to start that independent browser compiler remains unchanged;
a second core13 run with current WABT passes and produces identical final Wasm
programs. Explicit transition receipts preserve the earlier tool bytes and
separate historical readiness from current-tool qualification.

The inherited coverage suite then caught a second metadata defect: adding patch
0029 had left `gcc.sourceDiffSha256` at the source28 value. The actual compiler
already used source29. The corrected aggregate pin is
`ecc42c806a08d113fa150bca2e9fbb3d0f4099dd9e4eccf691a4539212cf0ce8`;
the corrected complete lock has SHA-256
`112744067248f1198e7f337cc1e9448701c4d3d72a190bb965f6029dd7a1a294`.
`prepare-source.py` now checks both GCC and WABT aggregate pins before applying
patches, using an isolated Git index and object database. Regression tests reject
a stale GCC pin and confirm that valid checks preserve the original source,
index, and object inventory. The actual GCC and WABT source checks also pass.

The current producer is `wasm-llvm-tzdb-85-pins-20261106`. New build receipts and
execution proofs are generated here; old receipt hashes are never rewritten.
Packaging must independently reopen the full exception build and execution and
the timezone proof. Those expensive replays run once during actual packaging.

## Current corrected-pin validation

The corrected producer has completed the actual native and browser compiler
builds. Both WABT builds and their 16 assembly fixtures, 9 malformed cases,
6 Node/Chromium programs, and 4 explicit reference records pass. The native
compiler's 13 core programs and the ordinary GNU library's 5 existing tests plus
the separate timezone metadata test also pass.

The current timezone report has SHA-256
`4c4951e987bef345a91efdf634458e23fbc3fa683c4f5fe98ba6a26d50a6b1d4`.
It records all 12 programs, including 10 ordinary and 2 exception cases. Its
8-program member-pointer dependency has SHA-256
`1ae286afb99fafae547737a3ebede0508035d10d897795ba39e13bbb74d44bba`.
The real exception runtime also passes all 46 native, runtime, and library
programs. These results use the same current compiler, libraries, and complete
source lock.

All 29 inherited native qualification steps are now covered by 27 preserved
successful steps and 2 fresh successful steps. The first DWARF attempt stopped
at its Chromium temporary-path guard; its failure remains unchanged. The two
remaining steps were run with a short private `/data` temporary directory. The
completion receipt independently binds the actual plans, reports, 1,311 frozen
inputs, and retained outputs.

Read-only GCC source aliases exposed two additional path checks: libatomic's
license reopener compared a logical source path with the Python builder's
physical path, and the TLS builder made the same comparison at its source
identity guard. Both now resolve the intended `work/gcc` source. Exact path and
content rejection for unrelated inputs remain enforced. The production
regression suites pass 22 and 9 tests respectively.

Neither changed helper is reachable from the 29 native command dependencies.
An explicit reconciliation verifies the two exact changes, all other 1,309
frozen inputs, 93 scripts, 8 resolved dynamic imports, and 29,116 output files.
It preserves the original records and does not claim any new program execution.
The EH aggregate was regenerated with the current helper using the production
writer's stored-input and artifact checks. Its fresh compiler replay remains a
mandatory package operation.

The full 17-step atomics/TLS qualification was then executed again with the
current helpers and passed. Package boundary tests pass 170 cases with one
optional test skipped. SDK production files remain frozen at 406 files; its
418 tests, install-size budget, and x86 compatibility checks remain valid.

Actual packaging completed its eleven independent replay stages, including the
full GNU exception rebuild and execution and the timezone/member-pointer proof.
All 97,958 package inputs remained unchanged. The original manifest has SHA-256
`7ae67b8241ca7338ffc68a9d058a56d3245fd78199fdbbc25872efa190bf7136`.
The private qualification candidate preserves all 223 original bundle files;
its only manifest change is the qualification status. This is local execution
evidence, not a published compiler release.

The PR's complete producer contract suite passes 498 tests, with five optional
external-artifact tests skipped. The inherited EH fixture now explicitly
requires the timezone-enabled GNU archive and rejects missing or false timezone
metadata. Apart from that test fixture and this report, the copied production
implementation remains byte-identical to the qualified source worktree.

## Completed browser qualification

Actual Chromium GCC Worker compilation and Chromium/Node execution pass all
1,032 feature cases: eight member-pointer, twelve timezone, 46 exception, 856
inherited, 70 atomics, and 40 TLS cases. The exception cohort also passes its
default stdin/stdout control. Independent reopening passes for every cohort.
Four Node exception-engine configurations and the TLS lifecycle, engine, and
nonisolated-request controls also pass.

The actual frozen SDK planner passes all 47 native exception/default cases.
Its plans match the private candidate and the complete 1,110-file sysroot. Old
source28 member-pointer artifacts are rejected. The candidate manifest has
SHA-256 `35a215d2cfb6ceba22a116235a5397652e47c20e0e83818aacf4961ea0bedbb4`.

The SDK PR retains the exact GCC source, tests, and generated module bytes used
in those executions. Its current-main generated runtime data differs only for
TeaVM/C# and their shared indexes; no GCC asset row changes. Fresh package and CI
checks cover the current-main composition and reviewed install-size budgets.

Preparation failures remain separate from successful executions. The first
package preflight used an obsolete argument-file name; the first browser
controllers used stale admission expectations or lacked engine settings. The
first TLS controller stopped before running a case because its provenance list
named three obsolete launchers. A separate runner records the three tools
actually used and passes all 40 cases and their independent reopening. Earlier
failed controllers remain failed, and completed cohort files are unchanged.

Temporary replay outputs are retained in hash-verified persistent archives
without removing the original outputs, earlier compiler caches, or historical
failed results. The unchanged final validator reopens 125,879 file identities
and passes every source, package, native, SDK, and browser contract. Its final
report is `out/issue85/pr-finalization-v1/qualification-final-v1.json`, SHA-256
`3efe804e3de0ec216a7c005cd4b7a0af13eade1c62eefcc38ee3f08cfbbac4e3`.
All inputs remain unchanged, and historical evidence is not counted as current
execution.
