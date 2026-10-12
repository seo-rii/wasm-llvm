The complete pinned `compiler/frontend.common/src/org/jetbrains/kotlin/util/metadataHelpers.kt` is retained. Only its `java.util.*` import and private `EnumMap<LanguageVersion, MetadataVersion>(LanguageVersion::class.java)` initializer change: the latter becomes `mutableMapOf<LanguageVersion, MetadataVersion>()`. The map is private and read only with `getValue`; no enum-map traversal or mutation API is exposed.

All 18 table assignments, the first four versions' shared `oldMetadataVersion` reference, the exact `MetadataVersion.INSTANCE` entry, completeness check, `LanguageVersion.toMetadataVersion()` and configuration default/explicit override function remain byte-identical. This component does not correct or broaden adjacent metadata compatibility behavior.

`prepareMetadataVersionHost({ sourceRoot, outputRoot })` replaces exactly one original logical source with no helper addition. Preparation preserves the complete original snapshot and returns an externally pinned `receiptSha256`. The final verifier requires that digest, exact body and selected physical owner; it accepts only precisely recorded assembly imports. Integrity tests replay all 3,533 files from the immutable receiver/predicate whole-build invocation, preserve every other row and order, and reject forged bodies/receipts/snapshots/imports, missing/duplicate/relocated owners and overlapping/reused roots.

The differential first recompiles full original/common metadata helper sources together with genuine full `LanguageVersionSettings.kt`, `BinaryVersion.kt`, `MetadataVersion.kt`, `CommonConfigurationKeys.kt` and original/common configuration implementations. Remaining JVM language/config dependencies come from the SHA-verified bootstrap, whose source commit is unknown. IntelliJ's key import in the original configuration is relocated to the verified bootstrap package; reference bodies remain intact.

Additional scoped JVM/Wasm evidence executes the complete common helper and genuine existing metadata/config bodies in namespaces outside compiler packages. Its language version enum/interface, two configuration keys and two accessors are exact declaration projections from pinned genuine files. Its language/API settings inputs are typed probe-only classes outside compiler namespaces. This does not execute full language feature resolution or establish that full compiler dependencies have been ported. The complete helper is never reduced to a method projection or replaced with an expected-output emitter.

Observations cover all 18 mappings, 324 shared-reference pairs, stable/old-version reference identity, default/configured/explicit language selection, five real metadata overrides including strict semantics and invalid version, configuration-copy identity, non-MetadataVersion fallback and null setter rejection. Raw original JVM/common JVM/isolated JVM/Node-Wasm outputs must match exactly. Browser execution and a full compiler build remain unverified. Sealed evidence records actual commands, selected owner pins, completed private logs and supervisor exit status.

Run with Node 24 from the repository root using fresh directories under `out/`:

```sh
node producer/kotlin-browser/compiler-port/metadata-version-host/check.mjs out/kotlin-metadata-version-runtime-NEW
node producer/kotlin-browser/compiler-port/metadata-version-host/integrity.test.mjs out/kotlin-metadata-version-guards-NEW
```
