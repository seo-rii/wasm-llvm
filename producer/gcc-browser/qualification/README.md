# Real GCC qualification

Run after the producer has built and packaged all four real Emscripten tools and
the GNU/Linux target sysroot:

```sh
node producer/gcc-browser/qualification/run.mjs \
  --bundle /absolute/path/to/gcc-bundle \
  --output /absolute/path/to/new-qualification-directory \
  --native-cxx g++-13 --native-cc gcc-13
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
compared when the selected compiler is installed; the report records whether its
exact version matches the Wasm GCC version. A missing comparison compiler is
recorded explicitly; it does not bypass the mandatory native execution gate.

`pragma.cpp` is compiled at `-O0 -march=x86-64`. Only its unmodified GCC pragmas
enable AVX2/FMA and O3. Pointer inputs prevent constant folding of the SIMD work.
Assembly assertions require `vpaddd` on YMM registers and packed FMA, removal of
the fixed-count loop inside the optimize region, restoration of the loop after
`pop_options`, and SSE without AVX in a subsequent O3 region. GNU `objdump` checks
the actual object instructions. The separate explicit AVX2/FMA profile must
compile intrinsics that are rejected under the baseline profile.

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
not GCC 13.3.0 Wasm build or browser success.

The explicit stage orchestration intentionally implements the supported single
translation-unit compile/link options. It does not invoke `fork`/`exec`, the GCC
driver, PCH, plugins, LTO, shared linking or an x86 browser emulator. Host
Emscripten libc and host GMP/MPFR/MPC are distinct from the target GNU libraries
mounted under `/sysroot`. C++ stage arguments include `_GNU_SOURCE` and Linux
unwind-table defaults normally supplied by the native GNU driver.
