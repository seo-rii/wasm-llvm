# Browser diagnostic factory source variant

This source-only patch family removes unused JVM/IDE PSI class metadata from four exact files at Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`. It keeps all 943 common, 23 Wasm and three syntax diagnostic registrations. No checker or diagnostic is excluded.

`transform.mjs` deletes only pinned spans: the `KClass` import, `psiType` constructor/property/forwarding arguments, generated PSI class arguments and their unused imports. Every other source byte stays unchanged. Diagnostic names, generic parameters, severity, deprecation feature/pairs, positioning, renderer selection, `on`, `onOrFallback`, effective severity and fallback bodies are retained. The 969 original class bindings remain in [jvm-psi-class-bindings.json](jvm-psi-class-bindings.json), linked to the original file pins by [diagnostic-factories.recipe.json](diagnostic-factories.recipe.json).

The four replacement paths are:

- `compiler/frontend.common/src/org/jetbrains/kotlin/diagnostics/KtDiagnosticFactory.kt`
- `compiler/fir/checkers/gen/org/jetbrains/kotlin/fir/analysis/diagnostics/FirErrors.kt`
- `compiler/fir/checkers/checkers.wasm/gen/org/jetbrains/kotlin/fir/analysis/diagnostics/wasm/FirWasmErrors.kt`
- `compiler/fir/raw-fir/raw-fir.common/gen/org/jetbrains/kotlin/fir/builder/FirSyntaxErrors.kt`

The generated declarations come from the checked-in `gen` files at the selected source pin. The producer does not regenerate diagnostic declarations with a different generator or compiler revision. The original JVM/IDE sources are retained in the verified source cache.

## Preparation and integration

```js
import { prepareDiagnosticFactories } from './diagnostic-factories/prepare.mjs';

const prepared = await prepareDiagnosticFactories({
  sourceRoot: verifiedOriginalClosure,
  outputRoot: freshOutputDirectoryUnderRepositoryOut,
});
// prepared.commonSources: four source variants at the original relative paths
// prepared.replacedOriginalPaths: the four exact original paths
// prepared.sourceSetExclusions: []
// prepared.receiptPath and prepared.receipt: verified source preparation evidence
```

Compose the returned sources after the positioning family, replacing only the four paths above. Their paths do not overlap the positioning family's diagnostic model. `sourceRoot` remains the original selected closure, rather than an already modified source tree. The output directory must be separate from it and have a fresh `compiler-port-diagnostic-factories` child.

Preparation verifies original Git blob, byte size and SHA-256, the selected closure lock, output hashes, deleted-span hashes and the complete class binding ledger. It checks all 3,413 other pinned compile-selected Kotlin files for metadata readers and extra factory constructor callers. Unexpected metadata readers, constructor forms, unbound PSI class literals or genuine PSI types in diagnostic parameters fail preparation. Oversized inputs, altered source bytes, symlink paths and nested source/output caches are rejected before a success receipt can be published.

This variant provides no `psiType` accessor. Any new consumer of that JVM metadata requires a reviewed source-set or API change; it is not replaced with `Any::class` or a fake PSI class. Source-specific precision and all common/Wasm checker behavior still depend on the real compiler source closure.

## Recorded comparison

[diagnostic-factories-preparation.json](diagnostic-factories-preparation.json) records five passing preparation guards and the exact emitted source hashes. [diagnostic-factories-evidence.json](diagnostic-factories-evidence.json) records 1,597 equal JVM observations for the complete selected `KtDiagnosticFactory.kt` and `FallbackDiagnostics.kt` bodies versus the metadata-only source variant.

The comparison uses genuine hash-verified bootstrap diagnostic, context, source, renderer and configuration types. It exercises arities 0–4, typed values, all declared severities, warning-level overrides and suppression, default/override positioning, missing-source fallback, deprecation warning/error pairs, sourceless diagnostics, missing renderers and duplicate registrations. Runtime checks confirm that the selected original retains PSI metadata and the common variant omits it. The actual bootstrap compiler is `2.5.0-dev-10106`; its authoritative source revision remains `null`.

The probe uses the real missing-source sentinel. It does not establish diagnostics or source-range precision for parsed user Kotlin. The generated registration tables are source-verified, but their full FIR-specific runtime is not executed. Full diagnostic Wasm execution and resolved FIR execution remain `not-run`; the browser compiler remains `not-built` and language readiness remains `false`. The unresolved genuine diagnostic support closure includes `java.text.MessageFormat`. No mock compiler models are used to turn this boundary into a Wasm success claim.

Reproduce from the repository root after preparing the pinned source closure and bootstrap cache:

```sh
node --test producer/kotlin-browser/compiler-port/diagnostic-factories/prepare.test.mjs
node producer/kotlin-browser/compiler-port/diagnostic-factories/build.mjs \
  --output out/kotlin-diagnostic-factories-probe-new
```

The JVM pipeline is sequential with `-Xmx768m`, uses the selected compiler source flags and writes JARs and observation payloads only below `out/`. Long invocations should use a private background log and exit sidecar as required by the workspace instructions. A failed pipeline records failure and its last command phase; it cannot publish a passing comparison.
