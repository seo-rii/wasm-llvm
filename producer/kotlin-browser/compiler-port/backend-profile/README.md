# Official whole-program Wasm source profile

This unit separates the selected compiler's full-rebuild Wasm entry from individually pinned incremental-cache and JavaScript executable drivers. It does not build the compiler or establish browser Kotlin support. The remaining stream and shared JavaScript context dependencies are recorded explicitly.

The source identity is Kotlin `4d78aae1e337cd40f69baa865aed950fe807a775`. [sources.lock.json](sources.lock.json) binds the primary closure, 21 candidate files, four declaration splits, the existing backend preparation, and 19 retained boundaries. Each original file is verified with its Git blob, byte length and SHA-256.

Four replacement files preserve these original declarations byte for byte:

- `IrFactoryImplForWasmIC`, its private `signatureForWasmIC` attribute, and the complete `overrideBuiltInsSignatures`, including Wasm/JS builtins branches and file-signature erasure.
- `IrICModule`, `IrICProgramFragment`, `IrICProgramFragments`, and `IrCompilerICInterface` from `CacheUpdater.kt`.
- `SrcFileArtifact` and `ModuleArtifact` from `JsModuleArtifact.kt`.
- `IrModuleFragment.safeName`, the entire `TranslationMode` enum and `fromFlags`, and `WebArtifactConfiguration.translationMode` from `IrModuleToJsTransformer.kt`. Keeping these shared declarations closes the incoming dependency on the otherwise excluded JavaScript executable producer.

The retained bodies use their original package and required original imports. Removed portions are kept as unchanged reference sources under the output's `original/` directory. No placeholder carrier or replacement lowering is introduced.

The 21 exclusions are exact file paths in the lock and receipt, covering the two IC compiler drivers, their cache/readback helpers and the Wasm IC serializers. The actual selected whole-program driver directly generates a `WasmCompiledFileFragment` and `WasmIrModuleConfiguration`; it does not require the IC `WasmIrModule` wrapper. `WasmCompiledFileFragment`, its real `IrICProgramFragment` parent, `FileSignatureRemover`, all common/Wasm lowering sources, the nine Wasm-used JavaScript lowering files, and their phase order remain in the compiler input. The `compileSuspendAsJsGenerator` predicate remains unchanged.

Preparation checks both all 3,417 pinned primary Kotlin inputs and the caller-supplied composed inputs, including the actual prepared backend helper and browser entry. The sealed inventories were reviewed against the selected top-level declaration headers. The reference check conservatively retains matches through qualified names, aliases, package wildcards and same-package identifiers; comments and strings remain visible. It records the coupling graph and strongly connected components among selected files. This is a source-selection guard, not a resolved compiler call graph or completed Gradle/host dependency closure. A newly retained dependency causes a concrete error; the tool does not silently expand the exclusion list.

`IrICProgramFragments.serialize(OutputStream)` and `JsIrProgramFragments.serializeTo` remain real stream dependencies. The shared JavaScript context/AST coupling also remains. Their presence is recorded as unresolved, and compilation readiness stays false.

Call the preparer **last**, after the existing backend and identity preparations and before further compiler-host import adaptations:

```js
import { prepareBackendProfileSources } from './backend-profile/prepare.mjs';

const component = await prepareBackendProfileSources({
  sourceRoot,
  outputRoot,
  preparedBackend: { receipt: backend.receipt, commonSources: backend.commonSources },
  browserEntry: absoluteBrowserCompilerPipelinePath,
  retainedSources: actualSelectedKotlinFilePaths,
});
```

It returns `commonSources`, `replacedOriginalPaths`, `sourceSetExclusions`, `receipt` and `receiptPath`. `sourceSetExclusions` is an array of original logical paths. The composer must disable earlier portable replacements at those paths as well as originals. Files ending in one of those logical paths are checked as sources to be replaced or excluded by this final profile. Every other supplied Kotlin file remains a guarded caller. Each prepared backend file must still match the original backend receipt; a later adapted file must not be relabeled with its previous hash.

To reproduce the recorded source/integrity checks from the repository root:

```sh
node producer/kotlin-browser/compiler-port/backend-profile/probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --composed-baseline out/kotlin-pr-review/composed-source-baseline-8UBmd9.json \
  --output out/kotlin-backend-profile-new
```

The JSON input supplies the actual previous compiler's `retainedSources` and `preparedBackend`. The probe prepares a fresh exact backend snapshot, because the previous composed files may already contain subsequent host import bindings. It then verifies the primary and composed source selection, original-body equality, transitive reference rejection, upstream/prepared-source/receipt mutations, symlinks and preservation of existing output. The output directory must be new. Run long checks with restricted background logs as required by the workspace rules.

`verifyBackendProfilePreparation(directoryContainingReceipt)` rechecks input pins, the actual caller files, extracted bodies and receipt identity. [evidence/source-selection.json](evidence/source-selection.json) and [evidence/guards.json](evidence/guards.json) contain the actual run. Whole compiler compilation and fresh-source browser compilation remain unrun for this profile; their success cannot be inferred from these checks.
