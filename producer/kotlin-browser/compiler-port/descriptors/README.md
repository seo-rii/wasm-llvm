This unit converts 27 unchanged, pinned Java descriptor interface sources through the real JDK Java AST into common Kotlin. The 30 resulting interfaces, one enum, and 188 source methods retain their official fully qualified names. Generated files remain under `out/`; this directory contains the generator, source identities, and actual receipts.

`prepareDescriptorContracts(sourceRoot, newOutput)` and `verifyDescriptorPreparation(prepared)` return `sourceFiles`, `replacedOriginalPaths`, and `propertyAliasImport`. The compiler source assembler replaces the named originals and adds `import org.jetbrains.kotlin.portable.descriptors.*` to callers that use Java getter property syntax. The typed aliases call the actual contract method. They do not implement descriptor behavior.

Java platform types need explicit common contracts. The generated `PropertyDescriptor` overrides the genuine inherited Kotlin `getter` and `setter` properties and supplies typed getter-call aliases. The pinned `Substitutable` adapter returns `T?`, retaining the explicit nullable Java overrides. The visitor contract accepts a nullable visitor and nullable generic return. Existing non-null Kotlin visitor overrides require a guard adapter; Java `Void` requires a common `Nothing?` mapping. Every unannotated reference and collection mutability choice remains in the audit ledger. These are required integration checks, not proven general Java API equivalence.

The completed JVM check compiles the selected original Java sources independently and compares every source method's erased parameters and return type, type-parameter counts, enum ordering, and all four original `isReal` branches. Kotlin adds the standard enum `getEntries` helper; the receipt records that sole additional API. A separate typed probe exercises the original default `validate` body and getter aliases. The JVM dependency types come from the hash-verified bootstrap compiler artifact; its source revision is unknown, so this result is not R0 or R1.

Run from the wasm-llvm root after preparing the pinned source closure and bootstrap cache:

```sh
node producer/kotlin-browser/compiler-port/descriptors/prepare.mjs \
  --source-dir out/kotlin-compiler-port/sources --output out/descriptors-prepared
node producer/kotlin-browser/compiler-port/descriptors/build.mjs \
  --prepared-dir out/descriptors-prepared --output out/descriptors-jvm
node producer/kotlin-browser/compiler-port/descriptors/verify.mjs \
  --prepared-dir out/descriptors-prepared --build-dir out/descriptors-jvm \
  --reference-annotations /path/to/kotlin-annotations-jvm-2.5.0-dev-10106.jar \
  --output out/descriptors-verified
KOTLIN_DESCRIPTOR_PREPARED="$PWD/out/descriptors-prepared" \
  node --test producer/kotlin-browser/compiler-port/descriptors/integrity.test.mjs
KOTLIN_DESCRIPTOR_PREPARED="$PWD/out/descriptors-prepared" \
  python3 -B producer/kotlin-browser/compiler-port/descriptors/generate.test.py
```

Every output directory must be new. Follow the workspace background-log rule for compiler commands. The original Java reference additionally needs the official 3,096-byte `kotlin-annotations-jvm` artifact, because its `ReadOnly` annotation is absent from the bootstrap runtime classpath. Its immutable HTTPS URL and SHA-256 are in `reference.lock.json`; verification rejects other bytes. The verifier performs no network download.

The checked-in receipts were produced by the actual commands, with a 1 GiB compiler heap and smaller sequential JDK tools. Fourteen focused guards passed with no skipped tests. Whole-compiler Wasm compilation remains blocked on actual descriptor implementations, `KotlinBuiltIns`, type-system algorithms, and the platform contracts in [the integration ledger](evidence/integration-status.json). The 54 remaining selected Java files are listed by original path and hashes. Language readiness remains false.
