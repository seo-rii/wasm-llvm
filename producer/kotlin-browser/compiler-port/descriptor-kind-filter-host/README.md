The complete pinned `MemberScope.kt` is preserved with four exact host changes.
They remove the Java reflection import, use common class identity in the final
filter class, replace its debug-only field lookup with pinned metadata, and use
common simple class names for excludes. Reversing the four spans restores every
original byte. All mask, descriptor-kind, exclusion, equality, hashing and scope
algorithms remain unchanged.

The full original JVM build verifies the reflection schema: ten public static
`@JvmField` filter objects in source order and **no public Int fields**. The Int
masks have private backing fields, so the original debug bit-name list is empty;
the common implementation preserves that behavior, including unnamed masks.
Named predefined filters and anonymous excludes retain their original text.
This pins the observed source/runtime schema; arbitrary JVM reflection field
iteration order across other implementations is not claimed.

`prepareDescriptorKindFilterHost({sourceRoot, outputRoot})` returns one full
replacement at the original logical path and an externally pinned receipt.
`verifyDescriptorKindFilterHost` additionally takes `expectedReceiptSha256`.
`verifyFinalDescriptorKindFilterHost` takes the actual `retainedSources` and
`recordedPropertyImports` and verifies the original, source lock, exact final
body and owner after permitted import assembly. No declarations are excluded.

`check.mjs NEW_OUTPUT_ROOT` rebuilds and executes the full original and common
files on JVM. Their 13,540 raw observations match, including all filter
operations, negative/unknown masks, typed descriptor-kind classification,
excludes, debug names and scope filtering/name helpers. Proxy objects provide
explicit descriptor kind/receiver/FqName boundaries; they do not implement
compiler descriptors. Other dependencies come from the verified bootstrap,
whose source commit is unknown. Native object hash identities are only compared
for within-host equality; empty-excludes raw hashes are compared directly.
Full common-class Wasm execution, FIR resolution and browser acceptance remain
unverified.

`integrity.test.mjs NEW_OUTPUT_ROOT` binds the immutable failed whole compiler
invocation, its argument hash and all 3,522 original source pins. Seven tests
check the exact replacement and original order, reversible spans, rehashed body
tampering, external receipt and snapshot forgery, missing/duplicate/switched
owners, unrecorded/duplicate imports, reuse/overlap, and restored positives.
`evidence.mjs` accepts completed runtime and guard launcher job files, verifies
their exit statuses and immutable inputs/artifacts, and saves exact proof
receipts with execution/log/status pins. This is component evidence; all
readiness fields stay false.
