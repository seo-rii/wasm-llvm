# Current foundation evidence

The [recorded evidence](evidence/current-foundation-v1.json) covers an actual
3,571-source Kotlin/Wasm compiler invocation with all 18 JVM signature sources
retained. The complete one-file inverse equals the qualified post-PSI
predecessor in source order and bytes. The compiler, host libraries, heap,
deadline and non-source arguments remain unchanged.

```sh
node producer/kotlin-browser/compiler-port/fir-tower-mode-map/verify.mjs
```

| Observation | Result |
| --- | --- |
| Baseline / current compiler exit | 1 / 1 |
| All diagnostics | 1,262 → 1,250 |
| `FirRegularTowerDataContexts.kt` diagnostics | 12 → 0 |
| Changed diagnostics outside that file | 0 |
| Added / excluded sources | 0 / 0 |
| Source checks / rejection cases | 30 / 28 |
| Diagnostic checks / rejection cases | 26 / 24 |
| Byte-identical records in each of six executions | 19,970 |
| Runtime inputs / artifacts reopened | 454 / 39 |

The runtime compiles and executes the complete original and transformed target
files on JVM, first with explicit opaque identity carriers and then with genuine
compiler `FirSession`, `FirLocalScope` and `FirTowerDataContext` objects. The
transformed file also runs on Node Wasm and an offline Chromium module Worker
with those explicitly opaque carriers. All six raw outputs are byte-identical;
no output normalization is applied. The Wasm runs do not execute the complete
FIR object implementation or establish whole FIR resolution.

The observations cover 768 initial states, 4,608 transitions and 4,608 history
replacements. They check all six modes, nullable entries, context identity,
sharing on mode switches, copies on replacement, same-mode identity, scope
forwarding and the original companion-block reset behavior. The genuine JVM
runs authenticate class origins and carry real local scopes inside contexts.

Qualification reopens every actual baseline and current compiler source and
compares diagnostics by logical source, line, column, exact message and
multiplicity. The required 12-to-zero change and 1,262-to-1,250 total were fixed
before execution. There are no diagnostic waivers. The remaining whole-compiler
errors still prevent a compiler KLIB or callable browser compiler; public Kotlin
execution remains disabled.

The final verifier authenticates the actual common and positional compiler
source vectors, the tower inverse followed by the existing PSI and exception
inverses, all JVM/FIR storage contracts, and native/module checks on the actual
graph. It also reopens the frozen compiler inputs, completed test statuses and
logs, raw runtime outputs, compiler commands and offline-browser evidence.

Evidence uses immutable absolute owners. After cleanup, restore the preserved
new proof and its separately preserved post-PSI predecessor to their exact
recorded paths before running the verifier. The preservation manifest and
restore guide identify archive hashes, members and external cache prerequisites.
Restore only missing paths or accept identical existing contents; never replace
differing files or substitute directory symlinks. Shared compiler, protobuf,
JDK, Node, Chromium and source-cache inputs remain at their pinned locations.
