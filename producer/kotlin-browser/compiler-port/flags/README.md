# Official metadata and IR flags on the compiler's Wasm host

This patch family ports `Flags.java` and `IrFlags.java` from the locked Kotlin
compiler source. The generator accepts only their actual flag declarations and
bitwise builder methods; it rejects other Java declarations rather than guessing.
It does not transform user Kotlin source.

The nested flag implementation keeps the official signed shifts, bit masks,
enum widths, absent enum values and inherited static aliases. Its source hash,
the original Java blob hashes and the generator hash are recorded in the source
recipe and every preparation receipt.

Reproduce after preparing the locked compiler sources and the protobuf codec:

```sh
node producer/kotlin-browser/compiler-port/flags/check.mjs \
  out/kotlin-compiler-serialization/probe-7/reference \
  out/kotlin-compiler-serialization/probe-8/codec
```

The checked-in receipt records an actual original-Java JVM, portable-JVM and
portable-Wasm Node comparison: 20,887,711 observations produced the same digest
with no differences. The observer exercises every selected field over all
16-bit inputs, signed extremes, enum and boolean builder combinations, offsets
and Java's inherited static aliases. This is a flag-helper check, not a count of
Kotlin language cases. Browser execution of this helper is `not-run`; the full
browser compiler is still not built.
