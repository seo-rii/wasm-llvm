# Generated GCC differential fuzzing

This is seeded grammar/property differential fuzzing. It does not instrument GCC
for coverage or claim coverage-guided mutation. The campaign runs the **actual
packaged WebAssembly GCC**, assembler and linker in fresh Node subprocesses via
the qualification adapter. The matching consumer script separately replays the
same immutable corpus through the public Chromium Worker API.

```sh
node producer/gcc-browser/fuzz/run.mjs \
  --bundle /absolute/path/to/gcc-bundle \
  --manifest-sha256 EXPECTED_64_DIGIT_SHA256 \
  --output /absolute/path/to/new-evidence-directory \
  --native-cc gcc-13 --native-cxx g++-13 \
  --seed 20261024 --cases 24 --max-seconds 600
```

The manifest digest must come from the trusted build handoff. The runner checks
it and every module/loader/sysroot hash before importing compiler code. Native
GCC's full version must equal the packaged GCC version. An unavailable compiler,
version mismatch, compile error, crash, timeout, output limit or oracle mismatch
fails the campaign; none is silently skipped. For an explicitly weaker local
comparison only, `--allow-native-version-mismatch` records the mismatch in the
report. CI must not use that flag.

Defaults are 24 cases, 600 campaign seconds and 90 seconds per child process.
`--case-timeout-seconds` may lower the process limit. Every child is also limited
by the remaining campaign wall-clock budget and each output stream is bounded
to 1 MiB. Limits are 1,000 cases and 3,600 seconds. A larger manual run can use
`--cases 100 --max-seconds 1800`. Binaries run only on native x86-64 Linux in
private temporary files; no browser x86 interpreter is involved.

The six-case repeating schedule produces four independent families:

- Generated C/C++ expression trees contain unsigned add/subtract/multiply,
  bitwise operations, bounded shifts, nonzero division/remainder and conditional
  expressions. Generated functions combine runtime inputs, arrays, `if`, `switch`
  and bounded loops. A separate BigInt interpreter predicts uint32 behavior.
- GNU C++ cases use `bits/stdc++.h`, vector sorting, map, accumulation, real PBDS
  order statistics, a derived standard exception and a destructor during normal
  exit or unwinding. Constants, expression trees, inputs and branches vary.
- Both executable families vary `-O0/-O1/-O2/-O3/-Os` and supported standards.
  Their static ELF64/x86-64 outputs and native GCC reference programs must both
  produce the oracle's exact stdin/stdout result.
- Assembly-only cases vary runtime-pointer offsets and loop bounds around real
  AVX2/FMA intrinsics, unmodified `target`/`optimize`/`push_options`/`pop_options`
  pragmas, and the two explicit CPU profiles. Function-level assembly checks
  require integer YMM addition and packed FMA, verify optimization restoration,
  and ensure baseline target restoration. AVX2 programs are never executed.

All generated integer arithmetic uses 32-bit unsigned operands. Shift counts
are masked to 0..31, divisors are ORed with 1, array indices are bounded, loop
limits stay small, and all variables are initialized. SIMD inputs are pointers,
so the compiler cannot fold away the required instructions. This bounded grammar
does not cover every C/C++ construct or establish general compiler correctness.

`corpus.json` is written before any compiler execution. It contains the generator
version, seed/index, complete source/options, stdin, expected stdout, assembly
checks and exact compiler/host/target/sysroot/module identities. `fuzz-report.json`
contains its SHA-256 and partial results even on failure. Each attempted case
preserves sources, request, input, expected output, tool diagnostics, process
arguments/status/signal/timing, compile result, output binaries and native
reference evidence. Compiler reports include Wasm heap size and fresh Node
maximum RSS; those values are not Chromium total memory.

Reproduce an individual index without generating earlier cases:

```sh
node producer/gcc-browser/fuzz/run.mjs \
  --bundle /absolute/path/to/the/same/bundle \
  --manifest-sha256 SAME_EXPECTED_SHA256 \
  --output /absolute/path/to/new-replay-directory \
  --native-cc gcc-13 --native-cxx g++-13 \
  --seed 20261024 --case-index 17 --max-seconds 180
```

The same generator revision and seed/index produce the same case independent of
the campaign length. Preserve `corpus.json` for exact replay across generator
revisions; wasm-idle's `scripts/fuzz-x86-cross-gcc.mjs` consumes the file with
explicit manifest and corpus SHA-256 pins. Synthetic runner failure tests and
native generator/oracle tests in `test/fuzz.test.mjs` are labeled separately and
do not substitute for real Wasm or Chromium campaigns.
