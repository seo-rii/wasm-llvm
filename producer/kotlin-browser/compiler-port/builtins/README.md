# Official KotlinBuiltIns common source port

This unit ports the complete selected `core/descriptors/.../KotlinBuiltIns.java` to common Kotlin. It is part of the actual browser compiler source build. It does not compile user programs, provide a substitute type system, or declare Kotlin ready for public use.

The original source revision is `4d78aae1e337cd40f69baa865aed950fe807a775`; its Git blob, byte count and SHA-256 are in `sources.lock.json`. The original Java source is 39,456 bytes, SHA-256 `f950ea25cce69e3ff73f349954c9667ddf4305980aa62403afb807d60ff24fa1`. Ten pinned source files identify the port and the genuine initialization/type helper boundaries. Original cached files remain unchanged.

The common class retains all 168 original methods and its protected constructor. Instance methods remain virtual, the protected initialization/factory hooks remain overridable, and static APIs have JVM bridges for comparison with the original. Seventy explicit Kotlin properties retain Java getter source spellings. Sixty-three are generated from the sealed original method inventory; seven explicit aliases include the existing `builtInsModule` setter. Generation emits sources only under producer `out/`.

Initialization still creates a real `ModuleDescriptorImpl`, initializes it with the real loader's `PackageFragmentProvider`, and configures real dependencies. Explicit externally initialized modules and deferred module computations retain their original behavior. Storage and primitive/class caches use the actual `StorageManager` lazy/memoized functions. Maps retain type/descriptor equality; no identity map is changed to structural equality. The original private EnumMap is only used for enum-key lookup, so it is replaced with a request-local common map without exposing map iteration.

All primitive/nullable/collection/unsigned/function predicates, array element and reverse lookup, generic array/enum construction, annotation/deprecation handling, subtype checks and descriptor traversal remain present. `isBuiltIn` specializes the exact original non-strict parent traversal to a common `is BuiltInsPackageFragment` check, removing its Java `Class.isInstance` boundary. Other descriptor/type helpers remain genuine compiler dependencies and still have to close for Wasm.

`patches/explicit-builtins-loader.patch` changes only dynamic service discovery in the actual `BuiltInsLoader` interface. Before calling `BuiltInsLoader.Instance`, the trusted profile must call `BuiltInsLoader.registerFactory { legitimateLoader }` once. No registered factory is supplied by this unit, no empty provider is returned, and absent registration fails explicitly. The factory and lazy singleton have one compiler Worker lifetime; they cannot be reset after registration or initialization begins. Single-thread lazy execution matches the serialized compiler entry profile. The official loader implementation still has resource/InputStream dependencies; this unit does not hide them. The current frontend's actual KLIB-module initialization uses the preserved `setBuiltInsModule` route.

`prepareBuiltInsSources({ sourceRoot, outputRoot })` verifies every original Git blob/hash, reviewed common source/generator hash, complete method inventory, loader patch application/reverse check and output hash. It returns the two real common sources and exactly two `replacedOriginalPaths`. Root composition supplies the existing compiler assertion helper and common descriptor/type aliases. Invariant assertions follow the enabled compiler policy; JVM reference execution uses `-ea`.

Run preparation guards without starting a JVM:

```sh
node --test producer/kotlin-browser/compiler-port/builtins/integrity.test.mjs
```

Run the bounded, sequential actual Java/common differential with one available JVM lane, redirecting all output to a restricted background log from the start:

```sh
node producer/kotlin-browser/compiler-port/builtins/verify-probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output-root out/kotlin-builtins-probe-new
```

The probe compiles the unchanged selected original Java and this complete common source against verified official bootstrap `2.5.0-dev-10106` JVM descriptor/type dependencies. Those helper binaries are not proved to come from the selected candidate commit. Fresh JVMs deserialize genuine `.kotlin_builtins` resources through the actual `BuiltInsLoaderImpl`, then compare API shape, builtin descriptors, nullable/type predicates, arrays, functions and module/cache initialization. A separate source-typed probe exercises Kotlin getter spellings and factory registration. No fake descriptor objects or stub libraries are used. Only nondeterministic descriptor identity hex in exception messages is normalized; results and predicates are compared unchanged.

The erased API comparison documents Kotlin's extra property methods/companion field and its final `@JvmStatic` bridges. Java subclass static method hiding is outside this common compiler API. Genuine bootstrap `.kotlin_builtins` metadata does not contain unsigned stdlib classes, so positive unsigned/nullable library-type cases remain explicitly not-run; real unsigned name/ClassId mappings and real missing-class behavior are compared.

[`evidence/original-common-differential.json`](evidence/original-common-differential.json) records the actual passing JVM execution: 162 original API records, 10,679 matching observations and the source-typed getter/factory probe. Preparation guards passed 3/3. Twenty-three positive-reference cases remain separately not-run: sixteen unsigned/nullable cases and seven original `getKSuspendFunction` coroutine-package lookups unavailable from the genuine bootstrap metadata. Their actual missing-class error results match, while positive library/type behavior remains unverified. The full regenerated case ledger and observations stay under `out/`, with their hashes bound in the checked-in receipt. The final background process exited 0; its restricted log is `/home/seorii/logs/kotlin-builtins-differential-r2zf5eb4.log`.

The differential receipt is a component result. An actual Wasm build requires the concrete descriptor/type/helper closure, and fresh browser source-to-FIR/IR/program execution remains unverified by this unit. Public language readiness stays false.
