# Declared persistent collection dependency

Kotlin's pinned `gradle/versions.properties` selects
`kotlinx-collections-immutable=0.5.1`. Real FIR resolution, checkers and control
flow use its persistent maps, lists and sets. This component selects the actual
published wasmJs variant of that version, preserving its algorithms.

`immutable.lock.json` binds the upstream version declaration, root and target
Maven module metadata, KLIB, POM and published sources archive. The 320,908-byte
KLIB has SHA-256
`903fd0a29036818096ac9d9787d6c911765f20acfd4436f3b23721b61ce40a8d`.
Its manifest reports compiler/ABI/metadata `2.3.0`, `wasm_targets=wasm-js`, and
only the Kotlin stdlib dependency. Release tag `v0.5.1` resolves to
`ad741d1c6c73b7ff13671f2c362dcfe64ef22c04`; this records published source
provenance without claiming independently proved source/binary equality.

`prepareImmutableDependency({outputRoot, cacheRoot, sourceRoot})` revalidates
the source version and all cached/downloaded bytes, selected target variant and
KLIB manifest before publishing a receipt. It returns `libraryPath`, `receipt`
and `receiptPath`. The whole compiler adds that `libraryPath` to its real
compiler-host libraries. Missing cached artifacts are fetched from exact pinned
Maven URLs with bounded reads. The source reference cache is automatically
prepared from exact official source pins when no `sourceRoot` is supplied.

Version numbers alone do not establish compatibility. The real probe compiles
and links a consumer with bootstrap `2.5.0-dev-10106`, then executes it in Node
and an offline Chromium module Worker. It checks persistent snapshots after
builder reuse, vector boundaries, colliding map/set keys, mutation branches,
iteration order, equality and hash values. The legacy APIs exercised are the
ones used by the selected official compiler sources.

```sh
node --test producer/kotlin-browser/compiler-port/source-closure/immutable.test.mjs
node producer/kotlin-browser/compiler-port/source-closure/immutable-probe.mjs \
  --output "$PWD/out/kotlin-immutable-compatibility-new-run"
```

Use private background logs for compilation. The probe writes actual command,
artifact, bootstrap, observer and browser network evidence to `compatibility.json`.
Only this dependency is accepted by those checks. Full compiler and offline
browser source compilation readiness remain false.
