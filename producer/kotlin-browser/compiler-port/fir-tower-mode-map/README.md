# Private FIR tower mode map

This unit replaces only the private `EnumMap` representation in the complete
upstream `FirRegularTowerDataContexts.kt` at Kotlin commit
`4d78aae1e337cd40f69baa865aed950fe807a775`. It removes `import java.util.*`, changes
two map types to `MutableMap<FirTowerDataMode, FirTowerDataContext?>`, and changes
three constructors to `mutableMapOf<FirTowerDataMode, FirTowerDataContext?>()`.
The full original file and its exact inverse are retained. This is not a general
Java `EnumMap` implementation.

The map is private, never exposed or enumerated, and is used only through indexed
get/set and `putAll`. All six mode keys, nullable values, the original insertion
order, current-context lookup, replacement copies, mode-switch sharing, same-mode
`return this`, and constructor scope forwarding remain byte-for-byte unchanged.
`forCompanionBlock` retains the original special case: a non-null companion block
creates a fresh REGULAR-only object, discarding the other mode values and both
scope fields; a null companion block returns the same object.

`selection.lock.json` records the exact 3,571-source invocation from the qualified
post-PSI foundation (producer base `e4813bff`). It authenticates the whole build
receipt, argument file, evidence, source order, metadata and physical owners.
Exactly one selected file is replaced; no sources are added or removed, and all
18 JVM descriptor-signature sources remain selected. The source lock pins the
full original/transformed files, assembled imports, recipe and verifier inputs.

`prepareFirTowerModeMap` accepts the complete retained selection and a pinned
`preparedPsiViewsProfile` with `sourceRoot`, `outputRoot` and
`expectedReceiptSha256`. `verifyFirTowerModeMapFinalSources` returns a final
receipt and `predecessorRetainedSources`. It restores the single original row in
the complete ordered vector before invoking the existing PSI final verifier.
The existing PSI recipe and hash guards are unchanged. Current-build output
owners use the current repository's PSI module. The exact qualified historical
fixture may use its original snapshot module only after all its dependencies
are authenticated; arbitrary external module owners are rejected.

Regenerate the pins only from the restored qualified predecessor, then run the
focused source guards:

```sh
node producer/kotlin-browser/compiler-port/fir-tower-mode-map/update-recipe.mjs \
  /dev/shm/wasm-llvm-kotlin-fir-psi-20261107/out/fir-psi-whole-v1
node --test producer/kotlin-browser/compiler-port/fir-tower-mode-map/prepare.test.mjs
```

The guard suite uses real predecessor sources and rejects changed original or
transformed bodies, private-map escape/enumeration, nullable-value narrowing,
mode or scope drift, broken sharing/copy/return-this behavior, altered imports,
missing or reordered sources, changed metadata/owners, and receipt tampering.
It records frozen tool inputs and the complete predecessor inverse. Runtime
agreement and whole-compiler diagnostic qualification are separate evidence;
this preparation does not claim a completed compiler, full FIR-to-IR execution,
or public Kotlin support.
