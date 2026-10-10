# Selected JS AST deserializer boundary

This component binds the genuine length-guarded JS AST deserializer to the
separately proven `JsAstInput` byte-array backend. It replaces only the exact
ByteBuffer read/cursor/String call forms, the location stack's `peek/push/pop`
with the same front operations of Kotlin ArrayDeque, and two private comment
array producers. Integer binding and the earlier length guard remain intact.
Other algorithms and the upstream source are retained. Location actions that
throw still leave pushed files on the stack, as upstream does; no `finally`
changes that behavior.

`jsAstCommentList` implements the actual pinned JVM `Array<JsComment>.toList`
contract: a shared canonical immutable empty list, an immutable singleton, and
a shallow copied fixed-size array list for multiple comments. Multi-element
`set` works; structural mutations fail. The genuine node stores that published
list directly, and metadata/deep-copy retains the same comment list and element
references. This preserves the actual `jsAstUtils` comment-add failure on a
deserialized immutable/fixed-size list. It does not convert every List into a
mutable copy. Full pinned `_Arrays.kt` and its source blob/hash are retained.

The common empty comment list has a different identity from the global stdlib
`emptyList()`. Raw evidence preserves that difference, native JVM/Wasm
`Array.toList` mutability differences, exception messages and JVM array/Wasm
index failure classes. The profile compares an explicit bounds-failure category,
not complete exception identity. The genuine selected caller audit binds seven
comment consumers from the 3,505-source frozen whole attempt; none compares
comments with global `emptyList`, uses a comment `subList` or `listIterator`.
The guard rejects new consumers, changed bodies and global singleton identity
comparisons.

`prepareJsAstDeserializer({sourceRoot, outputRoot, preparedInteger,
preparedBounds, preparedInput, retainedSources?})` verifies both predecessor
receipts and exact canonical input bytes. Supply the same original retained
source snapshot used by `preparedInteger`; it also guards selected comment
consumers. The output is two common sources under
`compiler-port-js-ast-deserializer/`: the complete bound source file and its
comment factory. `verifyJsAstDeserializer` takes the same arguments plus
`receiptPath`. Its generic predecessor binding uses component
`jsAstIntegerBoundsReceipt` and component-relative key
`compiler-port-js-ast-integer-bounds/<original deserializer path>`. Only that
predecessor is disabled. `inputDependency` binds the already selected
`jsAstInputReceipt` source by canonical path/bytes/hash; keep it selected once.
The previously selected genuine AST types remain unchanged.

The genuine selected methods, actual original AST classes/metadata, common
JVM, Node Wasm and offline Chromium module Worker agree on 154 records without
skips. The observer projects exact read, comment and location methods into a
small wrapper with a supplied string table; it does not replace the compiler
fragment models. Cases include Unicode/string/byte reads and guarded invalid
lengths, raw NaNs, inherited/nested locations and failure stack retention,
comment presence/types/read count, zero/single/multi mutation behavior, array
copy identity, metadata/deep-copy aliasing, iterator/view writes and the exact
pinned `jsAstUtils` comment-add expression. Ten preparation integrity guards
pass. Commands, pins, artifacts, selected caller hashes and raw differences are
sealed in `evidence/receipt.json` and `evidence/integrity.json`.

This proves the selected boundary profile. It does not compile the full
deserializer, establish general malformed array/count allocation bounds, port
the serializer output stream, or establish complete browser compiler acceptance.
