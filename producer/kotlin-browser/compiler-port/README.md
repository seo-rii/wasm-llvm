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
The [source-free diagnostic DSL](diagnostic-dsl/README.md) supplies the original
property delegates used by CLI and backend containers, retaining actual keys,
factory identity and lazy renderer lookup.
The [source-bearing delegates](diagnostic-source-dsl/README.md) retain the
original backend containers and payloads while removing their PSI class
metadata. Preparation checks the final selected caller inventory, and the
composer imports common JVM annotations on the newly generated tables.
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

The [binary reader source profile](binary-reader-profile/README.md) preserves
the original input-Wasm reader as a reference and omits it from the emit-only
whole-program compiler only after checking every final selected input. A new
reader dependency or incremental Wasm deserializer rejects this profile.

The [K1 reflection-container profile](k1-container-profile/README.md) verifies
every final compiler input before excluding eleven unused DI sources. It keeps
the real marker, annotation, remaining analyzer services and ModuleInfo, and
rechecks the complete selected source list after the three exact splits.

The [Wasm collection bindings](wasm-collections/README.md) layer three audited
serial cache operations and an ascending annotation snapshot over the verified
identity and UTF-8 variants. The composer verifies and supersedes those exact
predecessor files once; their original preparation receipts remain recorded.

The [final Cone equality guards](cone-class-identity/README.md) replace three
JVM class checks only after verifying the complete identity predecessor. The
final classes reject the same arguments, and all payload comparisons and hash
statements remain unchanged. The common layer supersedes that exact source;
its focused JVM and method-boundary evidence does not prove the full Wasm type
graph.

The pinned [JavaScript AST port](js-ast/) supplies all selected Java nodes and
their original Kotlin companions. Its typed property imports bind the existing
compiler consumers, and shared SmartList and assertion sources are verified and
selected once. The [signed integer consumer binding](js-ast-consumer-bindings/integer/)
connects the genuine deserializer to that exact AST integer source. Its valid
byte and eight malformed contracts match across four hosts; a retained integer
overflow case has different failure categories. ByteBuffer, external readers,
full arithmetic consumers and retained host-list factory differences remain
separate limits of the whole compiler.

The separate [AST byte-length layer](js-ast-consumer-bindings/integer-bounds/)
verifies that exact integer predecessor and guards its real shared `readBytes`
before copying or allocating. Negative, overflow and truncated payload lengths
now have one explicit rejection contract. Normal serialized bytes remain exact;
this does not supply ByteBuffer or close the full deserializer.

The [backend exception-name boundary](backend-exception-text/) preserves the
existing JVM-qualified String protocol using the original two literal names.
It verifies and replaces the sourced-DSL backend table once before annotation
imports. Its full JVM table and exact-lambda Wasm evidence retain the original
message-first behavior; they do not establish host exception-to-protocol
generation or full diagnostic-table Wasm closure.

The [full descriptor member comparator](member-comparator/) supplies both
original ordering algorithms, using genuine descriptor and renderer APIs. Its
full JVM differential covers 38,090 raw observations, while closure of the
common descriptor and renderer graph remains a whole-build requirement.

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
