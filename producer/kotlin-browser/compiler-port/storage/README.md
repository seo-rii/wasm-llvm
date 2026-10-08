# Compiler storage host port

This unit ports the pinned official compiler storage state machines to common Kotlin for one serial Worker. It is a dependency of the browser compiler source build, not a Kotlin compiler implementation or a language readiness claim.

`LockBasedStorageManager.kt` keeps the original lazy/memoized state transitions, recursion detection, post-compute early publication, cached nulls and exception identity, cancellation reset/removal and old-value consistency checks. The original Java flexible interfaces become separate nullable/non-null Kotlin adapters around the same state machines. Default maps reject null keys; supplied maps remain caller-owned. `storage.recipe.json` binds every original Git blob and portable source digest.

The Worker host has one immutable owner and a balanced reentrant lock. It supplies no JVM thread contention, interruption or cross-thread visibility. The actual `NO_LOCKS` policy uses its original empty lock behavior. A typed `ProcessCanceledException` marker preserves class/subclass cancellation classification without providing IntelliJ services. Diagnostic object IDs and JVM stack trace rendering remain host-specific. No registry or counter reset is introduced.

`prepareStorageSources({ sourceRoot, outputRoot })` verifies originals before writing an isolated `compiler-port-storage/` directory, verifies originals again afterward, and returns `commonSources`, `replacedOriginalPaths`, `receipt` and `receiptPath`. Callers exclude the four replaced Kotlin paths from their source set and retain original `storage.kt`. `NoLock.java` is pinned but has no production references in the selected closure; the original common `EmptySimpleLock` policy supplies `NO_LOCKS`.

Reproduce with:

```sh
node producer/kotlin-browser/compiler-port/storage/build.mjs \
  --output "$PWD/out/kotlin-compiler-storage-probe-reproduction"
```

Run long commands with the workspace background log/exit-sidecar procedure. Outputs must be a new directory under repository `out/`. All bootstrap artifacts are hash-verified before compilation. The original reference builds the exact Java/Kotlin sources using only Kotlin stdlib and annotations at runtime; the Kotlin compiler JAR is not used as an application dependency.

The checked-in `storage-evidence.json` records 36/36 exact observer cases shared by the original JVM, portable JVM and wasmJs/Node paths, including cancellation subclass retry, cached failures/nulls, callback reentry and failure cleanup, nullable/non-null adapters, post-compute recursion and `NO_LOCKS`. JVM references run with assertions enabled. Node 24.1.0 requires the recorded `--experimental-wasm-exnref` flag. Browser execution is not run for this dependency comparison; full compiler C is not built and language readiness remains false.

Final comparison process PID 1155627 exited 0. Its bounded log is `/home/seorii/logs/kotlin-compiler-storage-final-nolocks-w7jf251q.log`; generated artifacts remain under `out/kotlin-compiler-storage-probe-complete/` and are not source-controlled.
