This unit ports the selected official `TypeUtils.java`, `TypeCheckingProcedure.java`, and `TypeCheckerProcedureCallbacksImpl.java` bodies to common Kotlin. It closes the actual `TypeUtils` / `TypeSubstitutor` dependency cycle with the committed [type implementation](../type-implementation/README.md). It preserves their fully qualified names, overloads, virtual instance methods, four sentinel fields, and the genuine default callback decisions.

The source bodies retain nullable and flexible type handling, definitely-not-null and intersection traversal, type parameter bounds, default and substituted types, recursive supertypes, star projections, signed and unsigned numeric selection, corresponding generic supertypes, variance composition, capture callbacks, and equality/subtype checks. Traversal keeps the original cycle guard and reference comparisons. The deliberate `SpecialType` failures and default callbacks returning `false` are original compiler behavior. Compiler assertions remain enabled and the original Java reference runs with `-ea`.

`prepareTypeUtilities(sourceRoot, newOutput)` and `verifyTypeUtilitiesPreparation(prepared)` return three `sourceFiles`, three Java `replacedOriginalPaths`, `propertyAliasImport = "org.jetbrains.kotlin.portable.descriptors.*"`, and one `hostDependencyFiles` entry. The latter identifies an exact copy of the shared assertion source. The full compiler assembler should use its existing shared assertion input instead of adding a duplicate declaration. Preparation verifies 27 original Git blob and SHA-256 pins, three port source hashes, the shared assertion hash, and the frozen type implementation source lock before publishing a new directory.

The Java source labels two parameter-substitution returns `@NotNull` while returning the nullable result of `TypeSubstitutor.substitute`. The common methods return `KotlinType?` to preserve that value without an added null assertion. The refinement callback similarly permits the actual factory's nullable result. Supertypes retain their fresh mutable list/set results. The original package-private callback implementation becomes `internal` in the common compiler module. These decisions appear in [the source lock](sources.lock.json).

The actual JVM differential recompiles six selected original Java classes together, including the three previously ported substitution/projection classes, to close the same dependency cycle on both sides. It executes those originals and the common Kotlin bodies in fresh JVMs with genuine, hash-verified bootstrap type factories, builtins, descriptors, and remaining helper implementations. It also compares the erased APIs, field visibility, and virtual instance methods. Kotlin's two generated `Companion` fields, exact final static bridges, and the callback class's JVM representation of `internal` are separately recorded; the instance algorithms are compared without normalization.

All 205 executed observations matched, including a 12 by 12 equality/subtype matrix, real generic substitution, nullable/flexible/intersection types, numeric expected types, all nine variance combinations, and actual callback clients. Two positive unsigned number-selection cases remain `not-run`: the genuine bootstrap `DefaultBuiltIns` resource set lacks `UInt` and `ULong` descriptors. Their negative lookup behavior was compared, and descriptors were not invented. All nine preparation guards passed without skips. See [the differential receipt](evidence/java-algorithm-differential.json) and [integration ledger](evidence/integration-status.json).

From the wasm-llvm root, first prepare and build the committed type implementation unit, then run:

```sh
node producer/kotlin-browser/compiler-port/type-utilities/prepare.mjs \
  --source-dir out/kotlin-compiler-port/sources --output out/type-utilities-prepared
node producer/kotlin-browser/compiler-port/type-utilities/build.mjs \
  --prepared-dir out/type-utilities-prepared --output out/type-utilities-jvm \
  --type-implementation-prepared-dir out/type-implementation-prepared \
  --type-implementation-build-dir out/type-implementation-jvm
node producer/kotlin-browser/compiler-port/type-utilities/verify.mjs \
  --prepared-dir out/type-utilities-prepared --build-dir out/type-utilities-jvm \
  --output out/type-utilities-verified \
  --type-implementation-prepared-dir out/type-implementation-prepared \
  --type-implementation-build-dir out/type-implementation-jvm
KOTLIN_TYPE_UTILITIES_PREPARED="$PWD/out/type-utilities-prepared" \
  node --test producer/kotlin-browser/compiler-port/type-utilities/integrity.test.mjs
```

Every output directory must be new. Compiler stages run sequentially with heaps capped at 1 GiB, using the full selected compiler source flags, in a restricted background log. Receipts bind the exact flags, commands, source preparations, predecessor artifact, and compiled outputs. Changed originals, port code, shared assertions, symlinks, incomplete indices, or omitted substitution dependency fail verification.

The full compiler assembly must compose these bodies with the genuine `DescriptorUtils` and `KotlinBuiltIns` source-body ports and the remaining selected classic type factories, captured-type helpers, and checker algorithms. This unit supplies their call sites and records their pins; it does not supply substitute helpers. The JVM bootstrap helper source commit is unknown. The differential is a compiler dependency test, and is not selected-source R0/R1 or browser compiler acceptance. The whole Wasm compiler and public language readiness remain false.
