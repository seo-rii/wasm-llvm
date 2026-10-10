This unit adapts the selected official `core/util.runtime/src/org/jetbrains/kotlin/utils/SmartSet.kt` for the common compiler source set. The authoritative upstream input is Kotlin/JVM, not Java. Its singleton, array, and backing-set representations, threshold of five, insertion order, equality checks, `size` updates, `clear`, `contains`, and specialized iterator bodies are retained exactly.

Preparation makes two mechanical changes: the JVM wildcard import becomes an explicit optional `JvmStatic` annotation import, and `Collections.emptySet<T>().iterator()` becomes a common host adapter. That adapter preserves the observed original empty iterator's `hasNext = false`, `NoSuchElementException` from `next`, and `IllegalStateException` from `remove`. The nonempty backing set iterator remains the actual iterator returned by the source implementation.

`prepareSmartSetSources({ sourceRoot, outputRoot })` returns two `commonSources`, one `replacedOriginalPaths` entry, a receipt, and its path. `verifySmartSetPreparation(prepared)` checks the exact original Git blob and SHA-256, both host transformations, generated common source bytes, helper bytes, complete prepared index, and disabled readiness. The original source cache is never modified. The [source lock](sources.lock.json) also records nine verified selected standard-library collection sources as provenance; the actual JVM and wasmJs bootstrap library artifacts have separate hashes in the execution receipt. This is not a claim that their source revision equals the selected candidate.

The probe compiles the untouched selected source on JVM, the adapted source on JVM, and the adapted source on wasmJs. All compilations retain the selected compiler source flags, with assertions and Wasm array range checks enabled. The same observer exercises empty/singleton/array/set transitions, nullable values, insertion order, duplicate identity retention, equality/hash collisions, boxed numeric boundaries, iterator exhaustion, mutation invalidation, old iterators after `clear`, and 2,048 deterministic add/contains/clear operations. The original and portable JVM erased APIs also match without normalization.

All 81 supported observations matched on original JVM, portable JVM, and the Node v24.1.0 Wasm engine with `--experimental-wasm-exnref`. All nine preparation integrity guards passed without skips. The original KDoc explicitly excludes `remove`, `removeAll`, `retainAll`, and iterator removal. The actual source still returns the backing set iterator at size five or greater, which can permit removal without updating SmartSet's own size. All 42 observations of these unsupported operations matched too, and are recorded separately from supported-operation acceptance. The port does not repair that original behavior or promise a coherent size/view after unsupported removal. Platform exception messages, invalid equality/hash contracts, concurrent access, and reflection of array component types are outside this probe.

The selected compiler test subtree listings inspected here contain no filename matching `SmartSet`; test contents were not searched. This bounded discovery is recorded honestly and is not a repository-wide absence claim or an upstream test-corpus pass. The primary algorithm reference is the exact selected implementation. The new observer is a compiler dependency differential, not a replacement descriptor/type implementation.

From the wasm-llvm root, after preparing the source closure and verified bootstrap artifacts:

```sh
node producer/kotlin-browser/compiler-port/smart-set/build.mjs \
  --source-root out/kotlin-compiler-port/sources --output out/kotlin-smart-set-probe
KOTLIN_SMART_SET_PREPARED="$PWD/out/kotlin-smart-set-probe/compiler-port-smart-set" \
  node --test producer/kotlin-browser/compiler-port/smart-set/integrity.test.mjs
```

Use a new output directory and run long builds in a restricted background log. Compiler stages execute sequentially with a 768 MiB heap cap. Prepared source, JAR, KLIB, Wasm, generated loader, and observation hashes remain under ignored `out/`; bounded receipts are checked in under [evidence](evidence/differential.json). The browser comparison, selected full-compiler R0/R1, browser-hosted compiler, and public Kotlin support remain unrun or false. Node execution is recorded separately from a browser result.
