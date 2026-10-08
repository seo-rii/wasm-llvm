# Common compiler name dependency

`Name.kt` ports the actual pinned `core/names/.../Name.java` dependency used by
the official FIR/IR compiler. `name.recipe.json` maps every original public
method to the common implementation and records original Git blob/SHA-256 and
portable source hash. Synthetic Kotlin property spellings remain available;
JVM methods and companion factories retain their original names.

The port retains unchecked `identifier()` construction, the exact four rejected
identifier characters, leading-`<` special-name validation, UTF-16 comparison,
special-flag equality and Java-compatible string hashing. It adds no language
parser, emitter or source rewrite.

The actual `name-evidence.json` run compared freshly compiled original Java
against portable JVM and portable `wasmJs` execution in Node 24.1.0. All 32
detailed cases, 1,024 comparison pairs and the 65,536-code-unit corpus matched.
The large corpus is compared through deterministic digests; detailed cases cover
hash collisions, supplementary/lone-surrogate Unicode, malformed special names,
exceptions and property/method compatibility. Substring bounds exceptions are
compared by family because JVM and Wasm retain their own runtime subclasses and
messages. Inputs obey the original `@NotNull` contract.

```sh
node producer/kotlin-browser/compiler-port/core/build.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output out/kotlin-compiler-name-probe-reproduction
```

Run long builds through the workspace private background-log workflow. Outputs
must be fresh and remain under `out/`. To integrate the real dependency, import
`prepareCoreSources` from `prepare.mjs`, pass the verified original source root
and an isolated output root, and append its returned `commonSources` to the
compiler's common source set. Original sources remain unchanged. Compile common
JVM annotations with their explicit `kotlin.jvm` imports and the compiler's
multiplatform source selection; do not erase them.

This dependency passes its finite differential unit. The full browser compiler,
fresh browser Kotlin compilation and public Kotlin support remain unverified;
`languageReadiness` stays false.
