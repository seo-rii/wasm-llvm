# Compiler keyed registry host port

This unit preserves the official selected-pin `TypeRegistry`, `ArrayMap`, accessor and owner algorithms while adapting the JVM map/counter/synchronization boundary for one serial Worker. It is a compiler dependency, not a Kotlin parser or emitter, and does not mark compiler C built or language readiness true.

`registry.recipe.json` pins all six original files by Git blob, byte length and SHA-256. `ArrayMap.kt` and `ComponentArrayOwner.kt` stay unchanged. The verified transformations replace only the concurrent map and counter imports in `ArrayMapOwner.kt`, the map import in `ConeTypeRegistry.kt`, the map import and synchronized guard in `TypeAttributes.kt`, and JVM class rendering in an `AttributeArrayOwner.kt` error diagnostic. The original getter, registration, accessor, array growth/copy/removal and ID allocation bodies remain intact.

`RegistryHost.kt` provides a real keyed map, wrapping `Int` counter and balanced reentrant ownership for the selected registry operations. Same-key recursive compute fails; callbacks that throw leave no incomplete entry. The original legacy get/check/compute/put-if-absent order is retained, including its callback reentry effects. This is not a general concurrent collection replacement. Cross-thread scheduling, thread visibility and JVM lock contention are excluded; map order used only for diagnostics and JVM class rendering are host-specific.

Type keys remain the official `KClass.qualifiedName!!` strings and explicit string keys. Private/nested/interface and Unicode named classes use the official RTTI implementation; local and anonymous null-name keys retain the original failure. No partial class whitelist, new type ID scheme or reset API is introduced. IDs live only within the owning registry and are not persistent cache or serialization keys. The production compiler profile explicitly enables `-Xwasm-kclass-fqn` for source compilation and binary linking, following the pinned official KClass source; this flag belongs to compiler C, not the user-program profile.

`prepareRegistrySources({ sourceRoot, outputRoot })` verifies every original before creating isolated sources under `compiler-port-registry/`, checks unchanged originals again, and returns `commonSources`, `replacedOriginalPaths`, `requiredFlags`, `receipt` and `receiptPath`. Callers exclude the four replaced originals and retain unchanged ArrayMap/ComponentArrayOwner source paths. A failed preparation never publishes its success receipt and cannot overwrite existing outputs.

Reproduce with:

```sh
node --test producer/kotlin-browser/compiler-port/registry/prepare.test.mjs
node producer/kotlin-browser/compiler-port/registry/build.mjs \
  --output "$PWD/out/kotlin-compiler-registry-probe-reproduction"
```

Use the workspace background log/exit-sidecar procedure for the build. Outputs must be a new directory under repository `out/`; bootstrap artifacts are hash-verified first. The original JVM reference contains only the exact original registry source files, observer, Kotlin stdlib and JDK collection/counter classes at runtime. The full descriptor-dependent `TypeAttributes.kt` is verified and transformed, while the observer instruments only its legacy callback policy; descriptor attribute semantics are not claimed tested here.

`registry-evidence.json` records 34/34 shared cases in original JVM, portable JVM and wasmJs/Node, each observed twice per host. Cases cover exact named FQNs, class/string key equivalence, independent registry and owner lifetimes, live diagnostic map, sparse array growth/copy, zero/one/many owner transitions, defaults/missing accessors, equality hash collisions, callback failure cleanup, recursion, legacy callback reentry, counter wrap and null-name rejection. Six source-integrity tests passed, including oversized/changed source, symlinks, source-cache nesting and output collision.

The omitted-flag experiment also compiles, links and runs successfully in the hash-pinned `2.5.0-dev-10106` bootstrap and yields the same observer results. This observation is recorded rather than inferred from upstream documentation; no claim is made that another compiler build behaves the same. The bootstrap compiler source commit remains unverified/null. The production profile still passes the official flag explicitly. Node 24.1.0 uses the recorded `--experimental-wasm-exnref`; browser comparison is not run for this unit and full compiler C remains not built.

Final PID 2304710 exited 0; its bounded log is `/home/seorii/logs/kotlin-compiler-registry-final-firhphp_.log`. Generated artifacts remain under `out/kotlin-compiler-registry-probe-verified/` and are not source-controlled. The two earlier harness failures are retained in `/home/seorii/logs/kotlin-compiler-registry-differential-51wz3fk8.log` and `/home/seorii/logs/kotlin-compiler-registry-source-flag-o2pj4zkb.log`; they asserted an unverified omitted-flag rejection and published no success evidence.
