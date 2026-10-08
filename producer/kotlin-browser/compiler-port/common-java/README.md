# Small original Java dependencies for the Wasm compiler host

This unit ports six pinned compiler inputs: `SourceElement`, `SourceFile`,
`ExplicitReceiverKind`, `CoercionStrategy`, `AnnotatedCallableKind` and the
generated keyword literals. Public getter methods, source sentinel identity,
nullable file names, enum order and receiver predicates remain unchanged.
Typed common property aliases preserve Kotlin's Java property spellings.

The original keyword collection is a mutable hash set. The common collection
keeps all 28 exact literals, membership and mutability. Iteration order is not
an API guarantee and is sorted only in the differential observer.

```sh
node producer/kotlin-browser/compiler-port/common-java/check.mjs
```

Use the workspace background-log workflow. The checked-in actual receipt
compares 38 observations on freshly compiled original Java/JVM, common JVM and
wasmJs/Node with no differences. It exercises the sentinel/custom source methods,
all enum branches, invalid enum names and keyword mutation/iterator removal.
The source recipe verifies every original Git blob/SHA-256 and each ported file.
The literal extractor accepts only the actual pinned string list.

This is a compiler dependency check. Browser execution of the dependency is
`not-run`, and the full browser compiler is still not built.
