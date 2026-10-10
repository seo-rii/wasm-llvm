# Selected-source wasmWasi stdlib probe

This probe builds the target library **T**, independently of the browser compiler
**C**. Its 507 pinned inputs contain 496 upstream compilation sources, five JVM
builtins selected by the upstream Sync exclusions, and six build/generator
inputs. The input set totals 5,172,788 bytes. No full Kotlin clone or precompiled
target stdlib is used to build the replacement KLIB.

The source is Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`. Every input
has a Git blob identity and SHA-256 in `recipe.json`. Source membership was
verified against complete upstream Git trees, with their tree SHA-1 recomputed.
The recipe preserves all six common/native/Wasm/WASI fragments and both parents
of `wasmWasiMain`; it does not include wasmJs or the shared JavaScript branch.

From the repository root, with the verified bootstrap prepared:

```sh
node producer/kotlin-browser/stdlib-probe/prepare.mjs --input out/kotlin-stdlib-probe/prepared
node producer/kotlin-browser/stdlib-probe/build.mjs --input out/kotlin-stdlib-probe/prepared --output out/kotlin-stdlib-probe/my-fresh-build
node --experimental-wasm-exnref producer/kotlin-browser/stdlib-probe/baseline.mjs --stdlib-build out/kotlin-stdlib-probe/my-fresh-build --output out/kotlin-stdlib-probe/my-fresh-baseline
node --test producer/kotlin-browser/stdlib-probe/*.test.mjs
```

Build and baseline output directories must be new. Prepared sources are verified
again before copying into an isolated subset repository. The original prepared
bytes remain unchanged. The K08 source patch applies only inside that copy.

The official version generator's `replaceVersion` function and `doLast` body
are extracted without modification and run by a small JVM adapter supplying the
version input and logging boundary. The default upstream property resolves to
`2.5.255-SNAPSHOT`; input/template/generated hashes and the actual generator
commands are recorded. The upstream Gradle task itself is not executed. Builtin
generation uses a byte-preserving Sync-copy adapter and records every mapping.

KLIB compilation uses the official bootstrap `KotlinWasmCompiler` at
`2.5.0-dev-10106`, language/API 2.5, strict explicit API, warnings as errors and
the inspected upstream opt-ins/dogfooded features. It retains Kotlin checking
and all source bodies. The bootstrap compiler's source commit remains unknown;
it is not claimed to be the selected source compiler R0/R1. Each phase has a
hashed argument file and an actual exit status. Failed attempts remain separate
from successful output.

The optional baseline compiles Hello World and Fibonacci with the new patched
KLIB, records its source/patch identity, and publishes the existing consumer
receipt contract. Expected output remains distinct from observed browser
execution, which belongs to the consumer evidence. Node 24 validation needs
`--experimental-wasm-exnref`; browser support is checked independently.

This probe does not build FIR/compiler dependencies for wasmJs, establish the
complete compiler dependency closure, or enable public Kotlin readiness.

## Observed result

The [source-build receipt](../evidence/stdlib-source-build.json) records successful
version generation and complete KLIB compilation. The output is 4,111,645 bytes,
has `unique_name=kotlin`, target `wasm-wasi`, ABI 2.5 and no library dependencies.
The [integrity check](../evidence/stdlib-integrity-check.json) rechecks all 507
original and final isolated inputs, five builtin copies, source properties,
generator identity, target KLIB and resulting example hashes.

The [patched-target baseline](../evidence/stdlib-patched-baseline.json) records
actual Hello World/Fibonacci source and binary compilation with this KLIB.
The consumer's separate Chromium receipt observes Hello World, inputs 10 → 55
and 20 → 6765, output-limit failure and fresh-Worker recovery with zero execution
network requests. The [actual allocator canaries](allocator-canary/README.md)
also pass 81 allocations and the patched stdlib poll path in Node and two
fresh offline Chromium Workers. Full WASI acceptance and browser Kotlin source
compilation remain unrun. The recorded earlier failed setup/option
attempts are preserved separately and are not counted as successful builds.

The [console runtime corpus](console-runtime/README.md) additionally executes
24 real Kotlin EOF, Unicode, stderr, exception, output-budget and fresh-state
cases through the existing wasm-idle runner in Node and 24 fresh offline
Chromium Workers. All raw results match. The separate [Worker lifecycle
probe](console-lifecycle/README.md) terminates three requests using the real
Kotlin infinite-loop fixture and successfully executes fresh state after each
in offline Chromium. Two requests record stdout before termination; the third
uses an unmodified Worker whose loop entry is not directly observed. Its
external cancellation/deadline controller is test-only. Full WASI acceptance
and browser Kotlin source compilation remain separate requirements.
