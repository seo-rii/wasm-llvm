This component preserves the complete pinned `IrFileEntry.kt`: its interface,
`AbstractIrFileEntry`, source ranges, line/column data types and every method.
The single host binding replaces `lineStartOffsets.binarySearch(offset)` with
`lineStartOffsets.asList().binarySearch(offset)`. The default whole-array search
uses the official common list algorithm through a live array view. Each call
still reads the current array getter; offsets are neither copied nor cached.

Prepare and verify with the same direct output root and an externally captured
receipt SHA. The final verifier checks the actual selected owner, full body,
source pins, original snapshot, duplicate logical paths/owners and only recorded
assembly imports. It replaces one original logical source and adds no helper.
The source lock binds the actual upstream Git blob and SHA, exact one-span
recipe, complete output and all preparation/normalization dependencies.

The full original source compiles independently on JVM. The full common source
compiles on JVM and Wasm; it uses no dependency projections or substitute IR
classes. One observer exercises all genuine methods with empty arrays, negative
and extreme offsets, duplicate line starts, before-first-line behavior, nonzero
first relevant line indices, ranges, equality/hash and actual getter read counts.
It also mutates existing arrays, replaces the getter's array and checks that
serialization retains the original live view. Seven successful commands produce
identical raw original-JVM/common-JVM/Node-Wasm observations without normalization.

Seven integrity tests bind the exact failed 3,533-source invocation and argument
file SHA, preserve all other source rows and order, and reject rehashed algorithm
changes, altered receipts/snapshots, missing/duplicate/relocated owners, arbitrary
or duplicate imports, output reuse and overlapping roots. Restored positives pass.
Completed execution, differential and integrity evidence is sealed in `evidence/`.

The live view adds an allocation per search; throughput and allocation parity
are unmeasured. Concurrent mutation during a search and non-default primitive
range overloads are outside this component. Bootstrap tools and stdlibs are
hash-verified but their source commit is unknown. The whole IR pipeline, callable
compiler Wasm and fresh offline browser source compilation remain unverified.

Run `node check.mjs <fresh repository out/ directory>` for the runtime comparison
and `node integrity.test.mjs <fresh repository out/ directory>` for the guards.
Use persistent background execution with private logs and exit-status records.
