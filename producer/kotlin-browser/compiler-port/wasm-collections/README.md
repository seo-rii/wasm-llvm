# Selected Wasm serial collection operations

This unit closes three concrete common-host collection errors in the pinned
compiler: function-type registration, literal-global construction, and ascending
function-index emission in Wasm code metadata. It transforms the actual selected
compiler source bodies and adds no generic JVM collection facade.

The three `putIfAbsent` return values are discarded. Their maps have nonnull
`WasmFunctionType` values, and the candidate values have already been constructed.
Using common `getOrPut(key) { candidate }` retains the first object and preserves
the original eager evaluation of each candidate. `bindGlobalLiterals` also has
nonnull values: its callback constructs a real `WasmGlobal`, and does not mutate
the same map. The key is captured once before `getOrPut`; the existing global
counter, constructor argument order, imported string symbol and exception
propagation stay in the original body. A hit does not run that factory.

The writer’s local `Map<Int, List<ResolvedAnnotation>>` is used only for size and
ascending iteration after grouping. `toList().sortedBy { it.first }` is the common
ascending snapshot needed by those uses; the lists of annotations remain the
same referenced values. Section kinds, inner byte-offset sorting, payload sizes,
LEB128, and byte emission retain their selected original algorithms. No arbitrary
`SortedMap`, nullable map or concurrent/reentrant callback contract is claimed.

## Preparation composition

```js
prepareWasmCollectionsSources({
  sourceRoot,
  outputRoot,
  preparedIdentity, // genuine prepareIdentitySources result
  preparedText,     // genuine prepareCompilerTextSources result
})
```

Both predecessors must be prepared before this unit, before root assembly adds
its later JVM-annotation imports. The preparer verifies pinned original bytes,
predecessor lock and preparation-tool hashes, on-disk receipts, selected prepared
file hashes, and transformation cardinalities. It leaves original and predecessor
sources unchanged. It returns exactly three final `commonSources`, their three
original logical `replacedOriginalPaths`, `predecessorBindings`, `receipt` and
`receiptPath`. The final source paths are the original paths, without a wrapper
prefix.

Root composition must retain each predecessor’s receipt, verify each binding,
and suppress the bound predecessor source exactly once before adding these final
three sources. Identity’s component-relative path is the original fragment path;
text’s is `compiler-port-text/` plus the original binary-writer path. The binding
also records the exact predecessor filename and digest. The other identity/text
sources remain inputs. Do not emit the predecessor and final version together.
The final fragment retains the existing `IdentityIndex` host changes; the final
writer retains the existing exact UTF-8 import.

## Differential evidence

The [receipt](evidence/differential.json) records 1,308 unmodified observations
that match original JVM, common JVM, and actual Node Wasm execution. Of these,
1,026 compare raw Wasm code-metadata section bytes. The generator lifts the exact
selected original annotation classes, emission, section framing, payload
backpatch and string writer bodies into an observation harness. Real original
ByteWriter/LEB128 are used on JVM; their existing verified common ports are used
on Wasm. Both builds include full pinned Wasm IR declaration, type, operator,
instruction, symbol, expression-builder and flow-optimizer sources. The common
expression-builder support uses the existing enabled common assertion helper.

Map observations use real `WasmFunctionType`, `WasmGlobal`, `WasmRefType`,
`WasmImportDescriptor`, `WasmSymbol`, and the exact selected `LiteralGlobalSymbol`
class. They exercise equal/colliding keys, first-object identity, eager candidate
construction, repeated literal batches, per-batch counters, factory suppression,
mapper failure and retry. The map-owner carriers and signature keys are explicit
observation fixtures. They do not replace real compiler owners. The complete
`IdSignature` graph, full compiled fragment and complete module writer are not
executed by this probe. There is no fake compiler pipeline or public readiness
claim.

Metadata cases cover all three annotation kinds, unsorted function indices,
repeated function groups, equal offsets, signed payload extremes, LEB128
boundaries, empty groups, and 1,024 deterministic generated input lists. No text
or bytes are normalized. Browser execution is a separate integration check;
this receipt establishes JVM/common/Node-Wasm parity only.

Six [integrity guards](evidence/integrity.json) pass: valid predecessor composition,
changed identity and text variants, a stale receipt, missing/duplicate selected
inputs, and corrupt originals or repeated transformation. The successful
background differential and guard processes both exited 0; log paths are
`/home/seorii/logs/kotlin-wasm-collections-final-1791631820292219380.log` and
`/home/seorii/logs/kotlin-wasm-collections-guards-1791631652251605034.log`.

To reproduce with the verified compiler bootstrap and pinned original source
cache, run from the repository root with a new output directory:

```sh
node --test producer/kotlin-browser/compiler-port/wasm-collections/integrity.test.mjs
node producer/kotlin-browser/compiler-port/wasm-collections/check.mjs out/a-new-wasm-collections-probe
```

Other host errors in these files, including the IntelliJ reverse-map helper and
UTF-8 binding in code generation, remain separate boundaries. This preparation
closes the selected collection operations while preserving those visible errors.
