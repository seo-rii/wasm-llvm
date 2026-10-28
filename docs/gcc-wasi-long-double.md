# GCC Wasm binary128 and final regression qualification

On 2026-10-27 the separate GCC WebAssembly output compiler completed the actual
native and Wasm-host paths with IEEE binary128 `long double`, rebuilt GNU C++
runtime and optional SIMD128. This report qualifies the exact bundle below;
[the JSON record](gcc-wasi-long-double.json) binds full local receipts and logs
by size and SHA-256. Earlier bundle results remain in their original reports.

The path is C/C++ → actual GCC `cc1`/`cc1plus` and GCC RTL backend → annotated WAT
→ pinned WABT relocatable Wasm object → external LLVM `wasm-ld` and WASI runtime
→ Preview1 execution. Emscripten compiles the compiler host. Clang appears only
as a native reference compiler or ABI interoperation partner; the browser SDK
never falls back to it or transforms user source.

## Source and dependency identity

The official GCC master was rechecked at
`1396d6015c968b69a3c45fe3ae4c3bd623ba4594`; its target configuration has no Wasm
entry. The experimental author branch still resolves to the pinned commit.
The [June 2026 Steering Committee announcement](https://gcc.gnu.org/pipermail/gcc/2026-June/248353.html)
approves the development direction, explicitly leaving implementation approval
to technical review. This is an unmerged experimental port, not a GCC release.

| Component | Fixed input |
| --- | --- |
| GCC compiler and GNU libstdc++ | `17.0.0`, `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` (`gcc-wasm-2`) |
| Author's backend / GCC base | `8f90eb001a5b25ef1e6285c8dc9f9bc13e1a8acd` / `33ac889aa27d9917e6e7d07c282015b7c48e0440` |
| Local backend patches | All eight locked patches; binary128 patch SHA `6bf0934f2d6a09dfd0a1b420df3266b29997f755771dc702f4896dc6c9ebdd2d` |
| WABT annotated-WAT fork | `1.0.37`, `651c9ffbce3d0525d2d1324fab79160e5fcf8173` |
| Native wasm-ld / compiler-rt | WASI SDK 33, LLVM 22.1.0, `4434dabb69916856b824f68a64b029c67175e532` |
| WASI libc/libm/CRT | `161b3195fc2558d2b1ba3eb9ffae3b2b47407623` |
| Browser wasm-ld | LLVM 22.1.8, `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1` |
| Compiler host | Emscripten 6.0.0 `afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3`, emsdk `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` |
| Browser runner | Playwright `chromium`, version 156.0.8078.4, pinned executable SHA in the receipts |
| WASI runner | Node 22.23.3 and browser_wasi_shim 0.4.2 |
| Production package validation | Official Node 24.21.0, npm 11.19.0, pnpm 12.9.1 |

GCC 17 is kept separate because the port changes GCC core and target code and
needs its own ABI/runtime. Backporting it into the x86 compiler would enlarge
the regression scope. Latest main's independent GCC 16.2 upgrade is incorporated;
the SDK accepts both correctly matched GCC 13.3/13 and GCC 16.2/16 x86 bundles and
rejects mixed version/path/runtime combinations.

GCC is GPL-3.0-or-later; eligible runtime files carry the GCC Runtime Library
Exception. WABT and LLVM use their pinned upstream license terms, and WASI libc
contains multiple upstream licenses. The producer preserves their notices and
source provenance. The MIT SDK's license does not relicense the compiler/runtime.
See [sources.lock.json](../producer/gcc-wasi/sources.lock.json),
[runtime.lock.json](../producer/gcc-wasi/runtime.lock.json), and bundled notices.

## Backend work and review

Patch `0008` selects TFmode with 16-byte size/alignment, 113 mantissa bits and exponent
limit 16384. TF and internal TI containers use two little-endian i64 words.
Named binary128 values and eligible singleton aggregates use low/high i64
parameters; results use the leading hidden i32 result pointer. Varargs preserve
16-byte alignment. Direct, imported and indirect signatures share the lowering,
including mixed `v128` arguments. Scalar binary128 works without enabling SIMD.

Arithmetic/conversion/comparison helpers use the real compiler-rt binary128
implementation. Negation, absolute value and copysign preserve NaN payload bits
and signed zero. Review found and fixed a silent dependency error in generic
`gcc/optabs.cc`: pseudo-result CALLs must not be hoisted before their argument
initialization. Another regression required narrow QI/HI/SI views of internal
TI storage to use ordinary DI word pseudos. The complete scalar/SIMD/ABI suites
were rerun after the final patch to cover effects outside the focused TF cases.

`libc-printscan-long-double.a` is imported with fixed bytes/SHA and linked before
libc. GNU libstdc++ was rebuilt from the same pinned GCC with the new ABI; an old
binary64 runtime is not reused. The packager requires all 124 native binary128
runs, matching source/tool/header/runtime identities, objects and linked programs.
It rejects incomplete proof. The SDK adds optional `capabilities.longDouble`,
defaults it to false for older manifests and preserves their previous link plan.

The compiler's `all-gcc` host-tools bootstrap recorded exit 2 because optional
`gcov-tool` needs Emscripten's missing `ftw`. The recipe then separately linked
both actual `cc1` and `cc1plus` Wasm modules successfully; the final compiler build
exited 0. That optional tool is outside the browser compiler API. The report
preserves this distinction rather than describing every bootstrap target as built.

## Actual execution results

| Qualification | Passed |
| --- | ---: |
| Native basic C/C++ → object → link → Node WASI | 13/13 |
| Native scalar ABI matrix | 200/200 |
| Native original SIMD | 25/25 |
| Native extended SIMD | 62/62, plus 62 independent Clang references |
| Native vector ABI matrix | 684/684 |
| Native atomic-libcall signature probes | 8/8; test providers only |
| Native binary128 GCC/Clang direction matrix | 124/124 |
| Chromium Worker binary128 | 42/42, each also executed independently in Node WASI |
| Chromium Worker existing C/C++/ABI/SIMD regressions | 317/317, each also executed independently in Node WASI |
| Saved SIMD object instruction/type checks | 87/87 |
| Final SDK + original GCC 13 x86 | 20/20; all 18 produced artifacts byte-identical to the original baseline |
| Final SDK + current GCC 16 x86 | 20/20; actual ELF execution and expected I/O |
| GCC SDK focused unit checks | 71/71 |
| Actual production install/import/type scenarios | 7/7; unchanged budgets |

Native counts include the explicitly recorded GCC/GCC, GCC/Clang, Clang/GCC and
Clang/Clang controls where applicable; they are not 1,116 GCC-only compilations.
The independent artifact inspection reopened 1,116 linked programs and 2,094
objects, plus 62 extra Clang reference programs, after actual compile/link/run.
The final browser total is 359 actual GCC programs, with 359 Worker executions and
359 independent Node WASI executions. No requested case was omitted.

The binary128 matrix is 21 profiles at both O0 and O2; two cases mix SIMD with TF
arguments and 40 use the scalar profile. Its layout/precision program prints
`16 16 16 48 113 16384 1 1`, including preservation of a `2^-100` increment above 1.
Coverage includes NaNs/infinities/subnormals/zero/payloads, signed/unsigned
conversions, global/stack/heap/packed storage, function pointers, aggregates,
callbacks, varargs/va_copy, scanf/printf/strtold, long-double libm, multiple C/C++
units, construction/destruction, GNU cmath, numeric_limits, STL and iostreams.
Every profile passes real `-DONLINE_JUDGE=1` options to GCC.

The browser regression 317 is 17 basic cases + 25 SIMD + 25 scalar ABI + 8 atomic
signature probes + 62 extended SIMD + 180 vector ABI cases (90 at each optimization).
The x86 tests retain AVX2/FMA instructions, target/optimize pragmas, libm and
multiple C/C++ units. x86 behavior is checked against its own ABI; wasm32 pointers
and `long` are 4 bytes, rather than x86-64's 8 bytes.

All final executable bytes pass Wasm validation, import/export and memory checks.
They export `_start: () -> ()`, use one unshared wasm32 memory, and import only
Preview1 functions. Relocatable objects retain linking metadata. Native exported
function types additionally check the scalar/vector/binary128 calling conventions.
The 42 browser cases save 42 main-TU WAT files and 42 objects. Executable compilation
includes every requested TU; these saved intermediates are not claimed to cover
all TUs or browser-side Clang interoperation.

Actual browser requests reject exceptions, RTTI, threads, dynamic linking, x86
CPU selection and an x86 target pragma with diagnostic text. SIMD opt-in and
actual `v128` types/instructions are checked separately from x86 AVX2/FMA.

## Assets and actual initial loading

Manifest SHA-256: `52ba346f00e3cbb1ad6b553437d330271720fd42938870f5f20298596e42cea2`.
The producer leaves `qualification.status: unverified`; this separate hash-bound
browser report supplies the successful qualification. The input manifest was not
rewritten after testing.

| Initial payload | Raw bytes | gzip 9 bytes | Brotli q6 bytes |
| --- | ---: | ---: | ---: |
| cc1.mjs | 133499 | 31635 | 29793 |
| cc1.wasm | 15592897 | 5519079 | 4756594 |
| cc1plus.mjs | 139030 | 32900 | 30993 |
| cc1plus.wasm | 17251910 | 6218835 | 5373329 |
| as.mjs | 61491 | 17414 | 16658 |
| as.wasm | 597157 | 203208 | 171026 |
| ld.wasm | 16171013 | 6417339 | 5594500 |
| sysroot.tar | 25451008 | 5606167 | 4294172 |
| gcc-toolchain.v2.json | 12269 | 3990 | 3815 |

All manifest/tool/sysroot payloads total 75,410,274 bytes raw, 24,050,567 bytes gzip 9
and 20,270,880 bytes Brotli quality 6. Brotli is a deterministic size measurement,
not the encoding used for this browser run. The actual initial browser response
bodies total 29,561,766 bytes: 24,050,567 compressed bundle/manifest bytes plus
5,511,199 bytes of uncompressed SDK/Vite modules. The complete corresponding raw
initial content is 80,921,473 bytes. Every manifest asset was observed on the wire.
HTTP headers are retained separately; these are response-body measurements, not
an npm install size or a production bundler's optimized-module estimate.

The actual GCC package production install is 2,625,278 bytes (budget 2,628,608).
The all-public-packages aggregate is 42,409,195 bytes (budget 42,409,984).
The new x86 compatibility code adds 496 installed bytes; neither final budget was
increased. Full seven-scenario results and package-source fingerprints are in JSON.

## Reproduce and locate evidence

Use a fresh work directory and the exact setup in
[the producer reproduction instructions](../producer/gcc-wasi/README.md#reproduction).
They build WABT, the native compiler, import the runtime, qualify the native gate,
build the Wasm-host GCC, and rebuild/qualify GNU libstdc++ before packaging.
Use the same Node executable for native proofs and the packager because the
packager checks the recorded tool identity. After preparing those outputs:

```sh
"$NODE_WASI" producer/gcc-wasi/test-long-double.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/long-double-qualification"
# Package with every native proof using the complete command in README.md.
# From the matching wasm-idle checkout, after building core and gcc:
"$NODE_WASI" scripts/verify-gcc-wasi.mjs \
  --manifest "$GCC_WASI_BUNDLE/gcc-toolchain.v2.json" \
  --suite "$GCC_WASI_PRODUCER/producer/gcc-wasi/long-double-fixtures.mjs" \
  --save-intermediates --output out/gcc-wasi-long-double-new-run
pnpm --filter @wasm-idle/gcc check
pnpm --filter @wasm-idle/gcc test
pnpm run verify:package
```

`NODE_WASI` selects the fixed Node 22 binary; `GCC_WASI_PRODUCER` is the producer
checkout, and `GCC_WASI_BUNDLE` is the packaged output. Use a short private TMPDIR
for Chromium's Unix socket paths and select the managed Playwright `chromium`
browser type, without a Chrome channel. This executable's version banner is
`Google Chrome for Testing 156.0.8078.4`; its path/hash, browser type and actual
engine version are preserved in the run evidence. The isolated loopback harness
requires no application/WAF cookies. Keep inputs fixed and let all background
commands finish; inspect private bounded logs after exit.

The implementation worktrees are:

- `.worktrees/wasm-llvm-gcc-wasi-20261026`, branch `feat/gcc-wasi-output-20261026`, [PR57](https://github.com/seo-rii/wasm-llvm/pull/57).
- `.worktrees/wasm-idle-gcc-wasi-20261026`, same branch, [PR328](https://github.com/seo-rii/wasm-idle/pull/328), SDK input head `72f499936ef42dfab3f8a54d7a49f5726170a1ca`.

All final compiler modules, the native toolchain, runtime, bundle, programs,
qualification receipts and process/status files are on persistent storage under
producer `out/gcc-wasi-binary128-recovery-20261027`. Only compiler intermediates
and restored tool caches use tmpfs. Key paths relative to that directory:

- `artifacts/bundle/gcc-toolchain.v2.json` and `loading-sizes.json`.
- `work/browser-compiler/` and `work/native-toolchain/`.
- `artifacts/native-long-double/report.json` and the other `native-*` suites.
- `artifacts/worker-long-double-final72r3/qualification.json` and its sibling control completion.
- `artifacts/worker-regressions-completion.json`, six `worker-*` suite reports and opcode checks.
- `control/final-native-all-summary.json`, `final-sdk-inputs.json`, `final-sdk-package-results.json`, and `final-x86-short-gcc{13,16}-completion.json`.
- `control/*-process.json` bind each successful command, 0600 log path, fixed script digest, PID, boot ID and final exit 0. JSON here records log hashes too.

A host replacement erased earlier tmpfs output while the task was in progress.
The exact final source was rebuilt and every final test above rerun with durable
outputs. Earlier failed candidate and preflight logs remain available and are
not counted as successful results. Optional-bootstrap failure and corrected
preflight-only failures are distinguished from compiler/program results.

This follow-up changes patch `0008` and its source lock, runtime printscan import,
GNU runtime recipe, full native fixtures/gate and packager tests, SDK manifest/
link-plan capability and regression tests, plus documentation. Full implementation
files are visible in the two PR diffs; neither primary checkout was overwritten.

## Support boundary and remaining backend work

Supported in the qualified profile: scalar C/C++, libc and libm with buffered
stdin/stdout, real macro options, headers and multiple TUs, function pointers,
aggregates/allocation, static initialization/destruction, GNU STL/iostreams,
binary128 and explicit 128-bit GNU vectors. SIMD operations include arithmetic,
bitwise operations, scalar-count shifts, signed/unsigned or IEEE comparisons,
selection, constant shuffles and direct vector/eligible aggregate calls. See
[SIMD-EXTENDED.md](../producer/gcc-wasi/SIMD-EXTENDED.md) and
[VECTOR-ABI.md](../producer/gcc-wasi/VECTOR-ABI.md) for exact operation/profile limits.

Exceptions, RTTI, threads/TLS, dynamic linking, relaxed SIMD, public `__int128`
and GNU `__float128` remain unsupported. `_Float128` and complex long double
were only boundary-probed and are not qualified public features. General
atomics need a real synchronization/runtime implementation; the eight signature
probes supply test providers only. `wasm_simd128.h`, complete auto-vectorization,
arbitrary externally supplied object files and full standard-library conformance
are not promised. GNU timezone databases, C++26 debugger helpers and prebuilt
`std` modules remain outside the single-thread runtime. `run()` has no directory
preopens/network. No unsupported feature is replaced by a stub or treated as a
successful compile. Upstream review/maintenance, these additional backend/runtime
features and broader conformance remain technical work beyond this qualified path.
