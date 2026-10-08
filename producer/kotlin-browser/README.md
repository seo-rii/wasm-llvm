# Kotlin browser compiler candidate

This producer starts the direct source port of the official Kotlin compiler:
parser → FIR resolution/checking → FIR2IR → KLIB/IR linking → Wasm backend.
The intended compiler host is `wasmJs`; the initial user console target is
`wasmWasi` with WASI Preview 1. These are separate library/build sets.

**Status: official parser JVM/browser comparison and JVM-hosted example builds; G0
blocked; browser compiler not built.**
There is no full compiler Wasm bundle, accepted release receipt, or public Kotlin
support in this change. GraalVM Web Image, TeaVM hosting, remote
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
still incomplete. Nine official bootstrap/compiler/support artifacts are now
downloaded and payload-hash-verified separately in `build/bootstrap.lock.json`.
The installed JDK 17 direct-CLI host is distinct from the upstream Gradle daemon
JDK 21 requirement; a full upstream Gradle/tool closure is not claimed.

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

## Real Hello World and Fibonacci builds

The [bootstrap reference recipe](build/README.md) downloads a bounded official
compiler/stdlib set, verifies every payload, then invokes the official
`KotlinWasmCompiler` in two stages: source → KLIB → Wasm. It preserves checked
array access, assertions, and exnref exceptions. Language/API versions are fixed
to 2.4 for these console inputs; the development compiler is not advertised as a
stable language release.

```sh
pnpm prepare:kotlin-bootstrap
pnpm verify:kotlin-bootstrap
pnpm build:kotlin-baseline -- --output out/kotlin-browser-baseline/my-run
```

The output directory must be new. JARs, stdlib KLIBs, source snapshots and generated
programs stay in ignored `out/`, accompanied by actual command/hash receipts.
Node 24.1.0 requires `--experimental-wasm-exnref` for engine validation, already
included in the package command. The browser execution tested separately by
wasm-idle uses default Chromium flags.

[`evidence/bootstrap-baseline.json`](evidence/bootstrap-baseline.json) records
successful official builds of `fixtures/hello-world.kt` and `fixtures/fibonacci.kt`.
The resulting Wasm files are 691,555 and 700,643 bytes and import only Preview 1
`fd_write`, `poll_oneoff`, `random_get`, plus `fd_read` for Fibonacci. They export
`memory`/`_start` and contain a Wasm start section. Runtime expectations remain
expectations in this producer receipt; actual browser execution is recorded in
the consumer's separate receipt.

This compiler is the official precompiled bootstrap `2.5.0-dev-10106`, with
`compiler.sourceCommit: null`. It is a **bootstrap reference**, not the selected
candidate's R0/R1 build and not a browser compiler. The stock target stdlib is
unpatched. These examples cannot advance G4 or enable public Kotlin support.

The separate [target stdlib source probe](stdlib-probe/README.md) builds all 501
selected-source compilation units, including the exact Preview 1 allocation
patch. Its 507 original/build/generator inputs are Git-blob/SHA-256 pinned;
the CLI preserves six source fragments and both WASI parents without linking a
precompiled target library. The unchanged upstream version-generator logic runs
through a JVM adapter, and official builtin files are copied unchanged. The
upstream Gradle task itself remains unrun.

[`evidence/stdlib-source-build.json`](evidence/stdlib-source-build.json) records
the successful complete source build: target version `2.5.255-SNAPSHOT`, KLIB
4,111,645 bytes, compiler source commit unknown. The separate
[patched-target example receipt](evidence/stdlib-patched-baseline.json) records
successful two-stage official Hello/Fibonacci builds using that KLIB. Both target
library variants pass the five real browser execution scenarios recorded by
[wasm-idle](https://github.com/seo-rii/wasm-idle/tree/feat/kotlin-browser-foundation/runtimes/wasm-kotlin/evidence).
The source-built T is not an accepted browser C/T release pair, and the probe's
language/API 2.5 settings are separate from the original 2.4 example profile.

## Verified boundaries

- [The official parser build](https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/compiler/multiplatform-parsing/build.gradle.kts)
  declares JVM/wasmJs targets and generated Kotlin lexers. Published syntax API
  artifacts are linked in the [standalone probe](parser-probe/README.md). All 17
  lexer/production-marker/error cases match JVM and actual Chromium execution,
  including Unicode/CRLF/BOM, offline parsing and forced-termination recovery.
  This does not establish parser-to-FIR or resolved compiler semantics.
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
  require 48/32 bytes aligned to 8. Source inspection confirms 8-byte allocator
  rounding, so the event gets 32 bytes but the subscription only 24. The exact
  [stdlib source patch](patches/wasi-README.md) changes the requested sizes to
  48/32 without changing the official I/O logic. Git apply/reverse and seven
  integrity/application guards passed. The complete patched target stdlib now
  builds and runs both examples in Chromium; actual Kotlin allocator canaries
  and the full G5 corpus remain untested.

## Gate progression

| Gate | Required evidence | Current status |
| --- | --- | --- |
| G0 | Complete source/generated/tool locks, resolved dependency closure, R0/R1 baseline | Blocked; selected source inventory recorded |
| G1 | Official parser JVM/browser comparison, errors and Unicode | Passed for 17-case standalone parser corpus; old/new parser semantic comparison remains separate |
| G2 | Portable byte sink/registry/KLIB/writer host comparisons | Writer unit passed; registry and KLIB probes remain unrun |
| G3 | New-parser raw/resolved FIR, builtins, common/target checkers | Not run |
| G4 | Browser compiler emits a new program using official IR/backend | Not run |
| G5 | Real Kotlin WASI stdin/EOF/ABI/output/exception execution | Hello/Fibonacci, stdin, output-limit and fresh-instance recovery pass; allocator canaries and full corpus remain unrun |
| G6 | Consumer compile/run, cancellation/recovery/offline/cache | Not run |
| G7 | Required corpus, browser matrix, measured resource/performance profile | Not run |
| G8 | Clean reproducible release, licenses, immutable receipts and rollback | Not run |

The matching wasm-idle candidate provides source/protocol validation, a standard
WASI ABI microprobe and actual Kotlin-generated program execution. The WAT fixture
checks host structure layouts separately; the real programs demonstrate console
I/O with both unpatched bootstrap and source-built patched target libraries.
Neither proves complete Kotlin ABI/runtime acceptance or browser compilation.

The [parser receipt](parser-probe/evidence/g1-parser.json) records the unmodified
official common sources built with the pinned bootstrap, complete token and
production-marker snapshots, errors, and browser Worker recovery. Its
[integrity preflight](parser-probe/evidence/g1-parser-preflight.json) binds the
final bounded source/tool readers to unchanged executed inputs and outputs.
Seven file/publication guards passed. The
[raw-FIR boundary inventory](parser-probe/evidence/raw-fir-boundary.json) preserves
five exact source pins for the next host port: Java streams and IntelliJ light
tree types still prevent the new parser from being a complete portable FIR entry.

The [portable writer probe](writer-probe/README.md) isolates the official byte
writer's Java I/O boundary while preserving its encoding and backpatch bodies.
Original JVM, portable JVM and actual browser Wasm agree on all 82 byte cases;
ten bounded sink guards and seventeen fixed byte expectations also pass. The
[receipt](evidence/writer-byte-equality.json) records verified source/patch hashes,
offline Worker execution and JVM file-output equality. This is one G2 unit;
it does not establish KLIB reading, compiler/backend integration or G4.

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
