# Java-compatible binary64 text for JS AST

`../portable/org/jetbrains/kotlin/js/util/AstDoubleFormat.kt` exposes
`javaDoubleToString(value: Double): String` for the genuine `JsDoubleLiteral` and
`TextOutputImpl` ports. The original Java methods use `String.valueOf(double)` and
`Double.toString(double)`. Kotlin Wasm’s built-in formatter does not preserve their
JDK 17 spelling: `1e23` becomes `1.0E23` instead of `9.999999999999999E22`.

The implementation adapts OpenJDK 17’s compatible `FloatingDecimal` binary64
conversion at commit `162dbac82cf31c6948414944af836187aff9e6ca`
(`jdk-17.0.16+8`). It retains the integer fast path, the separate overflowing
32-bit and 64-bit loops, exact positive integer scaling, power-of-two asymmetry,
rounding ties to even, and the original fixed/scientific rendering thresholds.
The private base-2^30 integer kernel implements the exact operations this
conversion needs from `FDBigInteger`; it does not expose that class’s complete
API. The common implementation has no host formatter fallback. Float conversion,
parsing, conversion-status APIs, and JVM cache machinery are outside this unit.

`source.lock.json` binds the official Java originals, the two Kotlin compiler
consumer originals, the primary compiler source closure, the common implementation,
and the GPLv2 license with the Classpath exception. Original copyright and license
notices remain in the port. Changing pinned bytes causes preparation of the
numeric probe to fail before compiler execution.

## Verification

The checked-in [receipt](evidence/receipt.json) records 116,848 unmodified
`raw-bits:text` observations. The pinned `FloatingDecimal.java` and
`FDBigInteger.java` are compiled into a `java.base` patch and serve as the original
oracle through the recorded host JDK 17’s `Double.toString` entry. The host JDK’s
IEEE constant classes remain supporting dependencies; this is not a full JDK
rebuild. The common port is compiled and executed independently on JVM, Node
Wasm, and an offline Chromium module worker. All four outputs match byte for byte.
The comparison includes both signs, signed zero, subnormal and exceptional values,
every exponent with four mantissas, decimal/scientific threshold neighbors,
`1e23`, and 100,000 deterministic random bit patterns. It does not exhaust all
binary64 bit patterns. No observation text is normalized.

Chromium becomes offline after module initialization; execution issues no external
or additional offline requests. Browser asset bytes, compiler bootstrap versions,
observer sources, commands, outputs, and tool hashes are bound in the receipt.
Three focused integrity checks also pass, including rejection of corrupted source
and rejection of the native Wasm `1e23` spelling.

To reproduce, use the repository’s verified Kotlin bootstrap and install its
Chromium environment. Populate `out/kotlin-js-ast-number-reference/` with
`FloatingDecimal.java`, `FDBigInteger.java`, and `Double.java` from the exact
OpenJDK commit and paths in `source.lock.json`; the probe validates every file.
From the repository root run:

```sh
node --test producer/kotlin-browser/compiler-port/js-ast/numbers/integrity.test.mjs
node producer/kotlin-browser/compiler-port/js-ast/numbers/build-probe.mjs out/a-new-double-probe
```

The output directory must be new. This receipt establishes the formatter’s
observed semantics. Actual JS AST rendering, compiler assembly, and compiling
Kotlin programs in the browser require their separate integration checks.
