# JS AST payload length boundary

This separate component inserts one `require` immediately after the genuine
`JsIrAstDeserializer.readBytes` reads the big-endian length and current cursor.
It rejects negative lengths, invalid cursors, overflow and lengths beyond the
remaining input **before** invoking the transform, copying or allocating a
payload. `length <= source.size - offset` avoids overflow. The existing allocated
input bounds the payload; there is no invented extra byte limit.

The change deliberately changes the malformed-input contract to
`IllegalArgumentException("Invalid JS AST byte length")`, with the cursor left
after its four-byte prefix. It applies equally to genuine `readByteArray` and
`readString`, because they share `readBytes`. Their bodies, the signed integer
constructor, marker and serializer remain unchanged. The previous raw
allocation-negative evidence remains in the separate `integer` component.

`prepareAstIntegerBounds({sourceRoot, outputRoot, preparedInteger,
retainedSources?})` requires the genuine import-only prepared predecessor and
verifies its complete receipt and bytes. If that predecessor used an inventory,
pass the same original `retainedSources`. It returns one common source under
`compiler-port-js-ast-integer-bounds/`, replacing exactly the predecessor key
`compiler-port-js-ast-integer-consumer/<original deserializer path>`. Its generic
predecessor binding uses component `jsAstIntegerConsumerReceipt` and the precise
component-relative predecessor path. `verifyAstIntegerBounds` takes the same
arguments plus `receiptPath`.

Final evidence includes 2,700 unchanged valid byte observations compared with
the real original baseline, 18 guarded malformed observations and eight direct
transform-call/cursor observations across guarded original JVM, common JVM,
Node Wasm and an offline Chromium module Worker. All profiles agree without
skips. The direct callbacks prove rejection happens before transformation, and
that zero/exact-fit valid ranges invoke it once. Eight integrity guards pass.
Source pins, commands, raw failures and artifacts are retained in
`evidence/receipt.json` and `evidence/integrity.json`.

The test's small portable prefix cursor remains an observer boundary. This
does not port shipping ByteBuffer, bound unrelated array/count readers, compile
the full deserializer or establish complete browser compiler acceptance.
