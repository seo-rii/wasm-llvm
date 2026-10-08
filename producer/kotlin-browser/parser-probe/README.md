# Official parser JVM / wasmJs probe

This G1 probe builds the unchanged `compiler/multiplatform-parsing` Kotlin
sources from `4d78aae1e337cd40f69baa865aed950fe807a775` twice: on JVM and on
`wasmJs`. `recipe.json` pins the Git blobs, SHA-256 values, sizes and exact
platform library artifacts. The published bootstrap is `2.5.0-dev-10106`,
selected by that source revision; its own source commit remains unknown.

The checked-in [browser evidence](evidence/g1-parser.json) records an actual
Chromium 153.0.8010.12 Worker run: all 17 corpus cases have identical lexer
tokens and prepared parser productions on JVM and wasmJs, including error
ranges/messages, BOM, CRLF, Korean, supplementary Unicode and a long input.
The generated parser Wasm is 2,142,123 bytes. No browser engine feature flags
were added. Required, passed, failed, skipped and not-run counts are separate.

`Probe.kt` observes the official parser. It serializes lexer token kind and
UTF-16 offsets before soft-keyword remapping, followed by the official prepared
production marker sequence: open/close/error, node type, offsets, token indices,
error text and collapsed state. This is the parser's production-tree
representation; it is not a separate Kotlin parser or emitter. `JvmEntry.kt`
only supplies UTF-8 fixture files, and `WasmEntry.kt` exports a string boundary.
The Kotlin sources and checked-in generated lexer are copied without edits.
The two `.flex` inputs and skeleton are also locked; JFlex regeneration was
not executed.

The JVM build uses the installed OpenJDK 17.0.20.1, recorded in evidence. This
standalone CLI probe does not run the upstream Gradle build or verify its JDK21
toolchain. Kotlin language/API version 2.5, common-source selection, assertions
and array bounds checks are explicit in the recorded commands. Matching
`wasmJs` libraries are used for this parser; no `wasmWasi` stdlib is mixed in.

From the repository root, use a fresh output directory. The shared bootstrap
adds about 71 MiB; parser library artifacts add about 1.2 MiB and the unchanged
parser source inputs add 444,378 bytes. Python 3, Java, Node and the sibling
`wasm-idle` Playwright Chromium installation are required. `--playwright-from`
can select another package.json with `playwright-core` installed.

```sh
umask 077
mkdir -p "$HOME/logs"
chmod 700 "$HOME/logs"
log_file=$(mktemp "$HOME/logs/kotlin-parser-g1.XXXXXX.log")
probe_output=out/kotlin-parser-probe/my-fresh-run
(
  trap 'status=$?; printf "%s\n" "$status" > "$log_file.exit"' EXIT
  set -e
  node producer/kotlin-browser/build/bootstrap.mjs prepare
  python3 -B producer/kotlin-browser/parser-probe/prepare.py --output "$probe_output"
  python3 -B producer/kotlin-browser/parser-probe/build.py \
    --bootstrap out/kotlin-browser-bootstrap/2.5.0-dev-10106 \
    --output "$probe_output" --max-heap-mib 1024
  node producer/kotlin-browser/parser-probe/browser-probe.mjs \
    --output "$probe_output" --evidence "$probe_output/g1-parser.json"
) </dev/null >"$log_file" 2>&1 &
task_pid=$!
printf '%s\n' "$task_pid" > "$log_file.pid"
```

Monitor the exit sidecar while running. After exit, inspect a bounded log tail.
`prepare.py --source-cache <directory>` optionally reuses exact verified source
bytes. All cached source and dependency bytes are verified before compilation;
the browser also verifies generated assets and baseline snapshots before use.
Generated Wasm, JAR, KLIB and downloaded dependencies stay under ignored `out/`.
The evidence binds inputs, observer sources, build commands, baseline snapshots
and generated assets to hashes; elapsed times are raw observations of this run.

Cache reads reject symlink files/parents, non-regular files, invalid size pins
and files larger than their pin before reading. A same-size hash mismatch also
fails. Complete input and build receipts are published atomically and never
replaced; identical prepared inputs can be reverified, while a new build needs
a fresh output directory. Compilation failures publish a failed receipt;
an earlier receipt remains immutable. Focused checks require no compiler or downloads:

```sh
python3 -B producer/kotlin-browser/parser-probe/integrity_test.py
```

The guard changes were made after the recorded G1 build. The original build and
browser evidence remain unchanged. [Final integrity preflight](evidence/g1-parser-preflight.json)
uses the current guards to reverify all 27 source files, six parser libraries,
nine bootstrap artifacts, observer/fixture/harness inputs and completed output
bytes. It records the final tool hashes and seven passing guard tests. No new
compiler or browser run is claimed. To verify another completed output, use:

```sh
python3 -B producer/kotlin-browser/parser-probe/verify.py \
  --bootstrap out/kotlin-browser-bootstrap/2.5.0-dev-10106 \
  --output out/kotlin-parser-probe/my-fresh-run \
  --g1-evidence out/kotlin-parser-probe/my-fresh-run/g1-parser.json \
  --evidence out/kotlin-parser-probe/my-fresh-run/g1-parser-preflight.json
```

The harness serves hash-verified local assets through Playwright routes, then
makes the context offline. Parsing the corpus requests no additional assets or
external network. A synchronous 2,477,780 UTF-16-unit stress input is interrupted
with external `Worker.terminate()`, and a fresh Worker parses a normal case
again. Fresh Workers receive the prepared local assets; this does not establish
offline application-shell or cache restart. Main-thread heartbeat and the
observed termination delay are recorded, without claiming a performance target.

G1 establishes host equivalence for this bounded corpus of the same new parser.
Old-parser comparison, Raw/resolved FIR, compiler diagnostics, common/target
checkers, KLIB semantic reading, IR, backend and browser source compilation
remain unexecuted by this probe. One Chromium configuration does not establish
a browser matrix or a GC/JS heap hard cap. Public Kotlin language readiness
remains false.

The next Raw-FIR boundary is recorded in
[five reviewed source pins](evidence/raw-fir-boundary.json). The new parser's
FIR adapter still wraps Java light-tree interfaces in `KtLightSourceElement`,
and `KtSourceFile.getContentsAsStream()` still exposes `java.io.InputStream`.
The in-memory `AbstractTree2Fir` overload therefore does not by itself close
the wasmJs source dependencies. These exact blobs were reviewed and hashed;
they were not compiled or executed by G1.
