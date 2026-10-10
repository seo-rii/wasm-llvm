# Selected JS AST input codec

`JsAstInput` is a real common byte-array backend for the five operations used
by the pinned JS AST deserializer: signed byte, big-endian integer, raw IEEE
double, cursor query and checked seek. It shares the original input array.
Primitive reads check their entire width before advancing; exhausting a read
leaves the cursor unchanged. `readUtf8(offset, length)` reads raw text without
advancing and reuses the already pinned compiler text decoder in replacement
mode. No normalization or Java package façade is introduced.

`prepareJsAstInput({sourceRoot, outputRoot})` returns one common source, no
replacements, a receipt path, and two `sharedDependencies` (`CompilerUtf8Algorithm.kt`
and `CompilerUtf8Api.kt`). The composer must verify those bytes against its
existing `textReceipt` and select each helper once. `verifyJsAstInput` takes the
same roots and the returned `receiptPath`. The actual selected consumer and its
five buffer call forms, inherited text implementation, source pins, preparation
tools and observer inputs are checked before output is written.

The real JDK ByteBuffer/String baseline, common JVM, Node Wasm and an offline
Chromium module Worker agree on 73,327 profile records without skips. Coverage
includes every signed byte, integer boundaries and deterministic samples,
2,060 double bit patterns including signaling/quiet NaNs and signed zero,
atomic exhaustion, shared-array mutation, invalid and endpoint seeks, every
one/two-byte UTF8 sequence at a nonzero offset, and malformed/valid longer
slices. Eight preparation integrity guards pass. Commands, pins, output hashes,
browser requests and raw failures are sealed in `evidence/receipt.json` and
`evidence/integrity.json`.

Failure comparison uses an explicit atomic-underflow contract: the real JDK
throws `BufferUnderflowException`, while the common backend throws
`JsAstInputUnderflow`. Invalid seeks retain `IllegalArgumentException` but use
a common message rather than the JDK position/limit message. These raw
class/message differences remain in the receipt. This unit does not wire the
shipping consumer, reproduce the complete ByteBuffer API, compile the complete
deserializer or establish full browser compiler acceptance.
