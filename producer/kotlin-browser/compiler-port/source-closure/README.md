# Missing official compiler inputs

This supplemental source component selects the omitted `checkers.web.common`
module from Kotlin `4d78aae1e337cd40f69baa865aed950fe807a775`. The real Wasm
checkers depend on its diagnostics and `isEffectivelyExternal` helpers. All 16
Kotlin files are retained, including every checker and the original renderer.
The 30 generated diagnostic registrations lose only unused PSI class metadata,
through the existing exact diagnostic-factory transform. Original class bindings
remain in `web-common-psi-bindings.reference.json`.

The selected CLI-base configuration variant contains the exact original
`DIAGNOSTICS_COLLECTOR`, `ALLOW_KOTLIN_PACKAGE`, and `TEST_ENVIRONMENT` keys and
their extension property bodies. The original sourceless `CompilerConfiguration.report`
body and complete `CliDiagnostics` registrations/renderers are retained. JVM
path/environment and exception/PSI reporting overloads are outside this selected
CLI variant. No diagnostic collector is replaced with a successful placeholder.

Prepare original inputs with the existing source downloader:

```sh
python3 -B producer/kotlin-browser/compiler-port/closure.py prepare \
  --lock producer/kotlin-browser/compiler-port/source-closure/sources.lock.json \
  --output out/kotlin-source-closure-reference
node --test producer/kotlin-browser/compiler-port/source-closure/prepare.test.mjs
```

`prepareSourceClosureReferences({ outputRoot, fetcher })` fetches only the 23
locked official files from their exact commit URLs, verifies cached bytes too,
and publishes its receipt only when all inputs pass. `prepareSourceClosure`
calls it automatically when no explicit source cache is supplied.

`prepareSourceClosure({ sourceRoot, outputRoot })` returns 19 `commonSources`,
the original logical paths, pinned source inventory and receipt. Source inputs
default to `out/kotlin-source-closure-reference/sources`. Outputs are fresh and
remain under repository `out/`. Source bytes, exact extracted declaration bodies,
generator and metadata-transform hashes are verified before publication.

Compose these supplemental inputs before diagnostic renderer preparation. The
renderer component may replace the same logical
`src/org/jetbrains/kotlin/fir/analysis/diagnostics/web/common/FirWebCommonErrorsDefaultMessages.kt`
path; select one final source for that path. Pass this component's verified
`originalSourceRoot` as the renderer's supplemental original source cache.

The component closes missing source inputs, not their remaining host boundaries.
PSI accesses in retained checker implementations still require their real common
source variants. Whole compiler and offline browser source compilation acceptance
remain false until actual complete builds and executions pass.
