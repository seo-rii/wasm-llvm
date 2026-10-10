# Compiler IR fingerprints in common code

This component preserves the pinned compiler's CityHash64/128 algorithms,
Hash128Bits combination, IR file-part fold and KLIB file-list fold. The shipping
source retains both real SerializedIrFile and KotlinLibrary constructors. It
does not replace compiler objects or their algorithms with stubs.

Only host operations change: the exact ByteBuffer calls bind to a private
adapter with the original default big endian layout, low word before high word;
Character.MAX_RADIX binds to 36; String.toByteArray binds to the existing pinned
compilerUtf8Bytes implementation. Short byte arrays raise
IndexOutOfBoundsException and oversized arrays read only their first 16 bytes.
The original permissive base-36 mapNotNull parser is unchanged.

The recursive disk-file hash and disk-file constructor are split only after a
conservative scan of every actual retained source. Every unknown reference to
calculateKlibHash or SerializedKlibFingerprint, including aliases, comments and
strings, rejects that split. The accepted reader statements are the real KLIB
manifest type, parser and serialized-file-list constructor. The full scanned
input graph is preserved as a compressed, hash-bound snapshot, so verification
can repeat the guard after later independent composer edits.

`prepareCompilerFingerprints({sourceRoot, outputRoot, retainedSources})` takes
the exact pinned original source cache and retained input entries with `path`,
`filename`, `bytes` and `sha256`. It returns `commonSources`,
`replacedOriginalPaths`, `receipt` and `receiptPath`. The output is isolated below
`outputRoot/compiler-port-fingerprints`. `verifyCompilerFingerprints(root)`
reconstructs pinned transforms and scans the recorded actual source graph.
No original cache files are changed. Supply inputs after linker/backend source
selection, while the actual FileFingerprints original remains selected.

The differential probe compiles original JVM, common JVM and genuine wasmJs.
Its compiler-object test projection uses the actual official
SerializedDataStructures.kt carrier and complete IR file/list algorithms. Only
the KotlinLibrary-reader overload is omitted from the probe; it remains in the
shipping source. Disk APIs are not exercised. This boundary evidence does not
establish full compiler or offline browser source compilation readiness.

The [actual differential receipt](evidence/differential.json) records 99 equal
observations across those three executions and the completed private log/status
hashes. [Exact observations](evidence/observations.txt) cover hash length and
offset boundaries, high-bit byte serialization, short/oversized arrays,
permissive parsing, malformed UTF-16, IR file parts and ordered KLIB lists.
The disk-exclusion guard scanned all 3,441 actual frozen compiler source inputs.

```sh
node --test producer/kotlin-browser/compiler-port/fingerprints/prepare.test.mjs
node producer/kotlin-browser/compiler-port/fingerprints/probe.mjs \
  --source-root "$PWD/out/kotlin-compiler-port/sources" \
  --frozen-build-root "$PWD/out/kotlin-compiler-port/builds/ACTUAL_COMPLETED_RUN" \
  --output "$PWD/out/kotlin-fingerprints-new-run"
```

Run compilation in a background process with a private log and exit-status file.
Public language readiness remains false until the full acceptance gates pass.
