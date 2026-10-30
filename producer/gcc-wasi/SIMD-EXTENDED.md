# Extended SIMD128 code generation

This patch extends the actual experimental GCC Wasm target's RTL instruction
selection. The compiler host, target ABI, linker, libc and standard library pins
remain separate inputs. It builds on the five patches in `sources.lock.json`;
the new vector calling convention is a separate patch and is not implemented
here. No submitted C/C++ source or generated WAT is rewritten.

The extension is opt-in through `-msimd128` (SDK `simd: true`). Default compilation
and `-mno-simd128` retain scalar lowering. All supported vectors are exactly 128
bits: 16×i8, 8×i16, 4×i32, 2×i64, 4×f32 and 2×f64.

## Operations

- Integer vector shifts use one scalar count for the entire vector. Left shift,
  unsigned right shift and signed arithmetic right shift map to `*.shl`,
  `*.shr_u` and `*.shr_s`. Source programs must use counts from zero through
  lane width minus one. This does not define the behavior of out-of-range C/C++
  shift counts, even though Wasm itself masks the count.
- Signed and unsigned integer equality and relational comparisons return an
  all-one or all-zero integer lane mask. Wasm has no unsigned relational i64x2
  instructions: GCC biases both operands' sign bits using `v128.xor` and emits
  the corresponding signed comparison.
- Floating comparisons preserve NaN unordered semantics. Direct equality and
  ordered relations map to f32x4/f64x2 comparison instructions; unordered and
  ordered compound conditions are constructed from comparisons and full-lane
  bitwise masks. Quiet NaNs, infinities and signed zero are covered; signaling
  NaN floating-point exception flags are not promised by this WASI target.
- GNU C++ vector conditional expressions use `v128.bitselect` after testing
  each mask lane for nonzero. GCC's mask optab supplies full-lane Boolean masks.
  This is not an x86 intrinsic compatibility layer.
- `__builtin_shufflevector` with compile-time selectors and equal 128-bit input
  and output modes uses `i8x16.shuffle`. The target converts lane selectors to
  sixteen byte selectors inside GCC. Runtime `__builtin_shuffle` uses the
  separately qualified [scalar fallback](SIMD-RUNTIME-PERMUTATION.md); this
  extension does not add a variable permutation instruction pattern. Variable
  per-lane SIMD shifts remain outside this extension.

The implementation follows GCC's [vector comparison and conditional mask
optabs](https://gcc.gnu.org/onlinedocs/gccint/Standard-Pattern-Names-for-Vectorization.html)
and [constant permutation target
hook](https://gcc.gnu.org/onlinedocs/gccint/Vectorization.html), and the Wasm
[vector instruction semantics](https://webassembly.github.io/spec/core/exec/instructions.html)
and [numeric operations](https://webassembly.github.io/spec/core/exec/numerics.html).

## Qualification

`simd-extended-fixtures.mjs` exports ordinary source fixtures in the same format
as the existing core SIMD suite. The native harness runs five required stages
for each case: GCC, relocatable WABT assembly, object disassembly, LLD link and
actual WASI execution. Both WAT and object code must contain required SIMD
instructions; disabled profiles must contain none. It verifies exact stdout,
exit status, WASI imports, `_start`/memory exports and byte identities of the
compiler, assembler, linker, CRT, libc, libm and compiler builtins.

An optional Clang run is an independent oracle under `clangOracle` in the
receipt. Its output never substitutes for GCC code generation. C++ fixtures use
`cc1plus` with exceptions and RTTI disabled and do not need libstdc++.

```sh
node producer/gcc-wasi/test-simd-extended.mjs \
  --compiler /path/to/native-build/gcc \
  --source /path/to/pinned-patched-gcc \
  --work out/gcc-wasi-work \
  --sdk /path/to/wasi-sdk-33 \
  --sysroot /path/to/single-thread-wasi/sysroot \
  --output /path/to/new/qualification-directory \
  --oracle clang
```

Use Node 22.18+ or 24.10+; the qualified run records its actual executable in
`commands`. Each output directory must be new. `--cases` selects a diagnostic
subset and must not be presented as full-suite qualification.

Native and Chromium Worker results are recorded separately. Packaging may
produce an unverified candidate for Worker testing; only completed execution
receipts qualify a bundle. The private native build of the pinned five-patch baseline plus
`0006-simd-operations.patch` passed all 62 cases on 2026-10-27: 52 SIMD-enabled
cases and 10 disabled cases. The same 62 source files also passed the independent
WASI SDK 33 Clang oracle. Existing core SIMD regression cases passed 25/25.
Node 22.23.3 executed the programs. Both default and explicitly disabled feature
macro diagnostics failed as expected.

The source patch was reapplied to a separate copy of the exact baseline target
files, and all resulting target bytes matched the compiled source. Native
compiler identities were:

- `cc1`: `787661efa2f29a4108e2b1720c2b4a15a16185a26aaa6ce83230ea67a2060fb3`
- `cc1plus`: `0a46db060707e64ca58aaade99652bc3e83ed1f368e89325661b7af88ffcb08a`

Local evidence is archived in
`out/review-simd/extended-private-20261027.tar.gz` (the `qualification.json`
receipts, sources, WAT, Wasm objects, disassemblies, linked programs and oracle
programs). This private native result does not certify a rebuilt compiler with
additional patches or a Wasm-host/browser compiler; integration must run those
compilers again. The private build exited 0; its local build log and status are
`~/logs/gcc-wasi-simd-extended-build1-20261027.{log,status}`.
