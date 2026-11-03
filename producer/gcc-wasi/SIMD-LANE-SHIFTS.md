# Lane-wise vector shifts

GNU vector expressions `values << counts` and `values >> counts`, where both
operands are vectors, already lower correctly through GCC's scalar expansion.
The issue #78 qualification makes that existing behavior explicit. It does not
change the backend, source lock, SDK or packaged compiler.

The supported test modes are 16×i8, 8×i16, 4×i32 and 2×i64, signed and unsigned,
in GNU C11 and GNU C++20 at O0/O2. The lane-wise operations cover unsigned left
shift, unsigned logical right shift, signed arithmetic right shift and signed
left shift with nonnegative, representable results. Every shift count is between
zero and the element width minus one. Out-of-range counts, negative counts and
undefined signed-left operations are excluded from successful test expectations.
The tests do not interpret Wasm's masked shift counts as a C/C++ language promise.

With `-msimd128`, individual lane shifts use scalar `i32` or `i64` instructions;
SIMD loads, extraction, replacement and stores may surround those shifts. A
uniform scalar count still uses the existing `i8x16`, `i16x8`, `i32x4` or `i64x2`
shift instruction. Explicitly disabled SIMD and the native compiler's default
profile use scalar instructions throughout. This is a correctness qualification,
not a new lane-variable SIMD instruction or a performance claim.

GCC's `gcc/tree-vect-generic.cc` selects the scalar expansion when the target
has no vector-count optab. The locked `gcc/config/wasm/simd.md` shift pattern takes
one SI count for the whole vector. These paths explain why the existing target
needs no new pattern for correct lane-variable behavior. The original GNU
vector expressions are passed directly to GCC; source text and emitted WAT are
never rewritten to obtain the result.

## Qualification contract

`lane-shift-fixtures.mjs` exports 48 enabled, 48 disabled and 48 default fixtures:
four widths × two languages × two optimization levels × three runtime corpora
for each feature profile. Every program contains four lane-variable functions
and three uniform-count controls. Pointer interfaces and `__builtin_memcpy`
keep the operations independent of a compiler-specific vector calling ABI.

Each corpus supplies all valid counts through stdin. Lane counts differ within
each row; an i8x16 row necessarily repeats the eight valid counts twice. Unsigned
inputs include the high bit and maximum value. Signed inputs include both limits,
negative odd values, minus one and zero. Signed-left inputs are bounded before
the operation. The three uniform counts are zero, width minus one and three.

The expected decimal results use BigInt arithmetic. A separate Clang program
uses scalar loops with SIMD, loop vectorization and SLP vectorization disabled.
Unsigned 8/16-bit oracle operands widen explicitly to unsigned int before the
shift. All generated stdin/stdout pairs were additionally compared with an
independent Python integer generator in the preserved baseline.

`lane-shift-inspect.mjs` checks each named function in both GCC WAT and actual
relocatable-object disassembly. Lane-variable functions must contain the
appropriate scalar shift and no SIMD shift. Enabled uniform controls must
contain the correct SIMD shift. Disabled/default functions and scalar Clang
references must contain no SIMD instructions. WAT and object shift/SIMD
inventories must agree. Unit tests reject missing/duplicate function bodies,
wrong lowering, and opcodes hidden in comments, strings or another function.

The native harness verifies the complete locked GCC source diff, build receipt,
compiler and WABT binaries, headers, runtime libraries and fixture identities.
It assembles real objects, links with fatal warnings, runs WASI programs, checks
exact stdout, empty stderr and zero exit, then reopens inputs and artifacts.
WASI-only imports and `_start`/memory exports are required. A real validator
with SIMD disabled accepts every scalar program and rejects enabled programs
that contain the uniform SIMD controls.

The Chromium run uses the public SDK and an already qualified source17 bundle.
It compiles each original fixture with Wasm-host GCC, captures WAT and objects,
and executes the resulting program in the SDK Worker and independently in Node
WASI using the same program bytes. The public SDK normalizes an omitted `simd`
request to `-mno-simd128`; only the native default fixtures test omission of both
compiler flags. Actual compile-stage arguments are checked against the SDK plan.

## Reproduction

Use the compiler, source tree, WABT work directory and runtime matching
`sources.lock.json`. Output directories must be new.

```sh
node --test producer/gcc-wasi/lane-shift-fixtures.test.mjs \
  producer/gcc-wasi/lane-shift-inspect.test.mjs
node producer/gcc-wasi/test-lane-shifts.mjs \
  --compiler /path/to/native-build/gcc \
  --source /path/to/locked-patched-gcc \
  --work /path/to/qualified-gcc-wasi-work \
  --sdk /path/to/wasi-sdk-33 \
  --sysroot /path/to/single-thread-wasi/sysroot \
  --output /path/to/new/lane-shift-qualification
```

`--cases ID,...` selects a diagnostic subset; a subset is not a full-suite pass.
For browser reproduction, create a trusted local suite that exports
`[...cases, ...disabledCases, ...defaultCases]` from `lane-shift-fixtures.mjs`,
then run the matching wasm-idle `scripts/verify-gcc-wasi.mjs` with `--manifest`,
`--suite`, `--save-intermediates` and a new `--output` directory. Use Chromium.

Completed counts, compiler/bundle identities and local artifact hashes are
recorded in [the dated receipt](../../docs/gcc-wasi-lane-shifts-20261030.json).

The 2026-10-30 run passed 144 native GCC and 144 independent scalar Clang
executions. The same 144 fixtures passed actual Wasm-host GCC compilation and
Chromium Worker execution, and all 144 resulting programs also passed Node
WASI with the same bytes. Native inputs (550 files), Worker inputs (487 files)
and 1,872 native/Worker artifacts were reopened successfully. All 1,008 GCC
operation functions had matching shift and SIMD inventories between native and
Wasm compiler hosts. The source17 diff remains
`152915d721c9b743f0345efd564bbf143bf53b8f7bf36b8f261dd25ba1cdd7d1`;
the unchanged bundle manifest is
`d8fa39679b4c9f9f8fd5376ed84b33942f0ac81f76b0e10ce8767efe4b7e547d`.
