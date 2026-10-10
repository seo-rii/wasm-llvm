# Backend diagnostic exception-name text boundary

This unit preserves the existing JVM-qualified exception-name **String
protocol** in `CommonBackendErrors.kt`. It changes only
`StackOverflowError::class.java.name` and `NullPointerException::class.java.name`
to the original JVM names `"java.lang.StackOverflowError"` and
`"java.lang.NullPointerException"`. Actual JVM metadata is the oracle for those
values. It does not define Wasm error classes, traps, arbitrary exception
handlers or a Throwable-to-protocol generator.

The original is Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`.
The complete backend renderer algorithm and copyright header remain. The
nonblank message branch still takes precedence over specialized class names;
absent/blank messages retain the special stack-overflow/null-reference text,
other matched class names retain their final qualified-name segment, and a
nonmatching protocol string remains unchanged.

## Genuine sourced-DSL predecessor

`prepareBackendExceptionText({ sourceRoot, outputRoot, preparedSourceDsl })`
requires the genuine output of `prepareDiagnosticSourceDsl`. It replays the
whole predecessor verifier, checks its exact source lock and tools, checks the
on-disk receipt against the caller's object and verifies the canonical backend
output bytes. All six sourced diagnostic delegates and their PSI metadata
bindings remain exactly as that verified predecessor prepared them.

Invoke this before root's late annotation-import binding. The result has one
`commonSources` file at the same existing component logical path:

```text
compiler-port-diagnostic-source-dsl/common/compiler/ir/backend.common/src/org/jetbrains/kotlin/backend/common/CommonBackendErrors.kt
```

`replacedPreparedPaths` contains that path; `replacedOriginalPaths` is empty,
because the original was already replaced by the sourced DSL. The
`predecessorBindings` entry binds its canonical filename, component logical
path, output bytes/hash, receipt hash and dependency lock/tools. Root composition
must replace that selected component once and then apply its normal annotation
imports to the new file. A late import, changed renderer body, modified delegate,
missing/duplicate predecessor or stale receipt is rejected before output.
`verifyBackendExceptionText({ sourceRoot, preparedSourceDsl, profileRoot })`
replays the predecessor again and compares the full prepared output, preserved
original reference and every receipt field. Run it before the predecessor is
subject to later root import binding.

## Execution scope

The sealed differential contains 1,653 raw protocol observations: 13 malformed
or plain inputs, 22 class names paired with 28 suffixes, and 1,024 deterministic
mixed UTF-16 inputs. Full original JVM, full common JVM, the exact common lambda
on JVM, and that lambda on Node Wasm produce identical records. All seven actual
backend diagnostic factory names and severities also match between the full JVM
variants. Seven preparation-integrity tests pass. The evidence receipts bind
all 24 generated source, observation, JVM, klib and Wasm artifacts; their bytes
and hashes were rechecked after both processes exited with status 0.

The JVM probe compiles and executes the full actual original backend file and
the sourced-DSL-plus-two-expressions backend file. Both compile the complete
original `DiagnosticParameterRenderer.kt`, including the real `Renderer`
function and its interfaces. The remaining context/factory dependencies come
from the verified genuine sourced-DSL JVM artifacts and bootstrap. Their
bootstrap source commit is unpublished; no compiler model is fabricated.

The Node Wasm probe compiles the exact selected renderer lambda body, with its
source hash sealed separately, and checks it against both full JVM variants.
It does not invent a Renderer or RenderingContext to stand in for an unclosed
compiler graph. That projection cannot prove full diagnostic-table acceptance
on Wasm. Inputs cover full/short/custom/Unicode qualified class names, absent
captures, malformed protocol strings, message-first branch precedence,
whitespace, line/control characters and deterministic mixed strings. Both the
input and result use a reversible UTF-16 code-unit encoding in observations;
no code unit is trimmed, substituted or normalized.

Actual host Throwable-to-protocol generation, full diagnostic-table Wasm
execution, browser execution and whole compiler acceptance are separate work.
Public Kotlin language readiness remains false.
