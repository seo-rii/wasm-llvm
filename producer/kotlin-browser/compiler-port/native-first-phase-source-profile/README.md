# Unreachable native first-phase caller

This source profile excludes exactly the complete official
`NativeFirstPhaseLoweringPhases.kt` caller from the browser compiler's Wasm source
selection. It generates no Kotlin implementation, changes no phase algorithm,
and keeps both the upstream original and complete assembled excluded body as
references. The pinned primary closure omits `NativeAssertionWrapperLowering`
and `NativeExportedBridgeCallDispatchLowering`; eight diagnostics in the measured
3,550-file compiler invocation arise from those two imports and their uses.

The file exposes one public entry, `nativeLoweringsOfTheFirstPhase`, and its JVM
facade `NativeFirstPhaseLoweringPhasesKt`; its other three top-level declarations
are private. Preparation verifies the complete declaration inventory, all primary
Kotlin/Java pins, and the actual active compiler-input graph. References to either
entry or facade outside this exact file fail closed, including aliases, backticks,
Unicode escapes, literal concatenation and executable interpolation. This is a
conservative spelling scan, not compiler IR reachability or arbitrary reflection
analysis. The native backend remains unsupported.

Prepare after the distribution and service source profiles, when no further
source selection changes remain. Pass the canonical lowering component and its
externally bound receipt digest. The unchanged public lowering verifier must
first validate all six canonical outputs. Only this exact native caller may be
excluded; its canonical owner, complete body and original upstream source remain
verified.

```js
const loweringPhaseBoundary = { sourceRoot, outputRoot: phaseRoot,
  expectedReceiptSha256: phaseReceiptSha256 };
const prepared = await prepareNativeFirstPhaseSourceProfile({ sourceRoot,
  outputRoot: profileRoot, retainedSources: activeSources,
  preparedLoweringPhaseFactories: loweringPhaseBoundary, recordedPropertyImports });
const actualSources = activeSources.filter(row => !prepared.sourceSetExclusions.includes(row.path));
const final = await verifyNativeFirstPhaseFinalSources({ sourceRoot,
  outputRoot: profileRoot, retainedSources: actualSources,
  expectedReceiptSha256: prepared.receiptSha256,
  loweringPhaseBoundary, recordedPropertyImports });
```

The final verifier preserves complete JSON-compatible row metadata and ordering.
It rejects inactive rows, checks every actual file, requires the exact recorded
vector minus one row, and returns `{ receipt, predecessorRetainedSources }`.
The predecessor restores exactly that verified complete row at its original
position and passes the unchanged six-output phase verifier. Five phase outputs
are actual selected inputs; one excluded canonical output is restored only for
that verifier. Neither the removed caller nor its unavailable native providers
are claimed to compile or execute.

The public phase final and the distribution final receive this verified
predecessor. Other guards receive the actual source graph. For the native JS
output guard, nest `nativeFirstPhaseProfile: { outputRoot: profileRoot,
expectedReceiptSha256: prepared.receiptSha256 }` inside the existing
`verifiedLoweringPhaseBoundary`. Its phase boundary independently reruns this
profile final on the actual graph, then restores the one row only for the phase
checker. Native lexical closure, all 21 native boundaries, four splits, two actual
JS/Wasm bindings, and the module proof continue to bind the actual graph.

Current evidence is [selection.json](evidence/selection.json). The source proof
uses the immutable measured 3,550-file compiler vector, removes one row to 3,549,
and computes a fresh public module reconstruction over those actual 3,549 inputs.
Native early metadata is independently reinspected against its original c677
source/tool pins and current tools; this is explicitly not a replay of complete
early preparation. Failed whole outputs remain unchanged. The public guards
match the intended assertion reasons and restore a positive final. No compiler
or JVM/Wasm runtime execution is added by this source-selection proof.

The previous native phase proof and its 13 guards stay archived under their old
lock, code, execution and raw-output pins. The earlier no-phase proof and 37
guards remain historical. The first 238-second profile test attempt failed
because its restored positive helper omitted the actual source vector; its job
and old test snapshot are retained and are not counted as successful evidence.

```sh
NATIVE_FIRST_PHASE_FIXTURE=<proof-out>/fixture.json node --test producer/kotlin-browser/compiler-port/native-first-phase-source-profile/prepare.test.mjs
node producer/kotlin-browser/compiler-port/native-first-phase-source-profile/verify.mjs
```
