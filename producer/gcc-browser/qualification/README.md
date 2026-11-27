# Real GCC qualification

Run after the producer has built and packaged all four real Emscripten tools and
the GNU/Linux target sysroot:

```sh
node producer/gcc-browser/qualification/run.mjs \
  --bundle /absolute/path/to/gcc-bundle \
  --output /absolute/path/to/new-qualification-directory \
  --native-cxx g++-16 --native-cc gcc-16
```

The output parent must exist, and the output directory must be new and outside
the bundle. `--manifest-sha256 HEX` additionally pins an externally supplied
manifest identity. All module loaders, Wasm modules and sysroot bytes are hashed
before use; every fresh compile process pins the same manifest hash again.

The first required gate is preprocessed `.ii` input through the actual
`cc1plus.wasm` to x86-64 assembly. The remaining cases require raw C and C++, GNU
`bits/stdc++.h`, PBDS order statistics, C++ exception handling including destructor
unwinding, GNU `as`, GNU `ld`, ELF64 x86-64 objects and static executables. Baseline
executables run in separate native Linux x86-64 processes with fixed stdin and
checked stdout. They are never passed to a Wasm loader. Native GCC output is also
compared when the selected compiler matches the exact Wasm GCC version. The
report records a skipped comparison and its reason for a missing or mismatched
compiler. The producer CI passes `--require-native-comparison` to require a
matching reference compiler for every executable. Local runs still execute each
Wasm-compiled ELF and check its stdout.

For ordinary C and C++, the adapter allows GCC to implicitly read the sysroot's
`stdc-predef.h` before the first source token, preserving PCH eligibility. The suite checks the resulting glibc macros in
both languages. Preprocessed inputs use `-fpreprocessed` without a preinclude.

The shared `c-libm-executable` fixture calls `sin` on a value read from stdin and
checks the result after static linking. The Node producer suite also requires C11
and C++20 programs that store and load a 16-byte atomic pair through the target
GNU `libatomic.a`. The browser workflow pins an earlier SDK without that link
option. The qualification report lists both Node atomic cases individually.

`ps-pch-assembly` and `ps-pch-object` exercise real `cc1plus` header precompilation. Each case resolves GNU
`bits/stdc++.h` in the configured include order and compiles `ps.cpp` with its PCH
first on the include path. `-H` must report the PCH as loaded (`! /pch/bits/stdc++.h.gch`) and the
result must be byte-identical to `ps-assembly` or `ps-object`. The Node report
compares the source compilation times of the two front ends. Bundles which omit
`capabilities.precompiledHeaders: true` record these two cases as skipped.

`target-threads.cpp` requires the compiler's predefined `__STDCPP_THREADS__`
macro to equal `1`, then uses `std::thread` and a nontrivial `thread_local`
destructor in a baseline static executable. The worker consumes runtime stdin;
joining it makes its ordinary writes and TLS destruction visible before the
expected stdout is checked. Main-thread TLS must remain independent. This checks
the Linux output's POSIX thread model, not parallel execution inside the Wasm
compiler host; no macro override or source rewriting substitutes for it. The case
is shared by the Node and Chromium gates, and its ELF runs only on native Linux.

`pragma.cpp` is compiled at `-O0 -march=x86-64`. Only its unmodified GCC pragmas
enable AVX2/FMA and O3. Pointer inputs prevent constant folding of the SIMD work.
Assembly assertions require `vpaddd` on YMM registers and packed FMA, removal of
the fixed-count loop inside the optimize region, restoration of the loop after
`pop_options`, and SSE without AVX in a subsequent O3 region. GNU `objdump` checks
the actual object instructions. The separate explicit AVX2/FMA profile must
compile intrinsics that are rejected under the baseline profile.

`pragma-static-init.cpp` and `pragma-deferred-template.cpp` are the original
upstream regression cases for PR109753 and PR115403. They check that artificial
static initialization functions inherit target pragmas while deferred templates
retain the options at their definition. `pragma-stl.cpp` places AVX2/O3 pragmas
before the real GNU C++ headers, exercises implicit vector/allocator members,
and requires YMM integer auto-vectorization of a loop with runtime inputs.
The Node and Chromium gates must compile it to assembly and assemble an ELF
object. Its source requires AVX2, so this qualification does not execute it on an
arbitrary baseline host. The existing push/pop restoration and baseline intrinsic
rejection cases remain independent checks of target scope.

These gates cover both upstream fixes included in GCC 16.2.0. Synthetic integrity
tests alone do not establish compiler or browser acceptance; the new release
must pass the real Node and Chromium gates with its matching GNU runtime.

`qualification.json` records each command, real compiler diagnostics, artifact
hash/size, elapsed time, each module's maximum allocated Wasm linear memory, and
the fresh Node process's peak resident memory. Linear-memory allocation is
different from live bytes and from browser process RSS. Each test's directory
retains the request, artifact and bounded host output; failure leaves a report
with `passed: false`. No fixture creates a fake compiler or substitutes native
GCC for the Wasm compiler under test.

`cases.mjs` and the portable `assertions.mjs` are shared with the independent
Chromium gate in `wasm-idle/scripts/verify-x86-cross-gcc.mjs`. That gate must use
the public consumer Worker API with these actual packaged modules. Success of
this Node harness does not establish browser acceptance. The consumer separately
tests hard cancellation by terminating its Worker and retains its own evidence.

The repository's lightweight tests and native fixture control checks are also
separate from real Wasm qualification. The fixtures and assembly assertions were
checked locally with native GCC 12.2.0; that check established fixture validity,
not GCC 16.2.0 Wasm build or browser success.

The explicit stage orchestration intentionally implements the supported single
translation-unit compile/link options. It does not invoke `fork`/`exec`, the GCC
driver, plugins, LTO, shared linking or an x86 browser emulator. Host
Emscripten libc and host GMP/MPFR/MPC are distinct from the target GNU libraries
mounted under `/sysroot`. C++ stage arguments include `_GNU_SOURCE` and Linux
unwind-table defaults normally supplied by the native GNU driver.
