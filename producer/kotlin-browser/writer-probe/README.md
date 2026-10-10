# Official ByteWriter portable unit probe

This producer experiment rehosts the selected official Kotlin `ByteWriter.kt`
and its LEB128 helper on JVM and wasmJs. It is one G2 unit, not the whole G2 gate
or a browser Kotlin compiler. It accepts no user Kotlin program, constructs no
FIR/IR, and does not register a public language.

The selected source is Kotlin commit
`4d78aae1e337cd40f69baa865aed950fe807a775`. [sources.lock.json](sources.lock.json)
pins the original SHA-256, Git blob, patch bytes and transformed SHA-256.
[writer-portable.patch](writer-portable.patch) makes only these host changes:

- `OutputStream` becomes `ByteSink`. The integer and LEB128 encoding methods and
  both backpatch bodies stay byte-for-byte unchanged.
- The exposed `ByteArrayOutputStream` buffer/count becomes a common
  `BoundedByteSink`. Its default output limit is 8 MiB.
- `WasmBinaryData.writeTo` writes to a sink. The JVM file extension and stream
  wrapper live in `JvmByteSink.kt`, under the separate `JvmWasmBinaryData` import.
- Two unused `java.io` imports are removed from `Leb128.kt`; all helper function
  bodies, including readers, stay unchanged.

Original and transformed upstream sources are generated only under `out/`.
The build applies and reverse-checks the patch in an isolated copy, verifies
both source hashes, and separately compares the unchanged encoding/backpatch
bodies. No generated Wasm, KLIB or JAR is checked in.

`BoundedByteSink` preserves the low-byte writes, little-endian data, buffer
growth, forward offset extension and existing buffer snapshot ownership used
by this corpus. Range/limit checks occur before an individual sink write changes
data. A composite writer call is not transactional: it can have already written
some bytes before a later sink write exceeds the limit. Discard a writer after
any sink error. The byte limit does not bound total GC/JS heap use.

The probe is not a replacement backend module yet. JVM file-extension imports
and callers still need integration, the new output limit is an explicit host
policy, and the existing compiler's remaining dependencies are outside this
unit's closure.

## Actual comparison

[writer-byte-equality.json](../evidence/writer-byte-equality.json) records the
actual JVM and Chromium 153.0.8010.12 Worker execution. Original JVM, portable
JVM and portable wasmJs produced identical bytes for all 82 required cases;
none failed, skipped or remained unexecuted. Ten additional sink guards matched
between portable JVM and wasmJs. Seventeen hand-checked byte examples, JVM file
output equality and a repeated browser invocation also passed.

| Corpus | Cases |
| --- | ---: |
| Unsigned LEB128, including the upstream round-trip boundaries | 13 |
| Fixed five-byte unsigned LEB128 | 9 |
| Signed byte/Int/Long LEB128, including Long extrema | 36 |
| Boolean and little-endian integer widths | 2 |
| Float/Double raw integer bit payloads, including NaN patterns | 14 |
| Buffer growth, backpatch, snapshot ownership and file output | 8 |

Float/Double cases encode the integer bits passed to the official writer;
they do not test floating-point arithmetic or `toRawBits` conversion. The
upstream unsigned overflow/overlong rejection cases and an unsupported integer
width are checked on each host. The JVM file adapter writes the same 65-byte
payload as the original `WasmBinaryData` file extension.

The actual writer Wasm is 744,164 bytes. This is a writer-unit artifact size,
not a whole-compiler size or product estimate. The compiler and libraries used
to build it are the official selected bootstrap version `2.5.0-dev-10106` from
[the shared pinned bootstrap recipe](../build/README.md). That precompiled
compiler's source commit is unproven; the receipt keeps it `null`. The writer
source revision and bootstrap artifact identity are recorded separately.

Static generated loader modules and Wasm were hash-verified and supplied from
local prepared files. The browser went offline after Worker initialization;
the writer calls made zero network requests. This does not test offline app-shell
restart, persistent caching, a full offline compiler, other browsers, a GC heap
hard cap or product performance targets.

## Reproduce

First prepare the [shared bootstrap artifact cache](../build/README.md). An
optional `--source-root` supplies an existing selected-pin source cache; omitted,
the builder downloads only the three byte/hash-pinned upstream files. Choose
a fresh output directory under this repository's `out/` on every rebuild.

```sh
node producer/kotlin-browser/writer-probe/build.mjs \
  --source-root /path/to/pinned/kotlin-sources \
  --output out/kotlin-bytewriter-probe-new
node producer/kotlin-browser/writer-probe/browser-probe.mjs \
  --output out/kotlin-bytewriter-probe-new \
  --evidence out/kotlin-bytewriter-probe-new/writer-browser.json
```

Run long commands in the background with a restricted log file according to
the workspace rules. The browser runner loads `playwright-core` from the sibling
`wasm-idle` installation and always launches Chromium. `--playwright-from` can
select another installed package location. Its external Worker deadline covers
both initialization and execution.

The build receipt records every command, exit status, source/patch/observer
hash, bootstrap artifact hash and output hash. The browser runner rejects stale
source/observer/build assets before execution. It creates an evidence file only
after actual comparisons pass; it never fills missing execution with success.

The upstream ByteWriter and helper carry JetBrains and Android Open Source
Project notices respectively. Their Apache 2.0 headers are preserved in all
generated sources. See [LICENSE.kotlin.txt](../LICENSE.kotlin.txt).
