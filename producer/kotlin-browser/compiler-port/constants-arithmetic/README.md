# Generated constant arithmetic

This unit retains the complete pinned `OperationsMapGenerated.kt` and the
original `CompileTimeType` enum. Its sole change to that generated file is
rebinding `java.math.BigInteger` to the explicit immutable `CompilerInteger`.
The eight required operations are addition, subtraction, multiplication,
truncating division, remainder, and sign-extending AND, OR and XOR. No Java
package façade or replacement compiler model is introduced.

`CompilerInteger` keeps private little-endian base-256 magnitudes and delegates
signed byte canonicalization, comparison, decimal values, equality and hashing
to the already pinned `AstInteger`. Input and returned byte arrays are copied.
Arithmetic never narrows a magnitude to `Long`; result size arithmetic is checked
before allocating an array. Arrays still have `Int`-indexed addressability and
the host's memory limits. Addition, subtraction and bitwise operations are
linear; schoolbook multiplication and binary long division are quadratic in
operand lengths, with eight bit steps per byte for division. Live digit storage
is linear. Decimal formatting has the inherited repeated-division cost. This
unit makes no large-operand benchmark or full-FIR performance claim.

`prepareConstantsArithmetic({sourceRoot, outputRoot, retainedSources})` returns
two `commonSources`, one `replacedOriginalPaths` entry, `sharedDependencies`, a
receipt and `receiptPath`. The outputs are the full import-bound generated file
and `org/jetbrains/kotlin/portable/constants/CompilerInteger.kt`, under the
`compiler-port-constants-arithmetic/` logical prefix. `verifyConstantsArithmetic`
takes the same inputs plus `receiptPath` and compares the complete expected
receipt and output bytes. The composer must retain the existing `jsAstReceipt`
`AstInteger.kt` and original enum exactly once, verifying the returned shared
dependency paths, byte counts and hashes. The preparer verifies the primary
closure, original files, inherited integer pins, implementation, tools and
observer inputs before writing exclusive output files.

When supplied, `retainedSources` is the actual selected source inventory of
`{path, filename}` records. The caller guard rejects any incoming
`checkBinaryOp` reference or aliased import outside its genuine declaration,
so a changed value or identity contract requires review. The recorded audit
binds 3,505 actual inputs from the frozen earlier whole-build receipt and finds
no incoming caller. It is not an assertion about all Kotlin revisions or
future source graphs. Omitting the inventory records a null audit, rather than
claiming to have inspected callers.

The complete genuine `checkBinaryOp` body and enum are compiled in isolated
JDK-original and common JVM probes, then common Wasm and an offline Chromium
module Worker. All 18,679 records agree without skips: every pair of the 14
enum entries and eight operation names plus an unsupported name, zero-divisor
dispatch ordering, all pairs from -16 through 16, `Long` endpoints, signs,
nonminimal signed bytes, defensive copies, equality and hashing, and deterministic
one- through 128-byte operands. Quotient/remainder reconstruction, bounds and
sign, and negative bitwise sign extension are observed. All 145 raw failures
also agree: 144 zero divisions and one empty signed-byte input. Ten preparation
and incoming-caller integrity guards pass. Commands, output hashes, exact
source pins, browser requests and private log/status records are retained in
`evidence/receipt.json` and `evidence/integrity.json`.

JDK `BigInteger.valueOf(1)` reuses a cached object; this implementation returns
a fresh immutable value. Both preserve the observed zero and addition-zero
identities. The raw cached-object difference is explicitly retained, rather
than folded into the value comparison. No arbitrary JDK cached-object identity
or maximal-memory acceptance is claimed. The shipping file retains all other
generated bodies unchanged, but this focused probe compiles the complete
checker in isolation, not the other generated operations or `CallableId`
closure. Full generated-map and complete browser compiler acceptance remain
separate gates.

Run the focused checks with the verified compatible Node executable:

```sh
node producer/kotlin-browser/compiler-port/constants-arithmetic/check.mjs
node producer/kotlin-browser/compiler-port/constants-arithmetic/integrity.test.mjs
```

For the long checks, follow the workspace background-log rules. Source updates
require regenerating `sources.lock.json` with `update-recipe.mjs` and repeating
the affected differential and integrity checks. The inherited JetBrains files
retain their original Apache-2.0 notices; the common arithmetic implementation
is Apache-2.0.
