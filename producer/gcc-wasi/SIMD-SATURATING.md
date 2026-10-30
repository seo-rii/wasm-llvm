# SIMD saturating addition and subtraction

Patch `0013-simd-saturating-arithmetic.patch` adds GCC RTL patterns and typed
target builtins for the eight saturating operations in baseline WebAssembly
SIMD128. Compile live calls with `-msimd128`. Each builtin takes two vectors of
the indicated type and returns the same vector type.

| Lane type (`vector_size(16)`) | Builtins | Encoded instructions |
| --- | --- | --- |
| `signed char` | `__builtin_wasm_add_sat_s_i8x16`, `__builtin_wasm_sub_sat_s_i8x16` | `i8x16.add_sat_s`, `i8x16.sub_sat_s` |
| `unsigned char` | `__builtin_wasm_add_sat_u_i8x16`, `__builtin_wasm_sub_sat_u_i8x16` | `i8x16.add_sat_u`, `i8x16.sub_sat_u` |
| `short` | `__builtin_wasm_add_sat_s_i16x8`, `__builtin_wasm_sub_sat_s_i16x8` | `i16x8.add_sat_s`, `i16x8.sub_sat_s` |
| `unsigned short` | `__builtin_wasm_add_sat_u_i16x8`, `__builtin_wasm_sub_sat_u_i16x8` | `i16x8.add_sat_u`, `i16x8.sub_sat_u` |

For each lane, compute the mathematical sum or difference and clamp it to that
lane type's minimum and maximum. Signed results clamp to [-128, 127] or
[-32768, 32767]; unsigned results clamp to [0, 255] or [0, 65535]. Lanes keep
their order. There is no integer overflow in the builtin's mathematical result.

```c
typedef signed char i8x16 __attribute__((vector_size(16)));
i8x16 add_clamped(i8x16 left, i8x16 right) {
  return __builtin_wasm_add_sat_s_i8x16(left, right);
}
```

The backend registers the standard `ssadd`, `usadd`, `sssub` and `ussub` optabs
for `V16QI` and `V8HI`. Each builtin expands through the corresponding optab
into the dedicated instruction pattern. The producer performs no source or
assembly rewriting. This establishes explicit builtin access; it does not
promise recognition or vectorization of arbitrary scalar clamp expressions.

The default and `-mno-simd128` profiles reject live calls with an explicit
`SIMD128 is disabled` diagnostic. Existing scalar programs remain supported.
Arguments must have the full 16-byte vector type. There are no saturating
32-bit or 64-bit lane builtins, floating-point saturating operations, or
`wasm_simd128.h` header in this patch. Existing vector ABI rules apply to calls
between translation units; see [VECTOR-ABI.md](VECTOR-ABI.md).

## Qualification

```sh
node producer/gcc-wasi/test-simd-saturating.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-saturating-qualification"
```

The native harness compiles 32 programs: eight operations in C and C++, each
at `-O0` and `-O2`. Every program reads a rotation from stdin, evaluates all 64
pairs of eight representative boundary/interior lane values in mixed vectors,
and prints every result. A separate BigInt calculation in the fixture supplies
the expected output, including signed upper/lower clipping, unsigned overflow
and underflow, exact bounds and ordinary interior results. The compiler cannot
replace the live inputs with precomputed output.

Four C/C++ O0/O2 scalar programs provide disabled-SIMD controls. For every
successful program the harness checks real GCC assembly, the disassembled
relocatable object, fatal-warning linking, executable Wasm imports/exports and
Node WASI stdout. Each vector program must contain its exact saturating opcode
and none of the other seven. Independent `wasm-validate --disable-simd` rejects
the vector programs and accepts the scalar controls.

The 80 diagnostic compilations cover every live builtin program with both
default and explicit disabled SIMD (64), plus wrong vector widths and absent
32/64-bit lane builtins in C/C++ at O0/O2 (16). They must fail with the expected
compiler diagnostic and emit no SIMD assembly.

The receipt records the locked patch set, actual native compiler binaries,
header inventories, target source, fixture and harness hashes, assembler,
disassembler, linker, validator and execution engine. Inputs are rechecked
after execution. Packaging patch `0013` requires this complete receipt together
with the existing SIMD, extended SIMD and vector ABI receipts from the same
compiler. The packager also reopens the recorded assembly, object and program
bytes. Older SIMD-only receipts cannot qualify the new backend patterns.

Native qualification is one stage. A distribution also needs the same-source
Wasm-host compiler, a freshly qualified GNU runtime and actual Chromium Worker
execution before it can be called browser-qualified.
