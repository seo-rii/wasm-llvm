# Bit sets used by official Wasm liveness analysis

This unit ports the OpenJDK word algorithms used by two pinned Kotlin compiler
sources: `LivenessAnalysis.kt` and `BitSetUtil.kt`. Their analysis, copy and bit
traversal bodies remain byte-identical; preparation changes only the BitSet
import. It supplies the real mutable bit vector used by the analysis, rather
than removing that lowering or replacing its results.

Kotlin source identity is `4d78aae1e337cd40f69baa865aed950fe807a775`. The OpenJDK
reference is `jdk17u` commit `162dbac82cf31c6948414944af836187aff9e6ca`
(`jdk-17.0.16+8`). [sources.lock.json](sources.lock.json) binds the two compiler
inputs, original Java class, portable source and license bytes. The port carries
the original Oracle 1995, 2020 notice and GPL-2.0 with Classpath exception;
[LICENSE.OpenJDK](LICENSE.OpenJDK) and the assembly exception are included.

The selected API preserves word capacity/doubling, single-bit get/set/clear,
next-set-bit traversal, inclusive OR, AND-NOT, equality and hash code. The
compiler's actual `copy`, `forEachBit` and `mapEachBit` execute in the differential
probe. Stream/serialization, buffer conversion, range operations and clone are
outside the selected API. `sizeIsSticky` is used by excluded clone/serialization
operations; the selected compiler copy retains capacity through its unchanged
`BitSet(size()).apply { or(original) }` body.

LongArray and common bit intrinsics replace Java array/intrinsic host bindings.
Word invariants are enabled. Negative indices retain IndexOutOfBoundsException
and the exact message; a common negative-size exception retains that category
and message without pretending to have Java's exception class identity. The
selected compiler constructs nonnegative sizes.

The [differential receipt](evidence/differential.json) records **1,471 exact
observations** on the pinned original Java class, common JVM and actual wasmJs
running in Node. `javac --patch-module java.base` compiles the unchanged pinned
Java source, and the original observer executes that compiled class with system
assertions enabled. Cases include empty/zero-capacity sets, capacity growth,
63/64 and other word boundaries, ordered utility traversal, copy isolation,
self OR/AND-NOT, distinct capacity equality, negative calls with unchanged state
and deterministic data-flow union/kill sequences. No output normalization is
used except the explicitly declared negative-size exception category.

Five integrity guards verify original input pins, exact consumer body equality,
both cache overlap directions, symlinks, existing output preservation, changed
portable bytes and an omitted consumer receipt. Their actual result is recorded
in [integrity.json](evidence/integrity.json).

To reproduce from the repository root after preparing the official compiler
source inventory and payload-verified bootstrap:

```sh
node --test producer/kotlin-browser/compiler-port/bit-set/integrity.test.mjs
node producer/kotlin-browser/compiler-port/bit-set/build.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --reference-root out/kotlin-bit-set-reference \
  --output out/kotlin-bit-set-probe-new
```

The probe fetches only the locked Java reference when absent; changed cached
bytes are rejected. The output must be new. Run long checks with restricted
background logs as required by the workspace rules.

`prepareBitSetSources({sourceRoot, referenceRoot, outputRoot})` returns three
common files and the two exact original paths to replace. The full liveness
visitor, compiler KLIB/binary and fresh browser source compilation have not
executed in this component probe. Their acceptance remains separate and public
Kotlin readiness stays false.
