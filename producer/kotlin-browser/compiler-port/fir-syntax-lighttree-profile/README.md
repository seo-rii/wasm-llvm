# FIR syntax checkers on the light-tree source host

This component preserves the selected upstream FIR syntax checker family while
removing its unavailable PSI dispatch. It keeps every light-tree and shared
checker method and every reachable checker registration. The sole excluded file
is `FirPrefixAndSuffixSyntaxChecker.kt`; its `isApplicable` starts with
`source is KtPsiSourceElement`, which cannot hold in the existing browser host.

The source identity is Kotlin commit
`4d78aae1e337cd40f69baa865aed950fe807a775`. Preparation verifies all 3,838 primary
Kotlin/Java input pins, including Java and `compile: false` entries, and saves the
19 complete modified/excluded original files. The lock records their complete
top-level declaration inventories and 77 exact, reversible replacement spans.

The coherent change contains the common `FirSyntaxChecker` base, its 17 direct
subclasses, and `CommonExpressionCheckers`. Sixteen subclasses remain, with the
unused PSI type argument/imports and PSI-specific overrides removed. The base
retains its null-source return, applicability check, light-tree dispatch, and
shared-method fallback. `FirAnnotatedBinaryExpressionChecker.hasAnnotatedLhs`
retains the light-tree operand of its original PSI-or-light-tree predicate.
`FirConfusingWhenBranchSyntaxChecker` retains its complete light-tree traversal,
operation classification, Boolean-subject distinction, diagnostic selection,
and offset calculation. The final source count changes by exactly minus one.

The null-PSI reasoning is tied to the actual host, not an assumption that all
syntax checkers are unused. The pinned primary `KtSourceElement.kt` defines
`AbstractKtSourceElement?.psi` as a safe cast to `KtPsiSourceElement`. The selected
host retains a sealed `KtSourceElement` with exactly the final
`KtLightSourceElement` implementation and no PSI implementation. Complete host,
parser, browser entry, pipeline, and four other family consumers are pinned.
The final guard also rejects added source-family constructors, aliases, PSI
implementations, and new checker consumers, including qualified names, aliases,
backticks, literal concatenation, Unicode escapes, and interpolation.

The upstream prefix/suffix checker documentation delegates light-tree affix
diagnostics to `KotlinLightParser`. The browser entry instead uses
`MultiplatformParsing2Fir`. This component does **not** claim affix diagnostic
parity for that parser, a KMP-to-legacy token bridge, or a working full compiler.
It removes only a checker that was already inapplicable to the selected host.

## Composition

Call `prepareFirSyntaxLightTreeProfile` after import assembly and before the
utility/disk/service source profiles, with `sourceRoot`, `outputRoot`, actual
`retainedSources`, the captured `preparedHost`, and `recordedPropertyImports`.
It returns 18 replacement sources, one exact exclusion, and a preparation
receipt SHA-256. Every original selected owner and byte digest is recorded.

Call `verifyFirSyntaxLightTreeFinalSources` with `outputRoot`, actual final
`retainedSources`, and the externally captured `expectedReceiptSha256`. It
rechecks every complete family body, exact assembly imports, physical owner,
required host/entry consumer, original snapshot, and reversible span. It returns
`{ receipt, predecessorRetainedSources }`. Pass only that verified predecessor
view to the existing FIR navigation final guard, which still expects the
original confusing-when and missing-constructor caller bodies. Other final
guards receive the actual current graph. Existing source owners remain intact;
the reverse view does not rewrite their files or the active source map.

## Evidence and limits

The recovered actual `memory-host-whole-1791700702126849235` graph passes
3,524 → 3,523 selection validation. Its original selection restores exactly,
and the existing public navigation verifier passes on that restored view. The
navigation verifier writes output, so the probe gives it a private copied
component and relocates only its five identical-byte owned sources; it never
reruns that verifier against the historical build directory.

The completed selection proof exited 0 in 42.24 seconds. The public guards
exited 0 in 79.69 seconds (two tests, no skips). The completed behavior proof
exited 0 in 72.59 seconds with 60 byte-identical raw records across original
JVM carriers, common JVM, and Node Wasm. The expected output assertions include
one guard suggestion, 24 generic confusing-branch reports, and five annotation
placement reports. No output normalization is used.

See [selection.json](evidence/selection.json),
[integrity.json](evidence/integrity.json),
[differential.json](evidence/differential.json), and
[execution.json](evidence/execution.json). Execution evidence binds completed
private logs/status files and byte-exact successful runner snapshots. An
independent post-run check verified 3,657 current input/artifact/source pins.

Eight focused public negative guards reject a changed receipt, excluded checker
reintroduction, missing host, copied owner, changed applicability algorithm,
unknown import, new source implementation, and interpolated alias consumer.
Eight focused lexical cases exercise conservative reference handling. The
restored positive final guard passes after all mutations.

`runtime.mjs` typechecks the complete original 18-file family on JVM with the
verified compiler bootstrap as a friend dependency. The registration roster is
covered by exact reversible source proof; it names an unrelated checker newer
than that bootstrap and is not claimed as separately JVM-typechecked.

The bounded behavior observer runs the complete retained confusing-when and
annotated-binary objects with explicit source/FIR/type/context/report callback
payload bindings outside compiler packages. It uses genuine pinned legacy
token declarations, tree carriers, and tree helper algorithms. It compares raw
JVM/common-JVM/Node-Wasm output and checks expected diagnostic IDs/counts and
offsets, with positive/negative operators, Boolean/non-Boolean subjects,
parentheses, absent subject types, annotation parent chains, fake kinds, and
missing sources. This is a method-boundary proof: full FIR objects, diagnostic
factories, the other checker algorithms, and a full FIR Wasm closure are not
executed by this observer.

Reproduce the selection proof with `node probe.mjs <fresh-out-directory>` and
the behavior proof with `node runtime.mjs <fresh-out-directory>`. Run public
guards with `FIR_SYNTAX_FIXTURE=<selection-out>/fixture.json node --test
prepare.test.mjs`. `seal.mjs` regenerates the source lock from pinned originals
and the explicitly named failed-build input; it does not establish successful
compiler execution.
