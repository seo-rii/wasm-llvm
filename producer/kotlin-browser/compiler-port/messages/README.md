# Compiler message host boundary

This patch family prepares the actual selected `CompilerMessageSeverity`,
`CompilerMessageLocation`, `MessageCollector` and `MessageCollectorImpl` sources
for the compiler's Wasm host. Location constructors, null/range defaults,
formatting, error predicates, collector order, forwarding and diagnostic-ID
dispatch retain their upstream bodies. JVM serialization and default bridge
annotations stay in the original JVM reference input.

The mutable `VERBOSE` enum set uses a common membership adapter with enum order
and iterator snapshot/removal behavior. Its JVM serialization and EnumSet-specific
clone APIs are outside the compiler's selected uses. These JVM facilities are
not exposed as browser capabilities.

`prepareCompilerMessageSources({ sourceRoot, outputRoot })` verifies original
Git blobs/SHA-256 and local adapter/preparer hashes, then returns five common
sources and four `replacedOriginalPaths`. Preparation preserves original bytes
and creates outputs without overwriting completed evidence.

Run the actual source differential with a fresh producer output directory:

```sh
node producer/kotlin-browser/compiler-port/messages/build-probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output out/compiler-messages-probe/unique-run
node --test producer/kotlin-browser/compiler-port/messages/integrity.test.mjs
```

The probe compares original JVM, common JVM and common Wasm execution of the
actual message sources. The [actual differential receipt](evidence/differential.json)
records 299 equal observations across those hosts, including every severity-set
membership mask, mutation during iteration, Unicode/ranges, error collection,
forwarding, clearing and diagnostic-ID dispatch. Five preparation guards passed.
Wasm used Node 24.1.0 with `--experimental-wasm-exnref`; this is not a browser run.
It does not compile user Kotlin. Browser execution of
this component, full FIR diagnostics, the callable compiler and fresh browser
source compilation remain separate gates. Public Kotlin readiness stays false.
