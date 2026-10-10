# Selected JS AST byte output

This unit implements the byte-array operations used by the genuine selected
`DataWriter`: big-endian integers, booleans, canonical-NaN doubles, ordered byte
copies, defensive snapshots and transfers. It introduces `JsAstByteWriter`
outside Java namespaces. The complete pinned original DataWriter is projected
only for differential observation; every method remains in that projection.
Common string observations bind the existing genuine compiler UTF-8 encoder.

Preparation adds one implementation file and does not replace the serializer.
OutputStream transfer, flush/close and failure suppression, full serializer
execution, allocation exhaustion and browser compiler acceptance remain open.
The Int-range guard is an explicit common allocation boundary rather than a
claim of identical JVM and Wasm heap exhaustion.

The fresh JDK/common JVM/Node Wasm/offline Chromium Worker comparison passed
68,020 exact records with no skips or normalization, including every UTF-16
code unit, malformed surrogate strings, canonical NaNs, seeded primitive bits,
growth boundaries, snapshots and transfers. All seven commands and six
integrity guards exited 0. The 25 runtime artifact pins were independently
verified; exact receipts and private log/status pins are retained in
`evidence/receipt.json` and `evidence/integrity.json`.

Run `node --test producer/kotlin-browser/compiler-port/js-ast-consumer-bindings/output-codec/integrity.test.mjs`
and `node producer/kotlin-browser/compiler-port/js-ast-consumer-bindings/output-codec/check.mjs`.
