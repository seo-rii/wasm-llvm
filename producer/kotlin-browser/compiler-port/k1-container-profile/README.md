# K1 reflection container source profile

This unit selects the Kotlin browser compiler source set. It preserves the
originals at Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775` and does not
provide a DI replacement or change user program sources.

The fixed exclusion list is the ten Kotlin files in `compiler/container` and
`PlatformConfigurator.kt`. They implement the K1 reflection container. A
conservative incoming-reference guard must find no consumer before any file is
excluded. An unexpected consumer stops preparation; it cannot enlarge the list
or automatically select a different compiler profile.

Three exact declaration splits close that boundary:

- `PlatformDependentAnalyzerServices`: remove only the `@K1Deprecation` abstract
  `platformConfigurator` property. Keep its complete remaining body, including
  `defaultImportsProvider` and the `LAST` built-ins dependency policy.
- `PlatformSpecificExtension`: keep the exact generic marker declaration and
  separate the reflection resolver's complete trailing declaration/KDoc into
  the preserved original reference. Remove four precisely recorded pure KDoc
  lines containing the removed resolver or the container's generic `resolve`
  name. Other marker documentation and its copyright header remain.
- `DefaultImplementation`: remove one pure KDoc resolver link. Preserve the
  annotation declaration, `KClass<*>` parameter, imports and implicit Kotlin
  annotation target/retention behavior. No target or retention is added.

`ModuleInfo` and `DefaultImportsProvider` must remain selected with their whole
original bodies. The profile does not exclude general K1 APIs, the complete
analyzer services class or any other frontend/backend module.

## Preparation and final compiler composition

Call `prepareK1ContainerProfile({ sourceRoot, outputRoot, retainedSources })`
after all source components have been selected. `retainedSources` must list
**every actual Kotlin compiler input**, including its entry, as
`{ path, filename, bytes, sha256 }`. Every file is read and verified against
that binding. The preparer also verifies all 3,417 original primary Kotlin
inputs against the immutable primary closure and runs the same guard on them.

The result contains:

- `commonSources`: three files at their original logical paths;
- `replacedOriginalPaths`: those same three paths;
- `sourceSetExclusions`: the fixed eleven paths;
- `receiptPath` and `receipt`: complete inventory/snapshot and guard bindings.

Replace those three inputs and exclude exactly the eleven listed candidates.
Preserve any recorded, verified host property imports on the prepared inputs.
After all import binding and entry assembly, call
`verifyK1ContainerProfileComposition({ profileRoot, retainedSources })` on the
**final** compiler source list. This verifies that the excluded inputs were
not reintroduced and that a late component or entry does not reference them.

`verifyK1ContainerProfile(profileRoot)` replays the primary and composed
snapshots, verifies all fourteen complete preserved originals and each prepared
output. `verifyK1ContainerProfileFinal(profileRoot)` independently replays the
final compiler-input snapshot. Compressed snapshots remain in ignored build
artifacts; their inventory and exact compressed bytes are bound by receipts.

Source transforms accept only pinned original bytes, or those same bodies with
genuine, recorded common-host property imports. Every original import must
remain. The exact approved AST property import names are derived from the
pinned JavaProperties recipe; AST class imports are not allowed. Declaration
and body changes fail before preparation. Added imports remain visible to the
incoming-reference guard and are recorded separately.

## Evidence and limits

`check.mjs` binds the already exited whole-compiler invocation's receipt and
argument file, checks every source argument's recorded hash, prepares the
profile, then replays its final compiler selection. `integrity.test.mjs` covers
new consumers through same-package names, qualified names, aliases, wildcard
imports, strings/comments, an inferred `.platformConfigurator` access, changed
input bytes, missing non-K1 contracts and tampered receipts.

The sealed evidence checks 3,417 primary originals and the latest exited
3,515-source AST/diagnostic-DSL compiler invocation. All eleven exclusions have
zero incoming references; the resulting 3,504-source selection passes the
final snapshot replay. The ten integrity tests also replay the older bounded
3,445-source whole build and reject prospective consumers. Actual marker and
annotation runtime observations are **263 identical raw records** across the
three hosts. The actual-source JVM API/metadata/default-import observer has
**10 identical raw records** before and after the split. There is no output
normalization.

To reproduce against an exited build:

```sh
node producer/kotlin-browser/compiler-port/k1-container-profile/check.mjs \
  out/NEW_UNIQUE_OUTPUT \
  out/kotlin-compiler-port/builds/EXITED_BUILD
node --test producer/kotlin-browser/compiler-port/k1-container-profile/integrity.test.mjs
```

The actual retained marker and annotation sources execute on the original JVM,
common Kotlin JVM and Node Wasm. Raw observations cover recursive marker
assignment/identity, constructed annotation equality, its exact `KClass`
parameter and class metadata. JVM source probes also compile the actual
`PlatformDependentAnalyzerServices`, `ModuleInfo`, `DefaultImportsProvider`,
`K1Deprecation` and original `PlatformConfigurator` declarations against the
verified bootstrap dependencies. They compare unchanged JVM API/annotation
metadata, ModuleInfo's actual enum/capability and actual default import behavior.
They do not instantiate a DI container or supply a fabricated implementation.

The guard reuses the source-pinned qualified/import/same-package lexical reader.
Comments and strings stay visible, deliberately allowing conservative false
positives. A separate identifier check covers the removed analyzer member even
when its type is inferred. This is not a resolved compiler call graph or proof
against dynamically constructed reflective names; its evidence applies to the
complete, explicitly bound source inventories. The JVM source probe depends on
verified bootstrap classes whose source commit is unpublished. It does not
claim a complete common analyzer dependency closure, browser execution or a
successful whole compiler build. Public Kotlin language readiness remains
false until the real compiler pipeline is completed and verified.
