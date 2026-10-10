This unit ports the pinned Kotlin JavaScript AST implementation to common
Kotlin for the retained JS/Wasm compiler source graph. It preserves all 107
original AST source inputs: 63 Java classes receive genuine common
implementations, and the 44 Kotlin companions retain their bodies with
explicit host adaptations. It supplies nodes, operators, names and scopes,
metadata, ordinary and modifying visitors, copying, rendering and text
position tracking. No visitor or compiler context is replaced by a stub.
The complete compiler and public Kotlin readiness remain false.

The selected upstream commit is
`4d78aae1e337cd40f69baa865aed950fe807a775`. `sources.lock.json` binds every
original blob to the primary compiler closure, all 69 common source files,
the adapter and generators, genuine SmartList/assertion dependencies,
observers, UTF16 identifier policy, formatter evidence and license texts.
The Dart and Google copyright notices and GWT source attribution are retained.
`LICENSE.Dart` and `LICENSE.GWT` are the exact pinned upstream license bytes.

`prepareJsAstSources({sourceRoot, outputRoot})` in `prepare.mjs` returns
113 concrete common sources, two shared dependency paths, the 107 replaced
original paths, 72 explicit property alias imports, two license paths and a
preparation receipt. The shared dependencies are the existing common
SmartList and enabled compiler assertion helper. Root composition binds their
exact bytes to its already selected components rather than compiling them
twice. The imports comprise 69 AST names and the three TextOutput properties;
they introduce no class wildcard import. Original source bytes are verified
before preparation and rechecked afterwards. Outputs stay under repository
`out/`, cannot overlap the source cache, follow symlinks or overwrite an
earlier preparation.

The common classes retain explicit Java methods. `JavaProperties.kt` supplies
the synthetic property spellings required by real compiler callers. Getter
and constructor list/map references remain the supplied references. A
synthetic mutable property returns the actual mutable collection when one is
supplied; a genuinely read-only collection receives a backed view that reads
normally and rejects mutation. That view has a different identity from the
read-only input. No list mutability is inferred from its declared Kotlin
`List` type. Modifying visitors preserve the original list insertion,
replacement, removal and index advancement algorithm.

The tests exposed two reachable nullable NameRef boundaries. The original Java
`@NotNull` getter can actually return null after resolving and clearing its
name. Copying that state also succeeds in Java: its internal constructor call
does not enforce the annotation. The common getter now exposes the actual
nullable result, and copying retains it without inventing an identifier or
throwing early. The observer checks both `resolve(null)` and
`resolve(name)` followed by `setName(null)`, including qualifier copying,
source, comments and metadata. Genuine non-null parameter/dereference
boundaries in the 44 Kotlin companions remain explicit.

`evidence/receipt.json` records 1,041 observations from one shared observer on
four actual executions: the 107 original mixed Java/Kotlin sources on JVM,
the common sources on JVM, a compiled wasmJs binary on Node 24.21.0, and that
binary in an offline Chromium module Worker. All profile records agree, with
zero skipped cases. The original application runtime includes its newly
compiled classes, verified standard library and genuine host collection
support extracted from the verified embeddable distribution. It contains no
compiler JAR or precompiled compiler AST classes. The Chromium run has no
external requests, requests after becoming offline, or page errors.

Coverage includes scope/name identity and copying, source/comments/metadata,
all 35 binary and nine unary operator APIs, leaf and representative modern
expression/statement rendering, argument copy versus collection aliasing,
mutable and genuinely read-only list/map contracts, nullable fields,
ordinary and modifying traversal order, replacement and visit-false behavior,
all four For initializer transformations, nested function modifiers and
copying, text positions including UTF16, all 65,536 BMP identifier code units,
240 signed integer byte vectors, and source reader bounds/EOF/close behavior.
The independently committed Double formatter additionally agrees on 116,848
raw values across its pinned OpenJDK oracle, common JVM, Node Wasm and offline
Chromium; its source and receipt hashes are required by this preparation.

This is an explicitly bounded profile, not whole AST host equivalence. The
earlier run using actual Kotlin `listOf` inputs failed because singleton lists
are physically read-only on JVM and can be mutable on Wasm. Its six raw
differences, including resulting Try rendering differences, are retained in
`evidence/host-list-factory-negative.json`. The passing profile uses the same
genuine `AbstractList` read-only fixture on every host. The bounded audit in
`evidence/host-list-factory-callers.json` identifies a retained JS intrinsic
ObjectLiteral singleton where later mutation could observe the difference,
an export singleton without internal mutation, and module-wrapper `plus`
lists that allocate mutable storage on both hosts. No direct singleton factory
argument to the five affected AST constructors was found in the selected
Wasm backend source scan. This does not prove those JS consumers are unused
by a complete Wasm compiler. Full factory parity would require an explicit
binding at the actual producing sites; constructor guesses cannot supply it.

Failure categories compare directly, but raw JVM enhanced null messages,
common Kotlin messages and stack frames are retained without normalizing or
claiming equality. A closed source reader maps JVM IOException and the common
AstReaderClosedException to the explicit closed-reader contract. Diagnostic
class names use common runtime class names rather than claiming Java class
identity or Java reflection. JVM-only annotations are removed for common
compilation; this does not promise a drop-in Java binary ABI.

The UTF16 source reader and signed arbitrary-magnitude AstInteger are real
common helpers with tested algorithms, not a filesystem or the complete
BigInteger API. External compiler consumers still need a genuine VFS supplier
for AstSourceReader and explicit AstInteger bindings at the actual selected
BigInteger constructors. Those callers are outside this AST unit. Full
FIR/PSI compilation, whole compiler linking and execution of user Kotlin
programs remain separate acceptance gates.

Run from the repository root with the verified bootstrap and source caches:

```sh
node producer/kotlin-browser/compiler-port/js-ast/check.mjs
node --test producer/kotlin-browser/compiler-port/js-ast/integrity.test.mjs
node --test producer/kotlin-browser/compiler-port/js-ast/evidence.test.mjs
node producer/kotlin-browser/compiler-port/js-ast/verify.mjs
node producer/kotlin-browser/compiler-port/js-ast/verify.mjs --artifacts out/kotlin-js-ast/differential-WViAyC
```

`check.mjs` creates an isolated retained output directory. `verify.mjs` rejects
stale sources, tools, preparation metadata or expanded readiness claims;
`--artifacts` also rehashes every concrete output and rechecks all four raw
traces, including the preserved negative factory run. Eight preparation
integrity tests pass, including changed original/dependency/prepared sources,
overlap/symlinks, overwrite/omission attempts, altered provenance and
preparation-only claims falsely asserting differential validation.
The separate evidence guards reject stale tool/source identities, expanded
compiler/readiness claims, missing dependencies/imports, unrun host
comparisons and an alleged offline Worker that requested an asset.

The final retained runtime is `out/kotlin-js-ast/differential-WViAyC`.
Background PID 2214173 exited 0; its log is
`/home/seorii/logs/kotlin-js-ast-differential-1791632624539488773.log`, with a
sibling `.status` receipt. The eight integrity checks exited 0 under PID
2214189, logged at
`/home/seorii/logs/kotlin-js-ast-integrity-1791632624540817323.log`.
Final source/artifact re-verification and five evidence guards exited 0 under
PID 2388888, logged at
`/home/seorii/logs/kotlin-js-ast-final-verification-1791633019456616836.log`.
Their source/tool/log bindings are retained in `evidence/integrity.json` and
`evidence/verification.json`.
