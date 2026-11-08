# Current foundation evidence

The [recorded evidence](evidence/current-foundation-v1.json) covers the complete
prepared entry with its private pre-lowering main-count and signature checks
removed. Official linkage, lowering, DCE, whole-program linking and binary export
retain their exact bodies and order. The request exception scope is unchanged.
The historical raw entry remains an authenticated input to earlier profiles;
the final compiler source is the entire transformed entry.

```sh
node producer/kotlin-browser/compiler-port/official-main-entry/verify.mjs
```

| Observation | Result |
| --- | --- |
| Ordered compiler sources / JVM signature sources | 3,571 / 18 |
| Replaced / added / excluded sources | 1 / 0 / 0 |
| Baseline / current compiler exit | 1 / 1 |
| All diagnostics | 1,250 → 1,250 |
| Production entry diagnostics | 0 → 0 |
| Changed diagnostics outside the entry | 0 |
| Frozen whole-build inputs | 10,225, unchanged |
| Source checks / rejection cases | 34 / 31 |
| Diagnostic checks / rejection cases | 26 / 24 |
| Runtime checks / actual-evidence mutation cases | 78 / 32 |
| Real Kotlin fixtures / recorded commands | 14 / 42 |
| Node executions / fresh offline Chromium Workers | 30 / 30 |
| Runtime inputs / artifacts reopened | 451 / 178 |

The complete one-file inverse equals the qualified post-tower predecessor. Every
other source retains its bytes and selection order. Qualification compares every
diagnostic by logical source, line, column, exact message and multiplicity. The
1,250-to-1,250 expectation and zero entry diagnostics were fixed before execution;
there are no waivers. Compiler/library bytes, heap, deadline and non-source
arguments are also compared against that predecessor. These cascading diagnostics
are not a count of independent defects.

The runtime compiles two complete upstream source files from the pinned candidate:
`JsMainFunctionDetector.kt` and `generateMainFunctionCalls.kt`. No source adaptation
is applied. Their classes are selected through an origin-checked JVM overlay in
the real official compiler. The remaining compiler implementation comes from the
official bootstrap artifact, whose exact source commit is unknown. This observes
the official entry algorithms in a real compiler pipeline without a custom entry
selector, wrapper, parser or execution stub.

Thirteen valid source fixtures produce 26 Wasm files, one from the bootstrap and
one from the pinned-source overlay per fixture. Invalid syntax is rejected by the
actual frontend. With fresh-instance repetitions, the unchanged wasm-idle consumer
executes 30 cases in Node and 30 fresh module Workers in offline Chromium. Raw
results agree between engines and compiler variants, without normalization. The
source-built, ABI-patched WASI stdlib and consumer source are hash-pinned; no argv
or additional WASI imports are introduced.

Cases cover empty arguments, suspend entry, immediate continuation resume,
caught/uncaught exceptions, same-file argument-overload priority, lexicographic
package selection, Unicode stdin/EOF and recovery in fresh instances. Missing or
invalid main, ambiguous suspend/argument entry and same-package duplicate exports
retain the observed official compiler/consumer failures. Such failures are not
counted as supported console programs. Arbitrary external coroutine schedulers
and never-resumed coroutines are not qualified.

This is JVM-hosted compilation of actual user programs followed by Wasm execution.
It does not execute `BrowserCompilerPipeline.kt` or compile Kotlin inside a browser.
The consumer's zero-argument `_start` ABI and the separate request entry metadata
contract remain unchanged. The whole compiler still fails with 1,250 diagnostics;
there is no compiler KLIB or callable browser compiler, and public Kotlin remains
disabled.

The final verifier reopens the actual positional/common source vectors, complete
main → tower → PSI → exception inverse chain, native/module contracts, frozen
inputs and completed test records. It also verifies the actual compiler commands,
class origins, original fixture sources, generated programs, unchanged consumer,
Node/Chromium observations and mutation-test evidence.

Evidence uses immutable absolute owners. After cleanup, restore this proof and
both separately preserved tower/PSI predecessors to their recorded paths before
running the verifier. The preservation manifests and restore guide identify archive
hashes and external cache prerequisites. Restore only missing paths or identical
existing content. Retain fixture-local `.git` data, but do not restore linked
worktree registration or replace differing files or directory symlinks. Shared
compiler, protobuf, JDK, Node, Chromium and source-cache inputs stay at their pinned
locations.
