# Source-free diagnostic property DSL

The official `compiler/frontend.common-psi` source set combines source-free
diagnostic property registration with PSI metadata providers. The browser source
closure selected the actual common diagnostic factories but missed this DSL
file, leaving `CliDiagnostics` and other retained diagnostic containers unable
to call `errorWithoutSource` and `strongWarningWithoutSource`.

This unit pins the complete 13,740-byte `KtDiagnosticFactoryDsl.kt`, its module
Gradle file, and their official Git blobs at Kotlin commit
`4d78aae1e337cd40f69baa865aed950fe807a775`. It selects the original declarations
of `strongWarningWithoutSource`, `warningWithoutSource`, `infoWithoutSource`,
`errorWithoutSource` and `SourcelessDiagnosticFactoryDelegateProvider` without
changing their bodies or signatures. Each original byte span has its own hash.
The original notice/package and three required imports are preserved.

The delegate still creates the real `KtSourcelessDiagnosticFactory` with
`KProperty.name`, the selected severity, and `container.getRendererFactory()`.
It uses the existing actual `DummyDelegate` and `KtDiagnosticsContainer`.
Renderer lookup remains a function, preserving the upstream lazy initialization
contract. No diagnostic key registry, compiler model, renderer or PSI stub is
introduced by the shipping source split.

```js
const reference = await prepareDiagnosticDslReferences();
const component = await prepareDiagnosticDsl({
  sourceRoot: reference.sourceRoot,
  outputRoot,
});
await verifyDiagnosticDsl(dirname(component.receiptPath));
// Register component.sourceFiles from component.originalSourceRoot with
// compile:false, then add component.commonSources to the compiler inputs.
```

Reference preparation downloads only exact commit URLs and verifies byte count,
Git blob and SHA256 for cached and downloaded files. Preparation rejects source
and output overlap, symlinks and reused outputs. Verification reconstructs the
split from preserved full originals and compares the complete receipt, recorded
declaration spans, tool hash and generated source.

Run integrity guards with
`node --test producer/kotlin-browser/compiler-port/diagnostic-dsl/prepare.test.mjs`.
Run the differential with
`node producer/kotlin-browser/compiler-port/diagnostic-dsl/probe.mjs --output out/<fresh-directory>`.
The probe requires the verified primary source cache, supplemental actual CLI
source cache and bootstrap used by the whole compiler build.

The observer exercises property names including Unicode, severity, repeated
delegate identity, same-name factories with distinct identity, real renderer
map lookup, duplicate renderer rejection, the complete actual CLI container,
lazy renderer initialization, and the actual registered-factory storage.
Original/full common factory bodies also execute diagnostic creation, warning
level overrides and actual rendering on JVM against genuine bootstrap support
whose source commit is unknown. The original JVM DSL binds its PSI import to
the bootstrap's genuine relocated IntelliJ class without changing declaration
bodies.

The Wasm observer uses explicit source projections of the real factory,
severity, renderer and map declarations. It retains their actual constructor,
property, identity and map registration algorithms, plus the whole real DSL,
`DummyDelegate`, container, storage and CLI table. Its projection omits source
diagnostics, effective severity and creation, renderer invocation, context and
MessageFormat rendering. These projected sources stay in the ignored probe
output and never enter the shipping compiler source set. JVM creation/rendering
and Wasm initialization/registration are separate evidence gates; this unit
does not claim complete diagnostic runtime parity or compiler acceptance.

[The captured actual differential receipt](evidence/differential.json) binds
the 67 equal original/common JVM and Node Wasm initialization/registration
observations, the 160 equal original/common JVM creation/rendering observations,
build artifacts, source projections, observer/tool hashes, and completed
exit-zero log/status hashes. The six integrity guards also passed with no skips.

Source-bearing DSL remains a separate gate. Its original `P : PsiElement`,
`P::class` and provider `psiType` are metadata inputs to existing common factory
constructors. A later unit must record exact metadata deletions and adjust only
the first PSI type argument at actual selected declarations in
`CommonBackendErrors`, `IrActualizationErrors`, `IrInlinerErrors`,
`SerializationErrors`, `JsKlibErrors` and `WasmKlibErrors`. Payload types,
positioning strategy, deprecation feature, severity and renderer bodies must
remain intact. None of those source-bearing providers or declarations are
changed by this unit.

Public Kotlin readiness remains false until the complete compiler and offline
browser acceptance gates pass.
