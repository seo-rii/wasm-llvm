This unit ports the actual selected `TypeSubstitutor`, `TypeProjectionImpl`, and required `TypeProjectionBase` algorithm bodies to common Kotlin. All three retain their original fully qualified names, constructors, overloads, and virtual instance methods. A fourth source provides the typed `substitution` getter alias used by existing Kotlin callers.

The port retains projection equality and hashing, variance conflicts, nullability, captured and star projections, annotation filtering, flexible bounds, custom type parameters, enhancements, abbreviations, approximation controls, recursion depth 100, and cancellation propagation. The two original reference-identity comparisons remain reference comparisons. The flexible-type assertion retains the original Java operator precedence and uses the committed enabled compiler assertion host. The cancellation test uses the committed typed marker and classifier, which were independently compared with the original JVM classifier.

`prepareTypeImplementations(sourceRoot, newOutput)` and `verifyTypeImplementationPreparation(prepared)` return `sourceFiles` (four), `replacedOriginalPaths` (three Java inputs), and `propertyAliasImport = "org.jetbrains.kotlin.portable.descriptors.*"`. `hostDependencyFiles` identifies exact copies of the shared assertion and cancellation sources for the standalone differential. The whole compiler assembler should use its existing instances of those shared inputs instead of adding duplicate declarations. Preparation verifies 26 original Git blob and SHA-256 pins, the four port sources, and all three shared host dependency hashes before publishing a new output directory.

The JVM differential compiles the selected original Java bodies separately and executes them and the portable Kotlin bodies in fresh JVMs. Both use genuine hash-verified bootstrap compiler type factories, builtins, and remaining helper implementations. Original Java assertions run with `-ea`; portable compiler assertions remain enabled. The observer compares the erased source APIs and retains instance virtual dispatch. Kotlin adds a `Companion` field and marks its six `@JvmStatic` factory/combine bridges `final`; these recorded JVM differences are normalized only when comparing those exact static methods. Java subclass static-method hiding is not supported by this common compiler API.

The algorithm corpus builds real types through compiler factories. It checks projection equality/hash/refinement, all variance combinations, substitution success and errors, star and identity preservation, generic conflicts, flexible/dynamic/raw/error types, annotations, old and new captured types, definitely-not-null types, enhancements, abbreviations, approximation, chained/context factories, top-level preparation, deep recursion, failing diagnostic rendering, and cancellation. It does not replace the type system with fixture classes.

The actual differential passed all 54 observations, and a separate caller compiled against the portable class metadata passed the typed getter check. Eight preparation guards passed with no skips. The corpus also preserves the selected legacy `FilteredAnnotations.isEmpty` behavior separately from the annotation filtering case; the host port does not repair that upstream behavior. See the [differential receipt](evidence/java-algorithm-differential.json) and [integration ledger](evidence/integration-status.json) for the source, helper, command, API-difference, and unresolved-dependency identities.

From the wasm-llvm root, with the source closure and verified bootstrap artifacts already prepared:

```sh
node producer/kotlin-browser/compiler-port/type-implementation/prepare.mjs \
  --source-dir out/kotlin-compiler-port/sources --output out/type-implementation-prepared
node producer/kotlin-browser/compiler-port/type-implementation/build.mjs \
  --prepared-dir out/type-implementation-prepared --output out/type-implementation-jvm
node producer/kotlin-browser/compiler-port/type-implementation/verify.mjs \
  --prepared-dir out/type-implementation-prepared --build-dir out/type-implementation-jvm \
  --output out/type-implementation-verified
KOTLIN_TYPE_IMPLEMENTATION_PREPARED="$PWD/out/type-implementation-prepared" \
  node --test producer/kotlin-browser/compiler-port/type-implementation/integrity.test.mjs
```

Each output directory must be new. Run compiler operations sequentially in a restricted background log with heaps capped at 1 GiB. The JVM compilation and observer use the selected compiler source build flags; receipts bind those flags and all executed commands. Missing or changed source, prepared code, host dependencies, or incomplete indices fail before acceptance.

This unit does not supply fabricated `TypeUtils` or `KotlinBuiltIns` implementations. `TypeUtils` and `TypeSubstitutor` form an actual dependency cycle; the remaining exact helper bodies and common builtins are required for the full compiler's Wasm build. Kotlin's already selected substitution, captured-type approximation, factories, and type implementations remain real dependencies. The bootstrap helper source commit is unknown. This JVM differential is a compiler dependency test, not selected-source R0/R1, browser compiler acceptance, or public Kotlin support. Browser compiler and language readiness remain false.
