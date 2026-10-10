# Request-owned source-map text IO

This independent host protocol provides working byte files owned by one request,
UTF8 read snapshots, buffered UTF16 character output, and separate debug printing
to an actual synchronous byte sink. It uses no Java package facade. Initial byte
arrays and returned byte snapshots are copied; file handles retain their exact
virtual key and display spelling. Opening an overwrite sink truncates immediately,
and each opened sink retains its own cursor against the same working file.
CR, LF, CRLF, UTF8 BOM and malformed decoding keep the selected Kotlin/JVM file
effects. Compiler input source snapshots remain a separate immutable component.

The writer owns an 8192-character buffer and an 8192-byte UTF8 encoder buffer.
It carries high surrogates across writes and flushes; close finalizes an unmatched
surrogate with the verified UTF8 replacement byte. The real common UTF8 algorithm
and API, the AST source reader and the `CompilerByteSink` interface are shared
dependencies with exact owner, canonical output path, byte and SHA-256 bindings.
The existing byte-stream close implementation is not used by this writer.

Close behavior is checked against the installed OpenJDK `17.0.20.1+1` oracle.
The referenced upstream `jdk17u` revision is
`c35a8d5a87559ad2734f1023bb321176c13c7ba0`. Both its selected stream encoder and
buffered writer use Java resource suppression. An earlier prototype based on
the older JDK 17 initial-release finally-close rule was rejected: its 480 raw
differences, source/jar/output pins and exited private log remain in
`evidence/host-close-negative.json`. The accepted protocol must preserve the
current oracle's primary exception, suppressed identities and self-suppression
failure, followed by the genuine Kotlin `use` action-failure rule.

Two later rejected edge cases are preserved in `evidence/host-edge-negative.json`:
an empty write incorrectly extended a file after a second writer truncated it,
and a failed one-byte encoder flush incorrectly prevented a following four-byte
code point. Empty byte writes now validate the range and return before inspecting
closed state or moving a cursor, matching the native file oracle. Encoder overflow
restores capacity even when a previous failed write left an empty flipped buffer.

`SourceMapPrintOutput` writes encoded bytes to a caller-supplied sink. Selected
`SourceMapIoFailure` exceptions set its sticky error state; runtime exceptions
propagate. Print operations drain character and byte buffers without finalizing
a pending surrogate. Optional automatic flushing and repeated close preserve
the selected PrintStream effects. `captureSourceMapDebug` performs real byte
encoding and UTF8 decoding, retaining the original unclosed capture behavior.
There is no implicit global stdout, current-request registry or silent default
destination. Runtime integration must supply the real request stdout explicitly.

The two shipping helpers are independently written under Apache-2.0. The four
OpenJDK reference files remain unmodified, separately downloaded, hash-verified
inputs under their original GPL-2.0-with-Classpath-exception notices. They are
not copied into the shipping helpers. Three complete genuine Kotlin source-map
runtime files are also retained as rooted reference inputs. Their algorithms
and methods are not yet compiled or replaced by this protocol unit.

The observer runs the actual JDK BufferedWriter/OutputStreamWriter/PrintStream
and native temporary files, then the common implementation on JVM, Node Wasm
and an offline Chromium module Worker. It checks IO/runtime failure matrices,
shared exception identities, byte effects, call order, all 65,536 UTF16 code
units, surrogate carry and buffer edges, CR/LF/BOM/malformed file text,
truncation, defensive copies and independent cursors after a second overwrite.
It also checks empty writes after truncation and close, invalid closed-write ranges,
mixed IO/runtime failures and exceptions during large buffered encoding.
No oracle assertion or failure result is normalized away.

The sealed profile passed 5,315 exact records on all four hosts, eight exited
commands and ten integrity guards with zero skipped cases. These include 3,072
writer failure combinations, 2,048 print failure combinations, 96 failures during
large buffered encoding, four failed-buffer recovery cases and the file and
character boundary cases above. The runtime check exited 0 in 104.215 seconds;
its 29 generated artifacts and private log/status pins are recorded in
`evidence/receipt.json`, alongside the raw rejected profiles. A terminated
intermediate oracle build produced no runtime comparison and was not counted.

These are virtual byte-file and selected text-output contracts. Native path
canonicalization, directory permissions, symlinks, concurrent threads,
ThreadDeath, InterruptedIOException thread interruption, all Java Writer APIs,
other charsets, live native file-reader views and allocation-exhaustion classes
are outside this profile. Read-only source readers intentionally capture the
decoded byte snapshot and expose the existing AST closed-reader boundary.
Byte-file capacity is checked in the Int domain before growth. Files and
snapshots consume linear space; encoder temporary allocations are bounded by
the character chunk, and encoding/decoding and writing take linear time.
No maximum-memory or whole-compiler resource acceptance is claimed.

`prepareSourceMapTextIo({outputRoot})` and `verifySourceMapTextIo` with the
additional `receiptPath` verify the pinned references, tools, dependencies and
entire expected receipt. They publish exactly two common sources, no original
replacements, and four shared dependency bindings. Original SourceMap parser,
remapper and file/debug caller integration, default stdout injection and the
source-map builder remain separate unfinished work. Full parser runtime,
request-stdout installation and browser compiler readiness stay false.

Run the focused checks using compatible verified Node and private background logs:

```sh
node producer/kotlin-browser/compiler-port/source-map-text-io/check.mjs
node producer/kotlin-browser/compiler-port/source-map-text-io/integrity.test.mjs
```

The check rejects a different JDK oracle version until references and proof are
updated. `update-recipe.mjs` regenerates pins from the immutable source and
OpenJDK reference caches; changing implementation or tools requires repeating
the affected comparisons and guards.
