# Selected Wasm collection consumer bindings

This component replaces two complete, pin-checked Wasm backend sources after
`wasmCollectionsReceipt`. It removes the selected IntelliJ `reverse` import and
lifts that helper's original `map { (k, v) -> v to k }.toMap()` expression into its
only selected call site. `[k, v]` is the positional spelling required by the
compiler's pinned name-based destructuring flag. Structural function-type
equality, map entry order, the last matching signature, and the winning value's
object identity are retained. There is no generic reverse facade.

The declared IntelliJ SDK version is `261.24374.151`, from the Kotlin source
commit's complete `gradle/versions.properties`. Its official tag resolves to
`ec406b27dab3ba8b2b15ae5f3155a114573cbab3`. The complete original
[`util.kt`](upstream/util.kt) is pinned here as reference input, including its
copyright header. The shipping output uses only the selected expression.
The bootstrap compiler's relocated helper is separately compared at runtime;
its IntelliJ source commit and dependency version remain unverified.

The other edits bind the existing `textReceipt` UTF-8 encoder in both sources
and its decoder in `WasmTypeCodegenContext`. The exact original nine-byte loop
still masks seven bits and shifts seven bits nine times. Only its final JVM
String constructor changes to the existing common decoder. Those bytes are all
ASCII, including NUL, so default decoding replacement behavior is immaterial to
that call. The original String encoder's malformed UTF-16 replacement behavior
still matters to both CityHash consumers and is exercised by the probe.

`prepareWasmCollectionConsumers({ sourceRoot, outputRoot,
preparedWasmCollections, preparedText })` returns two `commonSources`, two
`predecessorBindings` to `wasmCollectionsReceipt`, and two `sharedDependencies`
to the existing `textReceipt` API/algorithm. The latter use component-relative
paths `compiler-port-text/CompilerUtf8Api.kt` and
`compiler-port-text/CompilerUtf8Algorithm.kt`. The composer must verify each
existing shared source once and retain it; the component emits neither again.
`verifyWasmCollectionConsumers(outputRoot)` strictly replays immutable originals,
exact dependency source bytes, original helper/version pins, mechanical edits,
and the complete preparation receipt before global import assembly.

Five preparation guards check reversible byte preservation, canonicalization
and tag-loop mutation rejection, output integrity, shared UTF-8 source
duplication/mutation, declared dependency pins, and input/output overlap.
Run them with `node --test prepare.test.mjs` from this directory.

`node probe.mjs NEW_OUTPUT_ROOT` uses the actual recorded 3,505-source failed
compiler graph as provenance. It compiles all nine original selected Wasm IR
type sources, the complete CityHash algorithm, and exact selected caller bodies.
The common probe uses the existing verified bytewriter patch, assertion helper,
CityHash generation, and shared UTF-8 outputs. It compares unnormalized original
JVM, common JVM, and Node Wasm records for canonical identity, entry order,
idempotence, tag bytes, String encoding, CityHash64/128, and List/ String overload
selection. The completed run has 6,140 identical original JVM/common JVM/Node
Wasm records and 3,231 identical genuine-object JVM records; all 14 commands
exited zero. A second JVM observation compiles the complete pinned `IdSignature`
source and uses genuine `CommonSignature` objects, while comparing the actual
bootstrap reverse helper to the declared helper body. A direct Java static call
observes that relocated helper, whose Kotlin metadata retains the upstream
package name.

The generic map receiver and common/Wasm signature payloads are explicit
probe-only boundaries outside the compiler package. Full `getTypes`, the entire
fragment/context, and the full IdSignature graph on Wasm are not executed.
No browser execution, complete compiler build, or public language readiness is
claimed. Runtime evidence and its exact artifact/log pins are recorded in
[`evidence/differential.json`](evidence/differential.json).
