# Full PerformanceCounter on a single Worker

This component ports the complete 7,012-byte upstream `PerformanceCounter.kt`
from Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`. Its simple,
reentrant and exclusion counters, nested-call accounting, count/reset and both
report callbacks remain executable algorithms. It removes no counter class or
method. Twenty-one exact, pinned spans replace JVM host operations:

- `System.nanoTime()` becomes a required caller-owned nanosecond clock.
- The five monitor scopes become synchronous `run` scopes for one Worker.
- The two thread-local cells become module-local cells. Their shared generic
  getter preserves null defaults and repeated evaluation until a nonnull value
  is stored, without Java platform types or narrowing nullable type arguments.
- `Stack<Boolean>` operations use `ArrayList<Boolean>`; the assertion stays an
  assertion and uses the compiler's existing enabled assertion adapter on Wasm.
- `TimeUnit.NANOSECONDS.toMillis` uses signed integer division by 1,000,000.
- JVM imports and `@JvmOverloads` are removed; the execution-contract comment is
  updated. No timing algorithm or reporting format is replaced.

`withPerformanceCounterClock(nanoTime, block)` installs the supplier before a
synchronous compiler call and restores the previous supplier in `finally`.
Nested calls and exceptions restore it as well. `performanceCounterNanoTime()`
fails explicitly outside an installed scope. The supplier must return monotonic
nanoseconds with Long wraparound and must not reenter compiler code. Disabled
counters retain upstream behavior and do not call the clock.

This contract is for one synchronous Worker and a fresh Wasm module per compiler
request. It does not provide JVM multithreading, shared-memory locking or
suspending scopes. Registries and cell contents live for the module's lifetime,
as the original JVM globals and thread-local state live for theirs.

## Reproduce

Use the project's Node 24 binary:

```sh
node producer/kotlin-browser/compiler-port/performance-counter/check.mjs out/NEW-counter-proof
node producer/kotlin-browser/compiler-port/performance-counter/integrity.mjs out/NEW-counter-guards
```

The differential test compiles the full original source on JVM, replacing only
its single clock expression for reproducibility. It then compiles the complete
portable source on JVM and wasmJs and compares raw observations in Node. It
covers simple and reentrant nested calls, exclusion inside and outside a parent,
nested exceptions and subsequent recovery, 16 mixed nesting scenarios, signed
millisecond conversion, Long wraparound, report callback mutation, reset,
disabled timing, clock-scope restoration and nullable cell defaults. This is a
full-source test, with no extracted-method projection or modeled counter.

The recorded run passes 153 raw observations on all three targets.

The integrity check calls the public preparation and final verification APIs. It
checks exact recorded property/JVM/assertion prefixes from the last whole-build
receipt while preserving every other byte, including blank lines and report
literals. It rejects missing or duplicate sources, wrong owners, stale claims,
changed algorithms or host restoration, malformed imports, tampered receipts,
changed originals and symlinks. Four positive cases and 17 rejection cases pass.
Mutable fixtures are private copies and are
restored in `finally`.

`evidence/differential.json` and `evidence/integrity.json` identify the actual
artifacts, commands, observers, source locks and results. The deterministic
clock proves accounting and host-call order; browser real-clock precision has
not been tested. This component does not port `PerformanceManager`, compile the
whole compiler or establish browser Kotlin language readiness.
