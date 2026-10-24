# GCC hosted in WebAssembly, targeting Linux x86-64

This producer ports the **GCC executable host** to Emscripten. It does not add a
WebAssembly output backend to GCC. The resulting `cc1`/`cc1plus`, GNU assembler,
and GNU linker run in a browser Worker and emit x86-64 assembly, ELF objects, or
static ELF executables. The consumer downloads those bytes; it never runs x86
code in the browser.

This branch is stacked on [wasm-llvm #53](https://github.com/seo-rii/wasm-llvm/pull/53)
for its GNU/Linux sysroot importer, archive validation, and deterministic USTAR
packager. The GCC work does not modify the Clang compiler branch or artifacts.
Its consumer is the `feat/gcc-wasm-x86-64-20261024` branch of wasm-idle, stacked
on [wasm-idle #320](https://github.com/seo-rii/wasm-idle/pull/320).

## Build inputs and boundaries

| Role | Implementation |
| --- | --- |
| Native build tools and generators | Linux x86-64, GCC/G++ 13.3.0 |
| Compiler host | Emscripten 4.0.23, Wasm32, MEMFS |
| Compiler | Unmodified GCC 13.3.0 C and C++ front ends and x86 backend |
| Assembler/linker | GNU binutils 2.42, x86_64-linux-gnu |
| Host arithmetic libraries | GMP 6.3.0, MPFR 4.2.1, MPC 1.3.1, built as Wasm |
| User-program runtime | Actual GNU/Linux x86-64 glibc, libstdc++, libgcc and CRT |

`sources.lock.json` fixes archive hashes and source revisions. Build-time GCC
generators and dependency generators execute natively. The host math libraries
are linked into the Wasm compiler; they are **not** target program libraries.
Ubuntu 24.04's installed GCC 13 development packages provide the matching GNU
target headers/libraries. The importer records exact binary/source package
versions, distribution, glibc version, per-file SHA-256 values, and copyright
files. It does not claim to have fetched the original Debian source archives.
Compiler source archives remain reproducible from the lock; compiler and host
dependency license notices are retained in `licenses/`.

The GCC target is configured with `--enable-threads=posix`, matching the imported
Linux GNU runtime. This controls target features such as `__STDCPP_THREADS__`;
the Wasm compiler host still runs in its dedicated Worker without Emscripten
pthreads. The build checks the generated `configargs.h` before GCC compilation
and rejects a resumed directory configured with the old `single` target model.
Use a fresh isolated build directory when that check fails. See GCC's
[target thread configuration](https://gcc.gnu.org/install/configure.html).

`/sysroot` is the compiler's browser runtime path, not a build-machine directory.
The recipe disables fixincludes and uses GCC's original `stmp-int-hdrs` rule to
generate its internal headers. `LIMITS_H_TEST=true` selects the upstream glibc
forwarding wrapper; the recipe checks its bytes against `limitx.h`,
`glimits.h`, `limity.h`, and `gsyslimits.h` in the pinned GCC source.
Packaging requires the real target `limits.h` and `stdint.h` to which those
wrappers delegate. No build-host libc headers enter the resource overlay.
See the [GCC 13.3 header generation rule](https://github.com/gcc-mirror/gcc/blob/releases/gcc-13.3.0/gcc/Makefile.in).

The approach follows the pinned
[AVR](https://github.com/begeistert/wasm-toolchains/blob/66af4dcbaa49c2f16699ac88b4b16fc697683ca5/src/avr-gcc/build.sh)
and [ARM](https://github.com/begeistert/wasm-toolchains/blob/66af4dcbaa49c2f16699ac88b4b16fc697683ca5/src/arm-gcc/build.sh)
recipes, plus [horang-corp's Worker orchestration](https://github.com/horang-corp/avr-gcc-wasm/tree/e3a563f765b041623734991125d5640c7e56053e).
Those are AVR/ARM precedents, not evidence that this x86-64 build succeeds.

## Build and package

Use an isolated Linux build directory with at least 16 GiB free. The recipe
checks available space before downloading sources. The GCC workflow supplies
Ubuntu 24.04, native build dependencies, isolated directories, and retained logs.
It publishes Actions artifacts only; it does not deploy or create a release.

```sh
GCC_WASM_WORK_DIR=/large-disk/gcc-work \
GCC_WASM_OUT_DIR=/large-disk/gcc-compiler \
GCC_WASM_JOBS=2 bash producer/gcc-browser/build.sh

node producer/clang-browser/cross/import-sysroot.mjs --compiler g++-13 \
  --output /large-disk/gcc-sysroot --provenance /large-disk/gnu-provenance.json
node producer/gcc-browser/package.mjs \
  --compiler /large-disk/gcc-compiler --sysroot /large-disk/gcc-sysroot \
  --provenance /large-disk/gnu-provenance.json --output /large-disk/gcc-bundle
node producer/gcc-browser/qualification/run.mjs \
  --bundle /large-disk/gcc-bundle --output /large-disk/gcc-evidence --native-cxx g++-13
```

Outputs must be new directories. The compiler receipt binds each generated
loader/module and GCC resource headers to the source lock. Packaging validates
the target archive members as x86-64 ELF, preserves the original GNU provenance,
and records the resource-header overlay in the complete sysroot inventory.
It writes `gcc-toolchain.v1.json` last. Its SHA-256 must reach consumers through
a trusted channel independent of the fetched manifest.

The bundle has `cc1`, `cc1plus`, `as`, and `ld`, each as a `.mjs` ES-module factory
and `.wasm` module, plus `sysroot.tar`, source/build receipts and license material.
`assets` contains the size and SHA-256 of every execution payload. `host` is
`wasm32-emscripten`; `target` is `x86_64-linux-gnu`. These are different properties.

## Compiler contract and limitations

The browser API schedules real `cc1`/`cc1plus → as → ld` invocations because the
GCC driver relies on processes (`fork`/`exec`/`collect2`) absent from a browser.
One translation unit and optional user headers are supported. The public
allowlist covers language/standard, `-O0/1/2/3/s`, output kind and CPU profile.
Arbitrary driver arguments, PCH, plugins, LTO, dynamic linking and shared-library
outputs are excluded. No pragma is removed, translated, or emulated.

`x86-64` selects `-march=x86-64 -mtune=generic`. `avx2-fma` additionally enables
`-mavx2 -mfma`. The browser's CPU is not used to select the target, and
`-march=native` is not accepted. Standard C++ exceptions use the genuine target
runtime. GCC's `bits/stdc++.h`, PBDS and x86 intrinsic headers remain intact.
The first implementation allocates fresh module state for each tool invocation;
it trades some memory/startup cost for isolated compiler state and no stale output.

## Qualification and current evidence

Packaging always sets `qualification.status` to `unverified`. Structural tests
contain deliberately tiny, non-compiling Wasm/ELF fixtures; their passing result
is not GCC execution evidence. Real qualification reports are separate files
bound to the manifest SHA-256 and contain stage timing, Wasm memory high-water
sizes, output hashes, native stdin/stdout results and native GCC comparisons.
Wasm linear memory excludes JavaScript/MEMFS allocations; process RSS is a
different measurement and is reported separately.

The real suite first compiles preprocessed `.ii` into x86 assembly, then tests
original C and GNU C++ source through all output kinds, PBDS order statistics,
exception unwinding, dynamic-input AVX2/FMA, GCC `target`/`optimize` pragma and
`push_options`/`pop_options`, baseline restoration, and failure after success.
Baseline static programs run in a separate native Linux process. SIMD checks
inspect assembly and object disassembly; the SIMD program need not run on the
CI host CPU.

To exercise the actual consumer Worker with the same suite:

```sh
node ../wasm-idle/scripts/verify-x86-cross-gcc.mjs \
  /large-disk/gcc-bundle/gcc-toolchain.v1.json \
  "$PWD/producer/gcc-browser/qualification" /large-disk/gcc-browser-evidence
```

That test requires Chromium and consumer development dependencies. It checks
Worker termination on cancellation, downloaded bytes, and native Linux I/O.
Only reports from a completed build establish working Wasm GCC support. Keep
the PR in Draft while actual build or qualification is incomplete.

## Reproducible fuzz campaigns

[The fuzz harness](fuzz/README.md) generates bounded C/C++ programs from a seed,
compares real Wasm GCC and native GCC outputs against an independent arithmetic
oracle, and preserves the corpus before compilation. Generated cases cover
unsigned expressions and control flow, GNU STL/PBDS, exceptions, and dynamic-input
AVX2/FMA with GCC pragma push/pop restoration. These are structured differential
campaigns, not coverage-guided compiler fuzzing. Contract fixtures are reported
separately from actual compiler execution.

The GCC workflow runs 24 generated cases by default, then replays the same corpus
through the pinned consumer's public Chromium Worker API. Only baseline static
ELF programs execute on Linux; AVX2 cases are checked in assembly. Each stage has
a 900-second budget. Manual dispatch accepts a uint32 `fuzz_seed`, 1–100
`fuzz_cases`, and a 30–900-second `fuzz_seconds` budget per stage. The campaign
fails when its budget expires before all requested cases complete.

The `gcc-wasm-fuzz-evidence-*` Actions artifact retains generated source, stdin,
expected output, requests, compiler and sysroot identities, stage measurements,
compiled outputs and failure diagnostics for seven days. Preserve that artifact
to replay a failure with the exact seed/index and bundle. The consumer's
`scripts/GCC_FUZZ.md` documents Worker replay, and its `fuzz:gcc-contract` command
independently fuzzes manifest, asset-integrity, path and option validation without
claiming to execute GCC.
