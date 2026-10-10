# Official DescriptorUtils common source port

This unit ports all seventy static algorithms from the selected `core/descriptors/.../resolve/DescriptorUtils.java` into common Kotlin. It serves the actual descriptor/builtins/type/visibility compiler SCC; it provides no replacement descriptor implementations or separate Kotlin emitter.

Original source revision: `4d78aae1e337cd40f69baa865aed950fe807a775`. `DescriptorUtils.java` is 28,336 bytes, Git blob `e58676e36e52583dddc50e2c6650e610dea38df8`, SHA-256 `feece34e34774197e55fb7d93816779581f00c36a105859878ca4da0b6f645dd`. `sources.lock.json` binds original sources, complete method inventory, every selected parent caller, common output, JVM adapter and the one caller patch. Originals remain unchanged.

FQ names, real containing module/package/class lookup, direct/transitive subclass and type-constructor equality, class-kind/modality/visibility predicates, annotations, default constructor visibility, initializer decisions, member lookup and source-file rules retain the original algorithms. Fake override/substitution unwrapping retains the actual first override, empty-override failure and multiple-override stopping rules. Override collection keeps the original linked postorder for `getAllOverriddenDescriptors`; `getAllOverriddenDeclarations` retains unordered set semantics. No recursive compiler algorithm is replaced with a stub or presumed result.

The complete selected source scan finds three actual `DescriptorUtils.getParentOfType` caller files: six calls in `DescriptorVisibilities.java`, one in `KotlinBuiltIns.java`, one in `ReflectionTypes.kt`. The first two frozen common ports already use the exact subtype checks. `patches/typed-parent-caller.patch` replaces only the remaining `PackageFragmentDescriptor::class.java` call with the legitimate `DescriptorType.PACKAGE_FRAGMENT` key.

`DescriptorType` has a private constructor and four explicit keys for the exact selected descriptor kinds: class, visibility, package fragment and builtins fragment. Each performs its actual Kotlin subtype cast. Parent traversal preserves null handling, strict versus non-strict start, nearest matching ancestor and subclass matching. There is no name-string check, dynamic unknown-key fallback, or permissive result.

Two PSI `getParentOfType` APIs also appear in the scan (`PsiIrFileEntry.kt` and `LoopExpressionGenerator.kt`); they belong to different IntelliJ/PSI APIs. This unit neither rewrites nor certifies them. Future Java callers outside the selected closure require their own actual typed binding and remain an integration gate.

`prepareDescriptorUtilsSources({ sourceRoot, outputRoot })` emits three common sources under producer `out/`: the complete utility class, the typed keys, and the patched official `ReflectionTypes.kt`. It reports original replacements for `DescriptorUtils.java` and `ReflectionTypes.kt`. The existing compiler assertion helper and generated descriptor property aliases are supplied by root source composition. No JVM reflection is emitted for parent traversal.

Only `jvmAdapter: true` emits the real original `Class.isInstance` traversal overloads from `JvmParentAdapter.inc`, allowing genuine precompiled JVM helper classes to resolve their existing method references during differential comparison. This separate JVM output also retains `javaClass` in one assertion message. The common assertion uses actual `KClass` text instead; its class predicate and failure remain unchanged, but its host-specific class-name text is not claimed equivalent until Wasm execution. The adapter is not part of C's common source set.

Run preparation and tamper guards:

```sh
node --test producer/kotlin-browser/compiler-port/descriptor-utils/integrity.test.mjs
```

With one coordinated JVM lane, run sequential actual Java/common comparison capped at 768 MiB, redirecting stdout/stderr to a restricted background log:

```sh
node producer/kotlin-browser/compiler-port/descriptor-utils/verify-probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output-root out/kotlin-descriptor-utils-probe-new
```

The fixture obtains genuine descriptors, type parameters, constructors, properties/accessors and fake overrides by deserializing official bootstrap `.kotlin_builtins` resources. It defines no fake descriptor classes. The original selected Java and complete common algorithms run in separate fresh JVMs with the same verified `2.5.0-dev-10106` helper binaries. Helper source revision equality with the candidate pin is not proved. A separate typed-key fixture compares exact parent identity and strict/null behavior against the legitimate original Class traversal. API comparison documents only new typed overloads/companion field and Kotlin final static bridges; the original utility's private constructor means normal source subclassing was already unavailable.

Actual Wasm execution requires the concrete descriptor/type/checker/visibility/helper closure. PSI boundaries, user-source source-file behavior and Wasm assertion class-name text remain explicit integration gates. This component never declares fresh browser Kotlin compilation or public language readiness complete.

[`evidence/original-common-differential.json`](evidence/original-common-differential.json) records the actual passing JVM execution: 47,292 matching observations and 114 exact typed-parent identity checks. Preparation guards passed 4/4. The generated full observation ledger stays under `out/`, with its hash bound in the checked-in receipt. The genuine metadata fixture contains real fake overrides, while its binary descriptors have `SourceFile.NO_SOURCE_FILE`; positive user-source file objects remain not-run. The final background process exited 0; restricted log: `/home/seorii/logs/kotlin-descriptor-utils-differential-srwl1pwo.log`.
