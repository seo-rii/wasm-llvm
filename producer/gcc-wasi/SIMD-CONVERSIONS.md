# SIMD conversions

Patch `0015-simd-conversions.patch` supplies GCC optabs and eight typed target
builtins for the 26 baseline Wasm SIMD128 conversion instructions. The producer
continues to compile user source through real GCC frontend and RTL passes.

| Operation | Direct Wasm instructions |
| --- | --- |
| Signed/unsigned integer extension | `i16x8.extend_{low,high}_i8x16_{s,u}`, `i32x4.extend_{low,high}_i16x8_{s,u}`, `i64x2.extend_{low,high}_i32x4_{s,u}` |
| Signed wider integer to saturating narrow | `i8x16.narrow_i16x8_{s,u}`, `i16x8.narrow_i32x4_{s,u}` |
| Integer to floating point | `f32x4.convert_i32x4_{s,u}`, `f64x2.convert_low_i32x4_{s,u}` |
| Saturating floating point to integer | `i32x4.trunc_sat_f32x4_{s,u}`, `i32x4.trunc_sat_f64x2_{s,u}_zero` |
| Floating point width | `f64x2.promote_low_f32x4`, `f32x4.demote_f64x2_zero` |

Every direct pattern requires `-msimd128`. The supported public register and ABI
modes remain `V16QI`, `V8HI`, `V4SI`, `V2DI`, `V4SF`, and `V2DF`. Four internal
64-bit half modes describe nested RTL expressions in unpack/narrow patterns;
they do not enable a public 64-bit vector calling convention.

## Explicit saturating builtins

All vector types below have `__attribute__((vector_size(16)))`. `i8`, `i16` and
`i32` mean `signed char`, `short` and `int`; their unsigned counterparts use the
corresponding unsigned C type. `f32` and `f64` mean `float` and `double`.

| Name after `__builtin_wasm_` | Result | Arguments |
| --- | --- | --- |
| `trunc_saturate_s_i32x4_f32x4` | signed i32x4 | f32x4 |
| `trunc_saturate_u_i32x4_f32x4` | **signed i32x4** | f32x4 |
| `trunc_sat_s_zero_f64x2_i32x4` | signed i32x4 | f64x2 |
| `trunc_sat_u_zero_f64x2_i32x4` | unsigned i32x4 | f64x2 |
| `narrow_s_i8x16_i16x8` | signed i8x16 | signed i16x8, signed i16x8 |
| `narrow_u_i8x16_i16x8` | unsigned i8x16 | **signed** i16x8, **signed** i16x8 |
| `narrow_s_i16x8_i32x4` | signed i16x8 | signed i32x4, signed i32x4 |
| `narrow_u_i16x8_i32x4` | unsigned i16x8 | **signed** i32x4, **signed** i32x4 |

These names and signatures match the pinned SDK33 Clang declarations. The
unsigned f32 saturation builtin's signed result is an API convention: its bits
represent saturated unsigned 32-bit lanes. Bitcast the result vector to unsigned
lanes when unsigned arithmetic or printing is desired. C/C++ fixture type
assertions verify the exact result types.

Float saturation truncates toward zero, maps NaN to zero, and clamps finite
overflow and infinities to the destination minimum/maximum. The f64 variants
write integer zero to both high lanes. Explicit total saturation uses target
UNSPEC patterns so optimization cannot substitute the undefined behavior of an
out-of-range ordinary source cast.

Narrowing concatenates the first input's lanes followed by the second's and
clamps each lane. Wasm's unsigned narrow consumes **signed** wider inputs:
negative values become zero. It is not registered as GCC `us_truncate` or a
plain `vec_pack_usat` instruction, which would incorrectly interpret high-bit
source values as unsigned. Signed narrowing uses `vec_pack_ssat` patterns.

Live calls to these builtins diagnose with the default target options or
`-mno-simd128`. Width, element-type and arity checking comes from real builtin
declarations. Ordinary vector casts retain GCC's defined scalar fallback.

## Ordinary casts and composed conversions

Standard float/fix and low/high unpack optabs implement ordinary
`__builtin_convertvector` operations. Ordinary float-to-integer fixtures use
only representable inputs; NaN, infinity and out-of-range values belong to the
explicit saturation tests.

High-half i32/u32-to-f64 conversion and f32-to-f64 promotion first shuffle the
high lanes into the low half, then use the direct low-half instruction.
Two-input f64-to-f32 and f64-to-i32/u32 packs convert each input separately and
shuffle the two low halves into the full result. A single zero-high conversion
cannot represent a two-input GCC pack.

Ordinary two-input integer packs from i16 to i8, i32 to i16, and i64 to i32
select the low bytes with a shuffle. They discard high bits and do not saturate.
Demotion rounds to f32, preserves the signs of finite zero values and fills its
high lanes with positive zero. Tests compare exact finite result bits and NaN
classification; they do not require a particular NaN payload.

There is no baseline i64x2/f64x2 conversion instruction. Defined ordinary casts
continue through lane extraction, scalar conversion and lane construction.
Separate signed/unsigned controls require a real scalar conversion in the
conversion function and check rounding near 2^53 and 64-bit limits.

For full-vector unpack optabs, keep the complete 128-bit source during the
conversion. A local `vector_size(32)` destination can hold both widened halves
before selecting the desired 128-bit result. A 64-bit half-vector source may
scalarize before RTL because it has no supported register mode. This patch does
not promise that every equivalent source spelling selects the same instruction.

## Qualification

The [completed qualification record](../../docs/gcc-wasi-simd-conversions-20261030.json)
binds the fifteen-patch source, fresh GNU runtime and packaged Wasm-host
compiler. Native qualification passed 2,134 executions, including its
GCC/Clang interoperability and reference controls, plus 272 diagnostic checks.
The same-source Wasm-host compiler produced 827 canonical programs and another
12 default-option programs; all passed actual Chromium Worker and independent
Node WASI execution. All 272 raw Worker diagnostics and 176 conversion-function
opcode checks passed. Historical baseline and harness-preflight executions are
recorded separately from these totals.

```sh
node producer/gcc-wasi/test-simd-conversions.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-current/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-conversions-qualification"
```

The fixed matrix has 41 operation profiles in C/C++ at O0/O2: 164 SIMD-enabled
programs, plus 12 explicit disabled-SIMD controls. Another 12 executions repeat
those controls with the SIMD option omitted. All 188 executions use actual
stdin, compile/assemble/link steps and WASI stdout.

An independent BigInt oracle computes lane limits, IEEE ties-to-even rounding,
subnormals, signed zero and overflow. The fixture uses a volatile function
pointer to its noinline conversion function. Required direct, composed or
scalar instructions must occur in that actual function's disassembly, not just
somewhere in the object. WABT decodes the object; the inspector does not search
raw bytes for `0xfd` and handles multi-byte SIMD subopcodes through the decoded
instruction output.

The 192 rejected compilations include all 32 valid builtin programs with both
default and explicitly disabled SIMD (64), and every builtin with wrong width,
wrong element kind, too few arguments and too many arguments in C/C++ at O0/O2
(128). Ordinary casts are excluded from the builtin rejection matrix.

The receipt binds the full locked source state, real native C/C++ compilers,
header inventories, fixture/harness/inspection recipes, tools, runtime and
reopened assembly/object/program bytes. Canonical cases, the additional default
controls and rejection profiles are recorded separately. Native execution is
required before building the same-source Wasm-host compiler and validating the
actual Chromium Worker path. Qualification evidence must establish both hosts;
the existence of these patterns or a passing Clang reference alone does not.
