# Official Kotlin compiler inside the browser

The compiler host is wasmJs. Fresh user Kotlin is intended to follow the official
new parser → FIR resolution/common and target checkers → FIR2IR → KLIB
serialization/linking → Wasm lowering/code generation → binary writer route.
The initial program target is wasmWasi / WASI Preview 1, independently from the
compiler's host target. The locked development source is
`4d78aae1e337cd40f69baa865aed950fe807a775`.

**The full compiler is not built, and browser source compilation is not working.**
The actual whole-source wasmJs build currently fails. Parser, codec, library and
host-helper checks establish their individual boundaries only. Native-built
Hello World/Fibonacci programs are console-runtime fixtures; they do not advance
browser compiler acceptance. Public Kotlin support remains disabled.

[The failed whole compiler build](evidence/compiler-build-failure.json) records
the actual input hashes, source profile, tool/library identities, exited command
and bounded diagnostic summary. Diagnostic totals include cascades and do not
measure independent defects or language support. The failure recorder accepts
only an exited compiler invocation and publishes evidence with exclusive creation.

Prepare the [locked original source inputs](closure.README.md), bootstrap
artifacts, official parser dependency artifacts and
[protobuf dependency](serialization/README.md). Then run the real compiler build:

```sh
node producer/kotlin-browser/compiler-port/build.mjs \
  --input out/kotlin-compiler-port \
  --protobuf-build out/kotlin-compiler-serialization/probe-8/codec
```

Follow the workspace's private background-log/exit-sidecar procedure. The default
build creates a fresh directory under `out/kotlin-compiler-port/builds/`, verifies
all input hashes, prepares each patch family in an independent snapshot, records
required compiler-only flags and invokes the official bootstrap toolchain on the
portable compiler sources. It never compiles a user example on the JVM as a
substitute for the browser compiler. An optional `--source-host original` attempt
keeps the original JVM source boundaries as a recorded build failure baseline;
it is not the upstream JVM reference compiler R0.

The portable source profile excludes the legacy PSI2IR source frontend. It keeps
the official FIR2IR, common IR tree, complete Wasm lowering and binary backend.
The receipt lists every excluded source hash and conservative checks for retained
references to that frontend's shared declarations. This source selection does
not establish the full compiler's symbol closure.

Compiler-only import bindings connect the real common companion members and
expand legacy token/node object imports from the verified declaration inventory.
The receipt records every changed source hash. Original user source text never
enters any compiler-source patch or import transformation.

The [parser profile](parser-profile/README.md) selects the official new parser in
the FIR source entry while retaining resolution and checkers. The
[diagnostic factory variant](diagnostic-factories/README.md) separates unused PSI
class metadata from the factory and generated registration tables, preserving all
969 diagnostic declarations. Its original class bindings remain recorded; an
unexpected reader of that metadata fails source preparation. The
[message models](messages/README.md) and [UTF-8 boundary](text/README.md) preserve
the original compiler's message and binary-writing behavior. Their helper
comparisons do not establish full diagnostic or source-to-program correctness.

The [supplemental source closure](source-closure/README.md) restores the complete
Web Common checker module and selected original CLI configuration/reporting
declarations at the same source revision. Original source identities are checked
before the selected common variants enter compilation. The original Web Common
default message table is selected once, through
[diagnostic rendering](diagnostic-rendering/README.md). The formatter uses an
explicit en-US String/Int profile, recorded in the compiler build receipt.
The [common diagnostic inputs](diagnostic-common/README.md) retain original
parameter renderers, language-feature messages and their generated flag map.
The compiler host also uses the source-version-pinned official immutable
collections wasmJs KLIB; its provenance and bytes are verified before linking.

The [FIR storage port](fir-storage/README.md) retains the real FIR2IR cache,
expect/actual storage and serial lock bodies. The
[BitSet port](bit-set/README.md) binds the unchanged liveness-analysis and bit
traversal bodies to the pinned OpenJDK word algorithms. Their original JVM,
common JVM and Wasm comparisons establish selected host API behavior. They
do not establish complete FIR execution or whole compiler acceptance.

The [fingerprint port](fingerprints/README.md) retains original CityHash,
serialized IR-file and KLIB-list fingerprint algorithms. Its disk-only overload
is split after scanning and recording every selected compiler input, including
the actual browser entry. An unknown retained reader rejects that selection.

The [version source port](versions/README.md) supplies the official Maven and
Kotlin tooling version algorithms and compiler version resource from an explicit
[producer input](compiler-version-input.json). The selected upstream default is
`2.5.255-SNAPSHOT`, independently of the bootstrap artifact version and target
stdlib. Source preparation verifies its input digest and upstream resource and
property rules. This resource identifies the attempted compiler source build; it
does not establish an accepted compiler/target library pair or execute upstream
Gradle resource generation.

`entry/BrowserCompiler.kt` directly constructs the WasmWasi FIR sessions and uses
`MultiplatformParsing2Fir`; it does not initialize KotlinCoreEnvironment or
discover services/plugins. Syntax errors stop before resolution and do not
produce an IR result. Complete common/target checkers and official FIR2IR remain
in the selected source set. Its result retains the actual FIR files alongside IR
so the official metadata serializer can consume them.

`entry/BrowserCompilerPipeline.kt` assembles that frontend, metadata/IR KLIB
output, memory library loading, official IR linker, lowering, entry detection,
whole-program code generation and bounded binary output. This assembly has not
compiled or executed; unresolved real dependency implementations still block
the compiler host build. It also needs an approved configuration initializer and
thin JS export boundary before it can be called in a Worker.

`linker` preserves the official metadata/IR serializer, full-rebuild library
linking, dependency generation and post-processing while supplying immutable
memory KLIBs. `backend` retains whole-program Wasm code generation, IR linking
and byte writing, with bounded memory output. Their source preparations are
connected to the whole compiler build. A source hash or a compilable helper does
not establish source-to-program correctness.

The [backend source profile](backend-profile/README.md) is applied last, against
the actual prepared whole-program driver, browser entry and composed compiler
inputs. It splits shared declarations from JS executable and incremental-cache
shells and rejects retained references to any declaration it excludes. The
official Wasm phase order, shared JS lowerings and configuration predicates remain
selected. Shared JS context/AST and stream dependencies that this profile does
not close remain explicit build blockers.

The build receipt distinguishes input preparation, the compiler KLIB build,
binary/export integration and public readiness. Even a successful compiler KLIB
would leave browser compilation `not-built` until a nonempty callable compiler
binary compiles previously unseen inputs offline and those generated artifacts
run in the browser. Missing dependency variants, Java implementations and PSI
diagnostic boundaries remain concrete source-port blockers. No remote compiler,
fixed-example emitter or precompiled program fills these gaps.
