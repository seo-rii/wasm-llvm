# FIR semantic checkers on the sealed LightTree source host

This profile ports the complete `FirContextualFunctionTypeChecker` and
`FirParenthesizedPackageQualifierChecker` files. The actual `closure-selection-whole`
compiler invocation at `1a6d8a7` selected 3,549 inputs and reported 23 and 8 errors
in these files. Their genuine PSI branches refer to classes excluded by the
existing sealed `KtSourceElement` host, whose only implementation is
`KtLightSourceElement`.

Thirteen pinned reversible spans remove those impossible PSI helpers, dispatch
arms and imports, and bind three types to existing portable tree carriers.
Both checker registrations stay present. The complete checks, feature gates,
error and warning paths, diagnostic IDs and positioning, LightTree recursion,
and all other registry entries remain in their original source bodies. This
profile excludes no source file and supplies no replacement FIR or PSI classes.

Preparation checks all 3,838 primary Kotlin/Java files for declaration and
registration closure, verifies every retained input, and binds thirteen complete
registry, source-host, parser, entry, navigation and positioning boundaries.
`CommonTypeCheckers` remains byte-exact upstream. `CommonExpressionCheckers`
remains the exact current syntax-owned roster, including its existing PSI-only
prefix-checker exclusion. The navigation and syntax source locks are unchanged.

The exported APIs are:

```js
prepareFirLightTreeSemanticCheckers({
  sourceRoot, outputRoot, retainedSources, preparedHost, recordedPropertyImports
})
verifyFirLightTreeSemanticCheckerFinalSources({
  outputRoot, retainedSources, expectedReceiptSha256
})
```

Prepare immediately after syntax preparation, before later profiles that bind
complete source vectors. Both replacements retain every predecessor row field.
The final guard independently reads the actual selected graph and authenticates
the preparation receipt, complete source/import bodies, owners and boundaries.
It returns `predecessorRetainedSources` by reversing exactly two complete rows
while preserving current row order and every other row. Feed that verified view
to the syntax final, then feed its verified inverse to the existing navigation
final. Other final guards continue to inspect the actual graph.

The current proof is sealed in [evidence/selection.json](evidence/selection.json).
Its private completed job records the authentic 3,549-file input vector, the
two-file public positive/inverse proof, reason-matched malformed-input guards,
three focused tests, and the unchanged public syntax/navigation composition.
Navigation's final publication uses a private copy of its five owned outputs;
existing build and historical evidence files are preserved.

The guard suite belongs to a preserved partial job that subsequently failed in
private Kotlin fixture generation. All thirteen guards, three tests and restored
source/composition gates had already passed. The successful successor binds
those exact checkpoints and unchanged production source pins, freshly replays
the public positive and composition, and executes the corrected helper observer.
It does not describe the earlier guard suite as newly rerun.

The bounded runtime observer typechecks both complete original objects on JVM.
It executes the genuine shared explicit-receiver helper and both child-selector
helpers on original JVM, portable JVM and Node Wasm. Its fixture trees implement
the genuine carrier interfaces and use pinned original/generated token
declarations. It checks raw output equality and expected child IDs and offsets.
The checker objects' diagnostics and source-wrapper recursion are covered by
exact source proof, not by this helper observer. Full FIR execution, diagnostic
factory runtime, KMP-to-legacy token mapping and a successful whole compiler
build remain unproved. A subsequent whole invocation must confirm the 31
component errors disappear.

Verify the sealed evidence with `node verify.mjs`. Run the focused public guards
against a fresh private fixture with
`FIR_SEMANTIC_FIXTURE=<fixture.json> node --test prepare.test.mjs`.
`node update-recipe.mjs <immutable-failed-build-root>` regenerates the source
lock from official originals and the actual named failed-build boundaries;
regeneration alone establishes no execution result.
