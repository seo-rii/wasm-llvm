# Kotlin browser compiler candidate

This producer starts the direct source port of the official Kotlin compiler:
parser → FIR resolution/checking → FIR2IR → KLIB/IR linking → Wasm backend.
The intended compiler host is `wasmJs`; the initial user console target is
`wasmWasi` with WASI Preview 1. These are separate library/build sets.

**Status: source inventory only; G0 blocked; browser compiler not built.**
There is no compiler Wasm, generated loader, target stdlib bundle, release receipt,
or public Kotlin support in this change. GraalVM Web Image, TeaVM hosting, remote
compilation, and a handwritten Kotlin subset are outside this implementation path.

## Source and evidence

`manifest.json` is a producer candidate configuration, not a runtime release
manifest. `sources.lock.json` binds selected source files to both upstream Git
blob IDs and SHA-256. The Kotlin pin is the development candidate
[`4d78aae1e337cd40f69baa865aed950fe807a775`](https://github.com/JetBrains/kotlin/tree/4d78aae1e337cd40f69baa865aed950fe807a775),
not a stable Kotlin release or a verified browser compiler version.

The lock records bootstrap Kotlin `2.5.0-dev-10106`, daemon JDK 21, Gradle 9.7.1,
generator inputs/outputs, and relevant upstream dependency declarations. A checksum
copied from upstream dependency verification is distinguished from downloaded,
hash-verified artifact bytes. Bootstrap/compiler/JDK/generator artifact closure is
still incomplete.

Reproduce the source audit from pinned remote files into a fresh directory:

```sh
pnpm audit:kotlin-source -- --output out/kotlin-browser-audit
pnpm ledger:kotlin-fixtures -- --output out/kotlin-browser-fixtures.json
pnpm test:kotlin-producer
pnpm check
```

For an existing same-pin checkout, add `--source-dir /path/to/kotlin` to the audit.
The audit validates the checkout revision and file identities and does not modify
or build upstream source. Output files are created without overwriting existing
evidence. Source downloads are build-time operations; this command is not a browser
compiler or a runtime fallback.

`dependency-audit.json` records source-verified production project declarations,
settings project-directory mappings, strongly connected components, ignored
test-only declarations, and unresolved dependencies. Declared target names are
not resolved Wasm variants. Static source inspection cannot close conditional
Gradle configuration, convention plugins, external dependencies, compiler symbols,
or generated-code reachability; these remain explicit blockers.

`fixture-ledger.json` binds unchanged upstream parser fixtures and local console/
semantic/error fixtures to their hashes. R0 (old parser), R1 (new parser), R2
(portable JVM), and R3 (browser compiler) all remain `not-run`, with null observed
results. Expected behavior is a test target, not an execution observation. Skips,
failures, and unexecuted cases cannot be counted as passing language tests.

Checked-in `evidence/` contains actual source-audit output, not compiler acceptance.
The audit process can exit successfully while its G0 result remains blocked.
Copied upstream fixtures retain their exact bytes and are accompanied by
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the pinned upstream license.

## Verified boundaries

- [The official parser build](https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/compiler/multiplatform-parsing/build.gradle.kts)
  declares JVM/wasmJs targets and generated Kotlin lexers. Published syntax API
  metadata also declares a Wasm JS variant; candidate linkage/execution is untested.
- [The parser-to-FIR build](https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/compiler/fir/raw-fir/mp-parsing2fir/build.gradle.kts)
  remains JVM with light-tree and IntelliJ dependencies. Its builder has the
  [KT-89414 error-listener TODO](https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/compiler/fir/raw-fir/mp-parsing2fir/src/org/jetbrains/kotlin/fir/builder/MultiplatformParsing2Fir.kt).
- [The convenience FIR entry](https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/compiler/fir/entrypoint/src/org/jetbrains/kotlin/fir/pipeline/firUtils.kt)
  selects the new parser as `false`; common and target checker execution must both
  be preserved by the new portable entry.
- [The Wasm backend build](https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/compiler/ir/backend.wasm/build.gradle.kts)
  is JVM and includes JS/PSI-related dependencies. Parser target availability does
  not establish compiler portability.
- [Kotlin WASI I/O](https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/libraries/stdlib/wasm/wasi/src/kotlin/io.kt)
  requests 20/26-byte poll allocations; pinned
  [Preview 1 structures](https://github.com/WebAssembly/wasi-libc/blob/165235bc467d5fa52d424f5d82587dfb76ed9d54/libc-bottom-half/headers/public/wasi/wasip1.h)
  require 48/32 bytes aligned to 8. Actual allocator behavior, canary damage with
  Kotlin output, and any required stdlib patch remain untested.

## Gate progression

| Gate | Required evidence | Current status |
| --- | --- | --- |
| G0 | Complete source/generated/tool locks, resolved dependency closure, R0/R1 baseline | Blocked; selected source inventory recorded |
| G1 | Official parser JVM/browser comparison, errors and Unicode | Not run |
| G2 | Portable byte sink/registry/KLIB/writer host comparisons | Not run |
| G3 | New-parser raw/resolved FIR, builtins, common/target checkers | Not run |
| G4 | Browser compiler emits a new program using official IR/backend | Not run |
| G5 | Real Kotlin WASI stdin/EOF/ABI/output/exception execution | Not run |
| G6 | Consumer compile/run, cancellation/recovery/offline/cache | Not run |
| G7 | Required corpus, browser matrix, measured resource/performance profile | Not run |
| G8 | Clean reproducible release, licenses, immutable receipts and rollback | Not run |

The matching wasm-idle candidate provides source/protocol validation and a
standard WASI ABI microprobe. That probe does not advance Kotlin G5: it executes
a WAT fixture, not a Kotlin-generated artifact.

The next compiler work follows K02–K07: standalone official parser; portable
source/byte/session boundaries; official-schema KLIB/protobuf strategy; parser
diagnostics/FIR services; full resolution; FIR2IR/inline/Wasm code generation.
K08 stdlib ABI and I/O verification runs alongside these steps. K09–K11 consume
accepted artifacts, expand differential/browser evidence, and release/register
Kotlin only after all required gates pass.

## Ownership and release conditions

wasm-llvm owns upstream pins, small patch families, build/generation recipes,
libraries, packaging, provenance, licenses, and receipts. wasm-idle owns browser
TypeScript, Workers, source/library adapters, WASI hosting, and common execution
contract integration. Compiler Wasm, JARs, Gradle caches, and full source checkouts
are not checked in as source files.

A release must pair the browser compiler's wasmJs stdlib and the user wasmWasi
stdlib from the same accepted build set. It must pin a release trust root, loader
modules, metadata/IR format, target features, entry ABI, and measured capabilities.
GC/JS/code memory is not capped by a linear-memory setting. Public readiness must
come from accepted browser compilation of previously unseen source followed by
execution, with stdin/stdout/stderr/errors/cancellation and no external requests
after assets are prepared.
