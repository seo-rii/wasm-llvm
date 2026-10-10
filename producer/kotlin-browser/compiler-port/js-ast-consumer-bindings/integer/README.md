# Signed JS AST integer consumer binding

This component changes only the genuine `JsIrAstDeserializer.kt` import from
`java.math.BigInteger` to the existing common `AstInteger`. The signed-byte
constructor, serializer, marker 25, big-endian length and literal algorithms are
unchanged. All three upstream source files and extraction bodies are pinned to
Kotlin `4d78aae1e337cd40f69baa865aed950fe807a775`.

`prepareAstIntegerConsumer({sourceRoot, outputRoot, retainedSources?})` returns
one `commonSources` file, one `replacedOriginalPaths` entry, `astDependencies`,
`receipt` and `receiptPath`. `verifyAstIntegerConsumerPreparation` accepts the
same roots, receipt path and optional selected source inventory. When supplied,
the inventory must contain exactly the two remaining real JVM BigInteger
consumers: this deserializer and `OperationsMapGenerated.kt`. The latter's full
arithmetic API is outside this byte-constructor binding.

The checked-in evidence records 540 signed-byte inputs and 2,700 exact valid
observations across actual original JVM, common JVM, Node Wasm and an offline
Chromium module Worker. It also records eight exact malformed contracts. A
ninth malformed input declares `Int.MAX_VALUE` bytes at offset 4: original and
common JVM throw `OutOfMemoryError`, while Node and Chromium Wasm throw
`IllegalArgumentException`; all leave position 4. Both raw failure categories
and messages are retained. This is explicitly **not all-malformed host parity**.

The first strict comparison exited 1 on that real host difference. Its complete
artifact manifest and negative result remain in
`evidence/malformed-allocation-negative.json`. `seal.mjs` validates every
retained artifact, extracted observer byte, source pin, AST and bootstrap
dependency, then executes a fresh offline Chromium comparison. It does not
repeat the native allocation-negative. Eight integrity guards passed with no
skips. Receipts and execution paths are in `evidence/receipt.json` and
`evidence/integrity.json`.

To verify or reproduce the bounded profile, run `seal.mjs` and
`integrity.test.mjs` with the pinned compatible Node tool. `check.mjs` rebuilds
the actual JVM/common/Wasm probes and intentionally includes the retained
allocation-negative; do not use it merely to re-seal existing evidence.

The observer's prefix cursor is a test boundary, not a shipping ByteBuffer
replacement. Full deserializer compilation, remaining ByteBuffer methods,
source-map closure, browser compiler compilation and language readiness remain
unproven. A separate length-boundary component changes the malformed-input
contract before copying or allocation; this import-only unit does not do so.
