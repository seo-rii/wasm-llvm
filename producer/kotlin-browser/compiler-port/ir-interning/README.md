This component retains the complete pinned `IrInterningService.kt` from Kotlin
commit `4d78aae1e337cd40f69baa865aed950fe807a775`. Three import changes bind its
Fastutil interning surface to common Kotlin open-addressed sets. Every service
method, lazy cache, custom structural hash/equality strategy and reset operation
is otherwise byte-identical to the original source.

The helper exposes only the service-used `addOrGet` and `clear` operations. It
preserves first-instance canonical identity, stored-key/query equality direction,
hash mixing, collision probing, growth and custom null-equivalent canonical keys.
The service's anonymous strategy keeps its original inherited identity-hash seed.
Clearing retains allocated capacity and forgets all canonical instances.
Fastutil iteration, removal, serialization interfaces, thread safety, memory
measurements and throughput parity are outside this component's contract.

`prepareIrInterning({ sourceRoot, outputRoot })` creates the complete source
replacement and `compiler-port-ir-interning/CanonicalInterningSet.kt`.
`verifyIrInterning` replays pinned originals, dependencies, exact transformations
and an externally supplied preparation receipt digest. `verifyFinalIrInterning`
checks both actual selected bodies and file owners, permitting only recorded
assembly import blocks. Source/output overlap and reused output roots reject.

`check.mjs` compares raw observations from the complete original Fastutil service
on JVM, the complete common service on JVM and Node-Wasm. It executes the full
pinned `IrFileEntry.kt`, original Java/common `Name`, and the complete byte-identical
`NaiveSourceBasedFileEntryImpl` class and `SYNTHETIC_OFFSET` declaration extracted
from pinned `AdditionalIrUtils.kt`. Probe-only subclasses exercise real
`AbstractIrFileEntry` polymorphism; no compiler-package stand-ins are used.
Identity-hash integers differ by process and are not compared. Bootstrap artifact
versions and hashes are verified, but their source commit is unknown.
The pinned Wasm stdlib lacks `IntArray.binarySearch`; its default-range equivalent
in `PrimitiveSearchBoundary.kt` is proof-only and imported into the otherwise
unchanged full `IrFileEntry` body for Wasm. It is outside compiler packages and is
not selected as shipping output. Genuine file line/column operations are compared
against the native JVM overload, including synthetic, undefined and partial lines.

`integrity.test.mjs` checks the real failed 3,533-source compiler invocation,
canonical replacement/helper selection, exact import roundtrip, body forgery,
receipt and original snapshot forgery, missing/duplicate/switched owners, recorded
imports, reuse/overlap and source/caller cache tampering. `evidence.mjs` rehashes
runtime inputs and artifacts, all historical source owners, and execution files
before copying immutable runtime and guard receipts into `evidence/`.

These proofs do not establish whole IR deserialization/linking, a complete
compiler Klib, callable compiler Wasm, browser/offline compilation or language
readiness. Those remain false in every receipt.
