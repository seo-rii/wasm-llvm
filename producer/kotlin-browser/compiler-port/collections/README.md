# Official compiler DFS and SmartList host port

This unit translates the selected official compiler's `DFS.java` and
`SmartList.java` into common Kotlin. It supplies real dependencies for the
compiler source build; it does not compile user Kotlin programs by itself.
The browser compiler remains unbuilt and Kotlin language readiness remains
false.

`collections.recipe.json` pins every original by Git blob, byte length and
SHA-256 at Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`.
`prepareCollectionsSources({ sourceRoot, outputRoot })` verifies those original
bytes and the portable sources before publishing an isolated source set under
the repository's `out/`. It returns `commonSources`, `replacedOriginalPaths`,
`receipt`, and `receiptPath`. The source cache is read-only. Output symlinks,
source/output overlap, changed or oversized inputs, and existing output files
are rejected.

DFS keeps the original recursive traversal, visit-before-handler order, per-node
pruning, callback exceptions, handler result, and the later-root behavior of
`ifAny`. The default visited set uses value equality; caller-provided sets retain
their own equality or identity policy. The list-result carrier uses common
`ArrayDeque` instead of JVM `LinkedList`, with the same mutable sequence and
prepend operations. The selected FIR checker's `Graph<T>` remains unbounded.
Its one Java-flexible `afterChildren(current: T?)` override becomes the common
`afterChildren(current: T)` signature; the checker body remains unchanged and
nullable node type arguments remain accepted.

SmartList keeps the original empty/singleton/array representation, capacity
growth, shifted removal, modification count, specialized empty and singleton
iterators, generic list iterator state machine, array-template values, sort and
trim behavior. Common collection base source pins document the actual inherited
`modCount` and `toArray` contracts. The common `sort` API delegates to its same
algorithm through an internal host name because Kotlin's JVM collection mapping
hides Java's `List.sort`; the reference observer invokes the original Java
method through `OriginalCollectionsBridge.java`. These observer bridges do not
replace the implementation under comparison.

The build tool compiles the exact original Java sources and observes them on
JVM, then compiles and observes the portable sources on JVM and wasmJs. Every
Kotlin compilation uses `../build-flags.json`, including the selected compiler's
complete-mode destructuring option. Assertions and Wasm array range checks are
enabled. The shared observer covers traversal order and failures, nullable
graphs, visited equality and identity, all list representation transitions,
iterator invalidation, sort and trim, array-template boundaries, sublist
mutation, and 2,048 deterministic mutation operations. Execution receipts are
published only after all three observations agree.

The recorded run passed all 68 required observations on the original JVM,
portable JVM, and Node v24.1.0 Wasm engine with `--experimental-wasm-exnref`.
The mutation seed is `01234567`. Browser comparison is recorded as `not-run`.
Bootstrap artifacts are hash-verified; their compiler source commit remains
unknown and is recorded as `null`.

Run from the wasm-llvm repository after preparing the pinned source cache and
bootstrap:

```sh
node --test producer/kotlin-browser/compiler-port/collections/prepare.test.mjs
node producer/kotlin-browser/compiler-port/collections/build.mjs \
  --output out/kotlin-compiler-collections-probe
```

Use a fresh output path for each build. Long invocations must follow the workspace
background logging rules. The checked-in execution receipt is
`collections-evidence.json`; generated JAR, KLIB, Wasm and loader files remain
under `out/`.

The observer does not promise JVM reflection-based array component inspection,
invalid typed-array stores, or identical platform sorting comparison schedules.
It records Node's Wasm engine separately from browser execution. A passing
dependency comparison is neither FIR/IR compilation nor browser-hosted Kotlin
language acceptance.
