# Genuine source-map JSON and ECMA foundation

This unit retains every method of the pinned upstream `JSON.kt` and
`ECMA426BasedSourceMapParser.kt`. The JSON host bindings replace seven `Writer`
parameter types with Kotlin `Appendable`, use `StringBuilder` for the local
`StringWriter`, and bind only the floating-number rendering branch to the
already verified `javaDoubleToString`. JSON parsing, insertion order, duplicate
checks, CR/LF positions and UTF-16 escaping remain the genuine algorithms.
The complete ECMA source adds an explicit import for the genuine optional
`JvmInline` annotation; its value classes, contracts, parsing, validation,
scopes, ranges and record identities are retained.

The original ECMA implementation throws `NotImplementedError` for index maps
with `sections`. That original branch is preserved and observed directly. This
unit does not introduce a substitute for it or claim index-section support.
The remaining `SourceMap`, legacy parser, location remapper, builder, file
and debug-output runtime are separate unfinished units. No file/debug method
has been removed from those originals. Complete parser runtime and browser
compiler acceptance remain false.

`prepareSourceMapJsonReferences({sourceRoot, fetcher})` verifies or downloads
the two genuine original files into the default ignored reference cache,
`out/kotlin-source-map-json-reference/sources`. It returns `sourceRoot`,
`supplementalOriginals` and a lock hash. `prepareSourceMapJson({sourceRoot,
outputRoot})` and `verifySourceMapJson` with the additional `receiptPath` use
exclusive generated files under `compiler-port-source-map-json/`. Preparation
returns two `commonSources`, two `replacedOriginalPaths`, the genuine original
pins as `supplementalOriginals`, a receipt, and one `sharedDependencies` entry
for the existing `jsAstReceipt` double formatter. The composer must register
the original supplemental paths before applying replacements, retain the
formatter exactly once, and verify its canonical path, bytes and hash. The
matching Kotlin test libraries are probe dependencies only.

Original source and test paths are proven by 14 compact Git-tree branches
rooted at the primary closure's verified `js` subtree. Each branch is
recomputed as a Git tree; its parent entry and each selected regular file's
blob identity and size must agree. Source contents also match byte count,
SHA-256 and Git-blob hashes. Preparation verifies its own tools, observer
inputs and inherited formatter pins, and compares the entire expected
receipt when replayed. File, receipt, claim, output-path and rooted-source
proof mutations are covered by the integrity checks.

The observer directly runs all 38 original scope/range tests (22 malformed
and 16 successful cases), including their original `kotlin.test` assertions
and source-object identity checks. Only the JUnit discovery annotations and
import are removed, because a generated runner calls every test method.
The check verifies cached original tests in the same reference root as the
production originals, or downloads the exact pinned upstream bytes when absent.
Each run retains all three unmodified test inputs alongside the discovery-bound
copies. Its final missing-cache replay fetched all three tests successfully.
The actual JVM and Wasm Kotlin test artifacts match bootstrap version
`2.5.0-dev-10106`; published SHA-256 values, module variant files and their
stdlib dependency versions are verified. No test assertion is replaced.

Additional observations cover every UTF-16 code unit, surrogate pairs,
malformed JSON and duplicate keys, numeric boundaries and deterministic
decimal strings, mutable map/list aliasing, boolean singleton identity,
ECMA mappings, source-content records, scopes and failure details. Original
JDK, common JVM, Node Wasm and an offline Chromium module Worker execute the
same finite corpus. Exact record and raw failure comparisons retain the
original unsupported-index error. Execution receipts, commands, artifacts,
browser requests and private log/status records are in `evidence/`.

The final profile passes 67,730 exact records, all 38 original tests and
34 exact raw failures in each of the four hosts, with no skips or normalization.
All seven commands and 16 integrity guards exit 0. The 24 runtime artifact
pins and four official test-library/module pins were rechecked against their
actual bytes after completion.

`Appendable` is the explicit synchronous text-output contract here; it does
not emulate Java Writer synchronization, charset conversion, buffering or
flush/close. The tested JSON writers own their local text buffers. Original
recursion and allocation behavior are retained, with no deep-recursion,
maximum-memory, complete parser, source-map builder or whole-compiler resource
acceptance claim.

Run the focused checks with the verified compatible Node executable, following
the workspace rules for private background logs:

```sh
node producer/kotlin-browser/compiler-port/source-map-json/check.mjs
node producer/kotlin-browser/compiler-port/source-map-json/integrity.test.mjs
```

`update-recipe.mjs` regenerates pins from the preserved immutable audit cache;
source or tool changes require repeating the affected checks. The original
JetBrains Apache-2.0 notices and the attribution in upstream test sources are
retained in their verified inputs.
