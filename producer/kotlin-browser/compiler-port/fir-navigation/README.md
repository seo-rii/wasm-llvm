# FIR LightTree navigation boundary

This unit keeps four complete official FIR source files from Kotlin commit
`4d78aae1e337cd40f69baa865aed950fe807a775`: `SourceNavigator.kt`,
`FirSourceUtils.kt`, `FirKeywordUtils.kt`, and
`FirUnsupportedModifiersInFunctionTypeParameterChecker.kt`. It splits only PSI
branches and declarations made unavailable by the existing pinned source-host
profile. The genuine function-type parameter checker and all of its LightTree
modifier, annotation, keyword and diagnostic-reporting bodies remain selected.
No checker or user-source semantics is replaced with a stub.

The fifth output layers the exact `positioningReceipt` TokenSet predecessor.
`snapshotForSourceTraversal()` copies membership from its existing private
`elements` store. Only the original `types.types.toSet()` expression changes to
this method. Traversal order, depth, reverse order, nonlocal returns, offset
padding, modifier source spans and the fake delegated-accessor filter remain
the official algorithms. Java Ref erasure is bound through the already prepared
`asChildrenRef` adapter, and the original Java platform dereference is explicit.
The prepared positioning `LightTreeUtils.kt` is reused; no second shipping copy
is added.

This is deliberately **not** a portable `TokenSet.getTypes()` implementation.
The genuine JVM API exposes a cached mutable array ordered by global element
registration, including a separate dynamic-or path. The current portable carrier
does not implement that registration mechanism. The selected caller immediately
copies the array to a Set and observes membership only; a general getter, alias,
ordering or cached-array identity claim would be incorrect.

`prepareFirNavigationSources({ sourceRoot, outputRoot, retainedSources,
preparedHost, preparedPositioning })` returns exactly five `commonSources`, four
`replacedOriginalPaths`, one checked TokenSet `predecessorBindings` entry, and a
receipt. Preparation verifies the current host's sealed LightTree-only source
family, the exact predecessor filename/content and current recipe/tool pins. A
compressed snapshot records every actual selected Kotlin input. The four source
bodies and three existing typed traversal callers must match their original
body bytes, allowing only prior import lines and package-header blank lines.
Removed private PSI helper consumers, new typed traversal callers, TokenSet
getter consumers and TokenSet aliases fail closed. The guard is a conservative
lexical scan, not a resolved FIR call graph. `verifyFirNavigation(root)` recreates
the outputs, spans, receipt and caller guard from the frozen inputs and requires
the prepared outputs to remain byte-identical before assembly.

`verifyFirNavigationFinalSources({ profileRoot, retainedSources,
allowedAddedImports })` runs after all components, profiles and entry points are
selected. Assembly adds property and annotation imports to the prepared files
in place. A private replay reconstructs the canonical preparation from immutable
references and the checked predecessor without trusting those mutable outputs.
The final guard verifies every actual selected file and requires the five output
filenames, bodies and existing imports to match that replay. Only explicitly
listed added imports are accepted. The current five canonical files have no
legacy token object-wildcard or static companion imports requiring other import
rewrites. The full caller scan shadows exactly the four replaced originals and
TokenSet with their immutable input bytes; its compressed snapshot still stores
the actual final bytes. A separate receipt records this final graph.

The 30 PSI split, Ref and membership spans have sequential UTF-16 start/end
coordinates and original and replacement byte hashes in
[sources.lock.json](sources.lock.json). Mechanical carrier import bindings are
also bound by the complete output hashes. Eight official
source pins include the existing traversal callers and the actual `butIf` and
`popLast` helper declarations used by the isolated probe. No existing host or
positioning recipe is modified.

The bounded probe typechecks all four complete original JVM files against the
verified bootstrap distribution, compiles the actual pinned original Java token
declarations, and independently executes original traversal, import, modifier
and raw-identifier functions on genuine `KtLightSourceElement`/`FirImport`
objects. Receiver and builder helpers come from the verified bootstrap artifact;
its exact source commit is unpublished. The probe compares exact LightTree method boundaries on original JVM,
common JVM and Node Wasm. Source/FIR receiver fields are explicit payload fixtures
outside the compiler package; they are not substitute FIR descriptors. The
checker probe observes its original annotation and keyword selection expressions;
it does not execute its diagnostic reporter or claim full FIR checker execution.
Actual portable token/carrier bodies and the positioning child-buffer helpers
run in the common artifacts. The public browser compiler remains unavailable:
the existing KMP-syntax-to-legacy-token mapping boundary and full compiler
acceptance are not closed by this unit.

Validation commands (prepared source caches and bootstrap artifacts required):

```sh
node --test producer/kotlin-browser/compiler-port/fir-navigation/prepare.test.mjs
node producer/kotlin-browser/compiler-port/fir-navigation/probe.mjs out/fresh-fir-navigation-probe
```

Completed validation and bounded raw output are preserved in
[evidence/differential.json](evidence/differential.json): 737 observations match
byte-for-byte on original JVM, common JVM and Node Wasm, and 687 independent
checks exercise the original functions with genuine JVM source/FIR objects.
All eleven build/observer phases exited 0. Seven preparation/final-assembly
guards passed without skips, including in-place import additions, late consumers,
changed body/import bytes and an alternate final source filename.

The checked-in evidence preserves the historical runtime receipt unchanged. A
fresh validation seal checks the current preparer against the actual recorded
3,515-file input graph, replaces only the five audited outputs, and applies the
known global imports in place before final verification. This is a focused
assembly validation, not a new whole compiler invocation. The five algorithm
outputs, transformer, probe and observer bytes remain identical to the passed
runtime artifacts; the runtime is not rerun for a receipt-only guard change.
