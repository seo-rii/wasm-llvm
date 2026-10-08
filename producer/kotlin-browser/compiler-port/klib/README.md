# Official KLIB in-memory host boundary

This module ports the selected official KLIB byte/container boundary to common Kotlin. It supplies a real `MemoryKotlinLibrary` for the browser compiler: manifest/version values, metadata module and package fragments, and complete main/inlinable IR component access. It does not decode compiler protobuf schemas, construct library FIR symbols, link IR, or compile Kotlin user source by itself. Kotlin language readiness remains false.

The source revision is `JetBrains/kotlin@4d78aae1e337cd40f69baa865aed950fe807a775`. `sources.lock.json` pins 21 original source files and their transformed outputs, plus three unchanged JVM reference files. `patches/in-memory-klib.patch` is applied only to an isolated output closure. `prepare.mjs` verifies original SHA-256/Git blob IDs, patch SHA-256, forward/reverse application, prepared hashes, and unchanged original files. `update-patch.py` reproduces the patch from the separate complete official source lock; it rejects unverified input bytes.

The host changes preserve the original file layouts: big-endian fixed integer indexes, negative count identifying LEB128 element lengths, original declaration IDs and offsets, and WobblyTF8 strings including unpaired UTF-16 surrogates. The three official writer encoding bodies, LEB128 bodies, and abstract IR component accessors stay byte-for-byte unchanged. WobblyTF8 replaces `java.lang.Character` surrogate operations with equivalent common operations and JVM `String(CharArray)` constructors with equivalent `concatToString` calls; its encoding/decoding control flow stays unchanged. `BinaryVersion` uses actual `KClass` equality instead of JVM `Class` equality and drops JVM-only field/static annotations; compatibility rules remain intact.

`prepareKlibSources({ sourceRoot, outputRoot })` returns `commonSources`, `receiptPath` and a preparation receipt. Its common sources require the existing `compiler-port/host/LibraryPath.kt`. Filesystem component factories, path/file reader overloads, archive extraction, `KlibLayoutReader`, filesystem property I/O, and filesystem loaders are excluded from this compiler source set. JVM originals remain available to the differential probe. Existing compiler call sites must explicitly pass `MemoryKotlinLibrary` rather than silently invoking a filesystem loader.

The new library API is:

```kotlin
val verified = VerifiedKlibFileSet.verify(
    entries = listOf(KlibFileEntry(relativePath, bytes, approvedSha256)),
    explicitDirectories = approvedDirectoryIndex,
)
val library = MemoryKotlinLibrary(LibraryPath("/libraries/stdlib"), verified)
```

Expected digests must come from the approved host asset index. The default common SHA-256 implementation recalculates each digest after taking an owned copy; this does not establish trust in an index delivered by an untrusted source. An alternative verifier must perform real SHA-256. Paths are canonical relative POSIX paths; traversal, duplicate files/directories, file/directory shadowing, bad digest syntax and integrity failures are rejected. Library bytes and manifests are immutable; returned byte arrays are copies. File-set construction accepts explicit empty directories so metadata directory enumeration has the same logical input as the original filesystem component.

The common byte cursor bounds every read, table count, cumulative size and nested row. Declaration offsets cannot overlap their index. The writer sink is bounded and poisoned after a failed write. Limits are explicit host policy: 64 MiB per file/output, 128 MiB total decoded file bytes, 16,384 files and explicit directories, 1,048,576 table entries, and 1 MiB manifests. Writer input preflight uses conservative size estimates, including three bytes per string code unit and up to five bytes per array index. These limits are not a total browser GC heap cap. Reader caches are request/library-local strong caches; discard the library with its compiler session instead of retaining mutable sessions globally.

`ManifestProperties` implements the string-only manifest API used by this source set. It preserves UTF-8 reader input, Java property key/value separators and escapes, CR/LF/CRLF continuations, unpaired Unicode escapes and last duplicate key winning. It does not implement arbitrary Java object-valued properties or defaults chains. Upstream property-list, quoted-argument, substitution and version logic is retained as common source.

The probe uses the actually rebuilt selected-source patched Wasm/WASI stdlib with SHA-256 `3c97b68581963cf32c18d8b6d93b467f3accc9eae2689c1655e8ed4b31f52d28`: 519 files, 45 explicit directories and 12,112,627 decoded bytes. It invokes the original selected JVM filesystem components and portable memory components and compares an observation stream of every metadata and IR byte returned. This stream is 23,179,085 bytes. The portable browser probe performs the same operations in a real Chromium module Worker after static preparation with networking disabled. `extract-fixture.py` rejects unsafe ZIP paths, symlinks, duplicate paths and decoded-size violations before building the approved index. It does not add ZIP decompression to compiler core.

[The executed receipt](evidence/stdlib-byte-equality.json) records 76/76 required results: 31 format cases, 14 Java manifest cases, 30 common boundary checks and the complete stdlib access snapshot. Original selected JVM, portable JVM and Chromium 153.0.8010.12 Wasm results matched. Every browser snapshot byte was compared with the JVM reference, not just a content hash. No requests occurred during the offline operation. The portable unit Wasm was 1,466,813 bytes; this size belongs to the isolated reader probe, not a full compiler.

Reproduce the build and execution with prepared verified upstream sources and bootstrap cache:

```sh
node producer/kotlin-browser/compiler-port/klib/build-probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output out/kotlin-klib-probe
node producer/kotlin-browser/compiler-port/klib/browser-probe.mjs \
  --output out/kotlin-klib-probe
```

Run long commands in restricted background logs as required by workspace rules. Compiler output, generated sources, expanded KLIB files and large comparison streams remain under ignored `out/`; only bounded evidence receipts belong in source control. The builder uses the locked official bootstrap `2.5.0-dev-10106`, whose compiler source commit is not proven equal to the selected candidate. Original candidate source algorithms are the reference; this is a KLIB boundary differential rather than a full candidate JVM compiler R0 result. JVM comparison alone is not a browser pass. Browser acceptance is recorded separately by `browser-probe.mjs` and covers only its listed Chromium configuration, without performance targets or whole-compiler acceptance.
