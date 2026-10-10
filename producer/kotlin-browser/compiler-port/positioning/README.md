# Official light-tree diagnostic positioning boundary

This unit prepares the actual Kotlin light-tree positioning algorithms from source commit `4d78aae1e337cd40f69baa865aed950fe807a775` for compiler C. It preserves all 93 source-strategy registrations, including the complete typed `UNREACHABLE_CODE` dispatch. It removes the PSI dispatch and construction boundary, supplies common range/tree carriers, and keeps the original relative-offset calculations, syntax validity checks, traversal, assignment-LHS selection and unreachable-range algorithms.

The pinned new-parser bridge deliberately returns `KOTLIN_DIRECT_PLACEHOLDER` for every node. This unit keeps that behavior. It introduces no new mapping from KMP syntax nodes to legacy tokens and does not claim that the resulting R1 diagnostic ranges match the R0 parser's precision. The complete browser compiler remains not built and public Kotlin readiness remains false.

## Reproducible source preparation

`positioning.recipe.json` records 37 original blobs and four common carrier sources. Thirty original files are supplemental to the existing compiler source closure and are acquired in a separate immutable cache under repository `out/`. JVM PSI factories and lexer helpers remain reference inputs; they are not silently copied into the common source set.

```sh
node producer/kotlin-browser/compiler-port/positioning/fetch.mjs
node --test producer/kotlin-browser/compiler-port/positioning/prepare.test.mjs
```

The APIs for the compiler composer are:

```js
import { preparePositioningSourceCache } from './positioning/fetch.mjs';
import { preparePositioningSources } from './positioning/prepare.mjs';

const cache = await preparePositioningSourceCache();
const prepared = await preparePositioningSources({
  sourceRoot,             // verified official compiler-closure source cache
  outputRoot,             // fresh isolated directory under repository out/
  positioningSourceRoot: cache.positioningSourceRoot,
});
// prepared.commonSources: 23 production files
// prepared.replacedOriginalPaths: five exact compiler-closure paths
// prepared.sourceSetExclusions: seven PSI/factory reference-only paths
// prepared.receiptPath / prepared.receipt: original and generated hashes
```

`preparePositioningSourceCache` uses the fixed commit and exact recipe membership. It rejects redirected downloads, files larger than their locked size, symlinks and changed cache members. It publishes `positioning-cache.json` only after verifying all 30 members. Existing verified source files are never overwritten. `preparePositioningSources` verifies that acquisition receipt and every original and common-source hash before writing a new output. It does not download or mutate either original cache. Output files and the final receipt use exclusive creation.

The Java-to-common declaration conversion preserves token IDs, keyword values and categories, alias identity, token-set membership and legacy node categories. The source-declaration scanner respects quoted semicolons and nested constructor/array expressions. This is a producer transformation of pinned compiler declarations; user Kotlin text is consumed by the official parser.

Nullable child slots and the original `arrayOf(null)` single-child sentinel remain in caller buffers. A small erased generic view passes the same `Ref` object to the official common host interface. Explicit null assertions preserve the original Java-platform null failures; the algorithms' existing safe calls and fallback branches stay in place.

## Comparison boundary

```sh
node producer/kotlin-browser/compiler-port/positioning/build.mjs \
  --output out/kotlin-compiler-positioning-probe
```

The comparison compiles exact original Java token/node declarations and original Kotlin positioning algorithms on the JVM. Its Wasm side uses the prepared common algorithm bodies. It reuses and verifies the earlier official G1 parser JAR/KLIB and syntax artifacts. The range host contract is compared against the hash-pinned bootstrap's relocated IntelliJ `TextRange` class; the bootstrap compiler's source revision remains unknown (`null`).

The isolated comparison omits the real diagnostic-model/factory/source wrappers and the typed `UNREACHABLE_CODE.markKtDiagnostic` method from its Wasm artifact. The production sources retain those methods. It directly compares all selected `mark`/`isValid` methods, range helpers and unreachable traversal/range helpers. It also routes fresh Unicode/CRLF and syntax-error text through the actual official parser and unchanged placeholder bridge. Manual legacy-tree fixtures exercise the range algorithms and are not parser conformance evidence.

The comparison records failures as observed outcomes and keeps unexecuted typed dispatch and R0 precision separate. No replacement diagnostic classes are provided. A slice comparison cannot establish full diagnostic integration or compiler C success. Node Wasm execution is not browser evidence.

Run substantial builds in the workspace's restricted `~/logs` background-log workflow, with at most one component JVM lane capped at 768 MiB. The build script writes a passing evidence receipt only after both JVM observations and actual Wasm observations agree. Partial failures retain their output for diagnosis and publish no passing receipt.

The checked-in [positioning-evidence.json](./positioning-evidence.json) records the actual passing comparison: 5,531 selected observations agree across original JVM, portable JVM and Node 24.1.0 Wasm with `--experimental-wasm-exnref`. They comprise 92 `mark`/`isValid` methods across 26 legacy tree fixtures, 417 range cases, 294 declaration cases, six child-buffer failure/sentinel cases, direct tree/unreachable helpers and three official-parser placeholder cases. The Wasm module is 2,400,338 bytes. The four source-preparation guard tests also passed. Browser execution and typed diagnostic dispatch remain not run.

Final build exit status: `0`. Background log: `/home/seorii/logs/kotlin-compiler-positioning-assertions-3zebbziu.log` (wrapper PID 2624567). Generated JARs, KLIBs, Wasm and source caches remain under `out/` and are not committed.
