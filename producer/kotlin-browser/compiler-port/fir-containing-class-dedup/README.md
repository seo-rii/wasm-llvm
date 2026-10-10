# FIR containing-class declaration deduplication

The pinned providers and resolve modules both publish the same nullable
`FirCallableDeclaration.getContainingClass()` declaration. The official resolve
Gradle module depends on providers, but flattening their sources into one Wasm
compilation introduces conflicting overloads. This unit deletes exactly the
193-byte duplicate from `ResolveUtils.kt`; it retains the complete providers
file and every other byte in the resolve file, including the original notices.
The public package, receiver, return nullability and lookup algorithm stay the
same. There is no replacement FIR implementation.

`prepareContainingClassDedup({ sourceRoot, outputRoot, retainedSources })`
checks the exact primary closure identity, all four source/Gradle pins and Gradle dependency, captures the actual selected
source graph, rejects changed declaration bodies and direct consumers of the
removed JVM `ResolveUtilsKt.getContainingClass` facade, then returns one common
source and `replacedOriginalPaths`. `verifyContainingClassDedup(outputRoot)` is
strict before assembly. After assembly,
`verifyFinalContainingClassDedup({ profileRoot, retainedSources, allowedAddedImports })`
privately replays the immutable preparation and checks the final compiled
source, filename, complete body, declaration uniqueness and permitted import
additions. It supports in-place assembly imports without trusting the modified
output as its canonical reference. The lexical guards are conservative; they
are not a resolved whole-compiler call graph.

The [sealed differential](evidence/differential.json) records a genuine
before/after typecheck. Before removal, both original declarations produce only
conflicting-overload and actual-receiver ambiguity errors. After removal, the
complete providers source compiles and yields the same 768 raw observations as
the exact original resolve declaration, using real library-origin FIR classes,
functions, sessions, module registration and lookup-tag bindings. This checks
canonical class identity, nullable missing results, rebinding, top-level short
circuiting and the required declaration-site module binding. The remaining
`ResolveUtils.kt` algorithms are preserved by byte comparison and are not
executed by this observer.

The same exact helper body produces 5,120 equal JVM and Node Wasm observations
with explicitly named payloads outside compiler packages. That projection
checks only the helper's input boundary; it does not prove the entire FIR object
graph runs on Wasm. Seven integrity tests cover mutated bodies, extra declarations,
direct removed-facade access, imports, references, preparation output, final
filename and final in-place assembly. Full compiler and public language
readiness remain false.

Reproduction (use fresh output):

```sh
node --test producer/kotlin-browser/compiler-port/fir-containing-class-dedup/prepare.test.mjs
node producer/kotlin-browser/compiler-port/fir-containing-class-dedup/probe.mjs out/kotlin-containing-class-proof-unique
```

The probe verifies its recorded 3,508-source failed whole-build receipt and every
actual source file, as well as the source and bootstrap pins. The bootstrap
artifact version is known; its precise compiler source commit is not claimed.
