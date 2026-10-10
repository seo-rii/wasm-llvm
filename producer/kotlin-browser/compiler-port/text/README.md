This unit binds the selected official Wasm binary/text writers to common UTF-8 functions. Both writer files retain their original algorithms; preparation only inserts the explicit `compilerUtf8Bytes as toByteArray` import. User source is never transformed.

The selected Kotlin/JVM `String.toByteArray()` delegates to `java.lang.String.getBytes(UTF_8)`. Each unpaired UTF-16 surrogate becomes one ASCII `?` byte. The selected common Wasm encoder instead emits U+FFFD, so replacing that call with `encodeToByteArray()` would change binary string lengths and WAT output. The original stdlib encoding tests explicitly distinguish these host behaviors.

`generate.mjs` mechanically adapts the unchanged, pinned official Wasm stdlib `utf8Encoding.kt` in `upstream/`: it changes the namespace, malformed-input exception boundary, surrogate replacement bytes, and encoded-surrogate decoding group. All other code-point, continuation, shortest-form, range and UTF-16 pair algorithms stay in the official source. `CompilerUtf8Api.kt` preserves selected stdlib slice bounds ordering/messages. Input strings and decoded output are not normalized.

`compilerUtf8String()` uses Kotlin/JVM replacement grouping, including one U+FFFD for a UTF-8 sequence encoding a surrogate. Strict mode throws a common `CharacterCodingException` subtype carrying the malformed sequence length and absolute byte offset. Its message matches the JVM malformed-input message. The Java exception class name is not emulated.

`WasmBinaryToIR.readString()` uses the JVM decoder directly to reject malformed input. This unit records that policy and provides the equivalent strict operation, but its `InputStream`/`ByteBuffer` reader boundary still needs separate integration. The decoder is never silently switched to replacement mode.

Preparation is independent of the frozen backend patch:

```sh
node producer/kotlin-browser/compiler-port/text/prepare.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output out/kotlin-text-inputs
```

`prepareCompilerTextSources({sourceRoot, outputRoot})` returns four `commonSources`, two `replacedOriginalPaths`, `receipt` and `receiptPath`. `verifyCompilerTextPreparation(directoryContainingReceipt)` checks original, generated, import-bound and helper bytes. Root composition should remove the two original writer inputs and add these four sources, then apply its optional JVM-annotation imports. No existing backend patch or build entry is edited here.

The reproducible differential requires the eight pinned stdlib reference files under a selected source checkout/cache; it does not download or build a complete Kotlin checkout:

```sh
node producer/kotlin-browser/compiler-port/text/build.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --stdlib-source-root /path/to/pinned-stdlib-sources \
  --output out/kotlin-text-probe
KOTLIN_TEXT_PREPARED="$PWD/out/kotlin-text-probe/compiler-port-text" \
  node --test producer/kotlin-browser/compiler-port/text/integrity.test.mjs
```

The probe uses selected original writer method bodies and the existing verified ByteWriter/LEB128 port, rather than a replacement Wasm emitter. It compares original JVM, common JVM and actual wasmJs observations for every UTF-16 single unit, representative supplementary pairs, all one/two-byte UTF-8 inputs, three/four-byte boundary combinations, truncated slices, Korean, supplementary code points, malformed surrogates, BOM, CRLF, WAT escapes and UTF-16 location counters. Length-prefix cases cross 127/128 and 16383/16384 byte boundaries. Existing `StringBuilderWithLocations` behavior is observed unchanged, including its `append(Char)` behavior.

The recorded run passed all 148,323 observations across the three hosts and all nine source/evidence integrity guards. [Differential receipt](evidence/differential.json) records the exact commands, source/tool/artifact hashes and comparison groups; [preparation receipt](evidence/preparation.json) records the import-only writer bindings. The final background process exited 0; its restricted log is `/home/seorii/logs/kotlin-compiler-text-differential-z3688unv.log`. Strict decode compares malformed length and absolute byte offset; strict encoding and Java exception subclass identity are outside this recorded comparison.

The bootstrap compiler and runtime stdlib artifact source revisions remain unknown; their verified artifact hashes and exact commands are recorded. This dependency probe is not a selected-source whole-compiler R0/R1 run, browser compilation, Kotlin language acceptance or a complete Wasm writer acceptance. Browser comparison is separately `not-run`; public readiness remains false.
