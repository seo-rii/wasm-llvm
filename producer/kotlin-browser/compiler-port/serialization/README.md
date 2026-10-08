# Official compiler protobuf dependency port

This builds a real common Kotlin protobuf dependency for the selected official
compiler. It does not provide a browser compiler entry or mark Kotlin ready.

The source lock binds Kotlin `4d78aae1e337cd40f69baa865aed950fe807a775` schemas,
186 original generated Java reference files, and the KLIB table/body selection
sources. `/usr/bin/protoc` 3.21.12 is checked by executable SHA-256, runs on the
unchanged schemas, and produces the descriptor set. `generate.py` uses that set
to generate 131 typed message classes, 626 fields and 47 extensions, including
the imported descriptor-options schema. Generated files retain official message
names, nested types, enum values, field numbers, defaults and oneof cases.
They are kept in `out/`, with input/output hashes in generation receipts.

`Runtime.kt`, `Wire.kt` and `Streams.kt` implement proto2 presence, required
initialization, singular message merge, packed/unpacked repeated values,
extensions, unknown fields/groups, unknown enum preservation, all 64-bit wire
kinds, raw UTF-8 string bytes, oneofs, and size/recursion checks. Generated
messages/builders expose both Kotlin properties and Java-style methods. The
final property getters use optional common `@JvmName` annotations so the JVM
comparison can compile both forms without signature collisions.

The stream boundary is `org.jetbrains.kotlin.protobuf.ProtoInput` / `ProtoOutput`.
`ByteArrayProtoInput` supplies immutable library bytes; `ByteArrayProtoOutput`
is bounded. The compiler's remaining JVM `InputStream`/`OutputStream` callers
must use the real host adapters. No filesystem, Java reflection, remote compiler
or success stub is supplied by this codec.

With the verified bootstrap cache prepared and the exact compiler source closure
already downloaded:

```sh
node producer/kotlin-browser/compiler-port/serialization/prepare.mjs \
  --source-dir out/kotlin-compiler-port/sources \
  --output out/kotlin-compiler-serialization/prepared-new
node producer/kotlin-browser/compiler-port/serialization/build.mjs \
  --prepared-dir out/kotlin-compiler-serialization/prepared-new \
  --output out/kotlin-compiler-serialization/build-new
```

`prepareSerialization(sourceRoot, newOutputRoot)` returns the sealed common
`sourceFiles` array and a receipt. `build.mjs` compiles those same files on JVM
and wasmJs. All returned files belong in `-Xcommon-sources`; host byte-stream
implementations belong outside that set. Prepared runtime/generator bytes are
copied to the new output directory, and changed sources, hashes, symlinks or
existing evidence destinations fail verification.

The differential probe requires an explicit actual stdlib KLIB and its digest:

```sh
node producer/kotlin-browser/compiler-port/serialization/probe-build.mjs \
  --source-dir out/kotlin-compiler-port/sources \
  --output out/kotlin-compiler-serialization/probe-new \
  --stdlib ACTUAL_STDLIB.klib --stdlib-sha256 ACTUAL_SHA256
node producer/kotlin-browser/compiler-port/serialization/verify.mjs \
  --output out/kotlin-compiler-serialization/probe-new \
  --evidence out/kotlin-compiler-serialization/probe-new/differential.json
python3 -B producer/kotlin-browser/compiler-port/serialization/fixtures.test.py
```

Run compiler/browser commands in restricted background logs under `~/logs` and
record their exit status, as required by the workspace rules. A completed codec
from an earlier probe can be reused with `--reuse-codec EARLIER_PROBE_DIRECTORY`;
the source preparation and compiled output digests must still match. Receipts
state that source compilation was reused.

The reference compiles the selected original Java messages against the verified
bootstrap's relocated protobuf runtime. Its source commit remains unknown.
The portable JVM and actual Chromium Worker run the generated common codec.
The corpus includes all selected stdlib metadata fragments and bounded main /
inlinable IR signatures, types, declarations and referenced expression/statement
bodies. Body kinds follow actual `IrDeclarationDeserializer` call sites. Proto2
edge cases additionally cover presence/defaults, required messages, unknown
fields/enums/groups, registry behavior, merging, invalid UTF-8, NaN/negative-zero
bits, 64-bit boundaries, malformed input, and recursion limits. Browser buffers
cross the Worker boundary as transferable binary buffers. Network access is
disabled after the complete trusted loader/Wasm assets initialize.

This is a serialization microprobe. A pass does not prove external-inline
linking, FIR semantics, the entire KLIB implementation, compiler conformance or
fresh-source browser compilation. Arbitrary schema/reflection APIs and remaining
Java stream overloads are explicit compiler integration work; callers must fail
to compile until the corresponding real implementation is supplied.

The completed selected-T run compared 2,436 cases on original Java, portable JVM
and Chromium 153.0.8010.12 with zero offline requests; see
[evidence/g2-metadata-ir.json](evidence/g2-metadata-ir.json). The preparation
integrity guards passed 13 tests, and fixture table guards passed 5. Run the
integration guards with `KOTLIN_CODEC_PREPARED=YOUR_PREPARED_DIRECTORY node --test
producer/kotlin-browser/compiler-port/serialization/integrity.test.mjs`; missing
prepared inputs are explicitly skipped and do not count as acceptance.

[evidence/integration-status.json](evidence/integration-status.json) lists API
gaps separately from the successful wire corpus. In particular, the current
registry exposes an immutable snapshot and rejects conflicting extension tags.
The selected compiler factories finish registration before discarding their
mutable registry, so the corpus path does not exercise later owner mutation or
plugin collision replacement. Generic protobuf API equivalence is not claimed.
