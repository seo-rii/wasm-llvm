This separate unit ports nine official Java interfaces needed by the actual compiler type, receiver, annotation, and overriding code. It adds ten common source files: ten interfaces, two nested enums, one genuine nested default implementation, and typed property aliases. It does not replace type-checking algorithms.

`prepareTypeContracts(sourceRoot, newOutput)` and `verifyTypePreparation(prepared)` return `sourceFiles`, the nine `replacedOriginalPaths`, and `propertyAliasImport = "org.jetbrains.kotlin.portable.descriptors.*"`. These inputs compose with the committed descriptor contracts without replacing or regenerating them. The earlier generator and Java AST reader are hash-pinned build tools.

The real JDK parser resolves every interface type against hash-verified compiler and annotation artifacts. This retains the fully qualified constant types imported through `AnnotationArgumentVisitor`'s wildcard import. Symbol resolution uses the bootstrap JVM reference classes; their source commit remains unknown. The 12 pinned source inputs contain the nine interfaces and the genuine annotation/checker declarations needed to verify the host adapters.

`PlatformToKotlinClassMapper.Default` retains its original immutable empty collection body. `KotlinTypeChecker.DEFAULT` eagerly delegates to the real `NewKotlinTypeChecker.Default` factory. Changed bodies or initializers stop generation. `DefaultImplementation` and both `TypeRefinement` annotations remain present. An unsupported body or annotation never receives a replacement result.

The actual JVM differential compiles the original Java interfaces independently, compares all 46 source method contracts, preserves both enum value orders, and checks the mapper behavior and runtime annotation. It verifies that the default checker is the genuine factory result and compares four real type relations. A compiled typed caller also exercises seven getter aliases. These checks bind the APIs to the genuine bootstrap implementation; they do not build that implementation from the selected source. Java platform and collection mutability choices remain in the integration ledger.

From the wasm-llvm root, with the verified bootstrap cache, original `ReadOnly` annotation artifact described by `../descriptors/reference.lock.json`, and pinned compiler source closure already prepared:

```sh
node producer/kotlin-browser/compiler-port/type-contracts/prepare.mjs \
  --source-dir out/kotlin-compiler-port/sources --output out/type-contracts-prepared
node producer/kotlin-browser/compiler-port/type-contracts/build.mjs \
  --prepared-dir out/type-contracts-prepared --output out/type-contracts-jvm
node producer/kotlin-browser/compiler-port/type-contracts/verify.mjs \
  --prepared-dir out/type-contracts-prepared --build-dir out/type-contracts-jvm \
  --output out/type-contracts-verified
KOTLIN_TYPE_CONTRACTS_PREPARED="$PWD/out/type-contracts-prepared" \
  node --test producer/kotlin-browser/compiler-port/type-contracts/integrity.test.mjs
KOTLIN_TYPE_CONTRACTS_PREPARED="$PWD/out/type-contracts-prepared" \
  python3 -B producer/kotlin-browser/compiler-port/type-contracts/generate.test.py
```

Each output directory must be new. Compiler operations follow the workspace background-log rule and run sequentially with heaps capped at 1 GiB. The committed receipts record actual successful commands. Twelve focused source, code-generation, and integrity guards passed with no skips. Outputs and compiled reference tools remain under `out/`.

The real common type closure must provide `KotlinBuiltIns`, the actual type constructors, substitution and checking implementations, and the pinned annotation definitions. The [integration ledger](evidence/integration-status.json) lists the 45 remaining selected core-descriptor Java sources by path and hashes. This unit has no standalone Wasm build with fabricated types. Browser compiler and public Kotlin readiness remain false until the official compiler path is built and tested in the browser.
