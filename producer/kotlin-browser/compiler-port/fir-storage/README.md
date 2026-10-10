This unit removes the selected FIR2IR/expect-actual cache and IR lock host
boundaries for the serial browser compiler profile. It keeps the genuine
storage, symbol, module, declaration, matching and lazy initialization bodies.
It does not provide a compiler, new descriptors or a user-language emitter.
Public Kotlin readiness remains false.

The preparation verifies the selected Kotlin commit and each original blob,
copies only its owned sources to an isolated `out/` directory, applies a small
checked patch and verifies the resulting hashes. Original source bytes remain
unchanged. `prepareFirStorageSources({sourceRoot, outputRoot})` returns the
concrete common sources and replaced original paths for root assembly.

`SerialFirCacheMap` is a dedicated cache, with an ordinary common hash table
and per-cache entry nodes. It supplies the operations actually used by the
selected files: get/set/put/getValue, putAll, putIfAbsent, getOrPut,
computeIfAbsent and backed read-only Map entries/keys/values. No global object
or source-session registry is added. Normal key equality is retained. Null
keys/values fail, while a null compute result is not installed.

The `getOrPut` callback runs before `putIfAbsent`, so a recursive initialization
that inserts a value wins. This matters for genuine package/module/IR creation.
The actual compute callbacks construct a generated-functions storage or a new
nested map. They do not update the cache being computed. The serial cache
rejects same-cache writes from compute callbacks and releases its reservation
after success, null or failure. JDK bucket-specific outcomes for callbacks
violating its documented no-map-update contract are not a supported API.

Map views remain backed. A weak iterator prefetches its next entry node before
returning the current one, and reads current values when visited. Appends before
the final prefetched node can become visible; appends after its last advance are
omitted. Value replacement does not invalidate iteration. There is no ordering
promise. The differential observer exposed an earlier fixed-length iterator
omitting a generation-time insertion that the original JDK iteration visited.
The corrected iterator visits and binds that insertion in the pinned
`fillUnboundSymbols` control-flow case, and a separate case retains the
end-of-iteration boundary. The selected callers do not remove cache entries or
mutate collection views. Introducing those operations requires a new contract.

`IrLock` remains a per-owner object. Its inline serial scope retains nested
callbacks, exceptions and non-local returns with a `finally` depth restore.
The selected lazy initializer's retry, null and assignment order stays intact.
There is no multi-thread mutual-exclusion or cross-Worker sharing claim.
The directly needed `threadLocal` delegate owns one Worker slot per delegate;
recursive initialization keeps the inserted winner and null values remain
rejected. Its diagnostic text identifies a Worker rather than inventing a
numeric JVM thread id. Slots are fields on the real delegate, without a global
registry. Tests cover fresh-owner and setter isolation; garbage-collection
timing and concurrent Workers are not tested.

The common-member storage is shared only among modules of one platform
conversion; its clone retains the original shallow-copy/filter behavior.
The expect/actual storage is a genuine FirSession component. No cache is moved
to static/global state, and no source-session reuse or registry reset is added.

The checked-in `evidence/fir-storage-differential.json` records 67 observations
executed by the same observer on three implementations: original JDK
`ConcurrentHashMap` plus the three unchanged upstream IrLock/lazy/thread-local
source bodies on JVM, the common port on JVM, and an actual wasmJs binary on
Node 24.21.0. All 67 observations agree, with zero skipped or unrun cases. The
JVM runtime classpath contains the probe and verified Kotlin standard library;
the compiler JAR is used only as a build tool. Seventeen integrity tests pass.

Coverage includes normal equality with colliding keys, null rejection,
compute retry and callback failure, recursive `getOrPut` winners, shallow
filtered copies, backed views and mutation during iteration, nested IrLock
scopes with exception and non-local-return cleanup, lazy initialization order,
and delegate ownership and retry. The original `fillUnboundSymbols` loop is
extracted from its pinned source and its four compiler-specific operations are
parameterized. Its ordinary observer values are not fake FIR declarations or
IR symbols. The raw traces are retained separately from invariant comparison;
all three final executions recorded `fill-unbound:1,2,4`.

The preparation returns twelve common sources and eleven replaced original
paths, plus its receipt. Root assembly can call
`prepareFirStorageSources({sourceRoot, outputRoot})` from `prepare.mjs` and
retain the returned receipt as `firStorageReceipt`. Selected sources, reference
dependencies, closure metadata, patch, adapter and generator are checked before
preparation; source bytes are rechecked afterwards. Output cannot overlap the
original source tree, follow symlinks or overwrite an earlier preparation.

Run from the repository root, using the verified bootstrap cache and selected
source cache already prepared by the root tooling:

```sh
node producer/kotlin-browser/compiler-port/fir-storage/check.mjs
node producer/kotlin-browser/compiler-port/fir-storage/verify.mjs
node --test producer/kotlin-browser/compiler-port/fir-storage/integrity.test.mjs
```

`check.mjs` creates a unique retained directory under
`out/kotlin-compiler-fir-storage/` and prints its path. To rehash every concrete
execution artifact in addition to checking source bindings, pass that path to
`verify.mjs --artifacts <retained-output>`. The final retained run is
`out/kotlin-compiler-fir-storage/final-20261010T193049497285`; background PID
2855268 exited 0, with log
`/home/seorii/logs/kotlin-fir-storage-final-20261010T193049497285.log` and its
sibling `.status` receipt. It includes JVM, common JVM, wasmJs, artifact
verification and all seventeen integrity checks.

Full coupled FIR storage execution, browser execution and the complete offline
compiler remain unrun by this unit. Those require the genuine PSI/JVM facade
and descriptor boundaries in root integration. No substitute compiler types or
user-language emitter are supplied, and `browserCompilerBuilt` and public
readiness remain false.
