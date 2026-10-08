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

The build receipt distinguishes input preparation, the compiler KLIB build,
binary/export integration and public readiness. Even a successful compiler KLIB
would leave browser compilation `not-built` until a nonempty callable compiler
binary compiles previously unseen inputs offline and those generated artifacts
run in the browser. Missing dependency variants, Java implementations and PSI
diagnostic boundaries remain concrete source-port blockers. No remote compiler,
fixed-example emitter or precompiled program fills these gaps.
