# Current foundation evidence

The [recorded evidence](evidence/current-foundation-v1.json) covers an actual
3,571-source Kotlin/Wasm compiler invocation with all 18 JVM signature sources
retained. Its five-file inverse matches the qualified predecessor byte for byte,
in order. All 13 compiler/library inputs and non-source arguments also match.

```sh
node producer/kotlin-browser/compiler-port/fir-lighttree-psi-views/verify.mjs
```

| Observation | Result |
| --- | --- |
| Baseline / current compiler exit | 1 / 1 |
| All diagnostics | 1,307 → 1,262 |
| Five transformed files | 52 → 10 |
| Raw new profile diagnostics | 0 |
| Raw new outside-profile messages | 9 |
| Exactly reviewed diagnostic drift / unreviewed new diagnostics | 9 / 0 |
| Genuine FIR/LightTree JVM observations | 226 |
| Original JVM / common JVM / Node Wasm / offline Chromium observations | 434 identical raw records |
| Source / whole-output / diagnostic negative guards | 10 / 3 / 12 |

The original five complete files typecheck on JVM. Runtime execution covers
pinned method bodies and actual source-line, file-entry, tree and token helpers.
The genuine-object agreement uses real FIR declarations, sources, metadata and
default accessors. Getter counters and thrown-object identity checks use explicit
observation payloads. Whole FIR-to-IR lowering and a working browser compiler
have not executed; public Kotlin language support remains disabled.

The nine new messages remain visible in the report. Four unchanged files contain
five already-failing PSI expressions: seven messages change wording or candidate
type, two nullable cascades appear, and five inference cascades disappear. Their
complete site diagnostic counts change from 26 to 23. The exact
[drift lock](diagnostic-drift.lock.json) requires full source identity, expression,
receiver, line/column, existing unsupported-PSI marker, and message multiplicity.
The other 3,566 unchanged files use position-sensitive comparison. No source,
symbol, or compiler invocation was changed to make diagnostics match.

Final reopening authenticates the actual common and positional source vectors,
the five-file inverse followed by the original exception inverse, all retained
JVM/FIR storage contracts, and native/module checks over the actual new graph.
It also reopens raw observations, negative-check inputs and statuses, and the
complete frozen-input/output inventories. The whole compiler's 10,195 recorded
recipe/cache/original inputs were unchanged when execution finished.

The null-source genuine property fixture uses the valid `Library` origin because
the real builder requires a source for `Source` declarations. Its supplemental
receipt binds that constructor condition and the two exact observed offset
bodies, which do not read origin, to the actual runtime output.

The final preservation descriptor records the gzip archive parts and hashes,
the complete member inventory, and any byte-identical cache files reused from
their separately pinned permanent owners. After worktree cleanup, restore every
archived or reused source/output file to its recorded absolute location before
running the verifier. Authenticate the complete archive stream and each reused
file before copying; accept existing destinations only when their hashes match.
Restore missing destinations without overwriting differing files. The historical
predecessor and external source inputs remain separately pinned at their existing
permanent locations. Environment overrides select inputs; they do not relocate
owner paths inside immutable receipts or argument files.
