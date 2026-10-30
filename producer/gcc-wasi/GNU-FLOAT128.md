# GNU binary128 type

Patch `0014-gnu-float128.patch` exposes GNU `__float128` in the real GCC C/C++
frontends, following the existing thirteen backend patches. It reuses the
qualified TFmode binary128 representation, operations and calling convention.
It adds no source translation, runtime archive or scalar replacement for the
real compiler. This document specifies the support contract; a test matrix or
reproduction command alone does not declare a compiler bundle qualified.

## Type, literals and C++ identity

The type has 16-byte size and alignment, 113-bit precision and IEEE binary128
storage. `__SIZEOF_FLOAT128__` is 16. Decimal and hexadecimal literals with `Q`
or `q` suffix have GNU `__float128` type, including when the target's
`long double` has the same machine mode. GNU language modes accept these
extension spellings; strict/pedantic modes retain GCC's extension diagnostics.

| Language | Relationship | C++ mangling |
| --- | --- | --- |
| C | `__float128` aliases `_Float128`; `long double` is distinct | Not applicable |
| C++ | All three types are distinct and can be overloaded | `__float128`: `g`; `_Float128`: `DF128_`; `long double`: `e` |

The target registers the existing C type or a distinct C++ GNU type. Its
mangling hook matches that exact type, including cv-qualified variants. A small
frontend correction selects the GNU type for `Q` literals by its matching mode:
the generic mode-to-type lookup otherwise returns `long double` first on this
target. No numeric conversion or ABI change is involved in that correction.

The pinned C++ frontend also needs a conversion-rank correction when GNU
`__float128` and `long double` are distinct types with the identical binary128
format. Each has equal rank relative to `_Float128`, so their pairwise ranks
must agree. The correction preserves ambiguous conversions between those two
overloads, exact overload matches, and the legacy usual arithmetic conversions;
the three-type fixture checks all of these cases instead of removing the
frontend's consistency assertion.

Arithmetic, comparisons, negation and integer/floating conversions use the
existing binary128 backend. Values do not require SIMD. Named arguments use
low/high i64 pairs, and results use a leading i32 pointer to caller-provided
storage. Direct calls, indirect calls and C++ overloaded symbols retain those
signatures across the pinned GCC and Clang translation units.

## Runtime and GNU library boundary

The existing SDK 33 compiler-rt archive supplies the required helpers. Its
SHA-256 is `b1e23c0376609e09052ff225f290d971b0f8eabd3ffd0737e5d0ebb10f1880d1`.
The [runtime inventory](../../docs/gcc-wasi-gnu-float128-runtime-20261030.json)
records 28 helper symbols from 22 original archive members, their object hashes
and their actual Wasm signatures. For example, `__addtf3`, `__subtf3`,
`__multf3` and `__divtf3` take `(i32, i64, i64, i64, i64)` and return no direct
value. Comparisons take two i64 pairs and return i32. Integer conversions cover
signed/unsigned 32-, 64- and 128-bit values; SF/DF conversions use f32/f64.

Explicit casts to the same-representation `long double` provide access to the
existing WASI math and text APIs. The actual `sqrtl`, `fmal` and `strtold`
definitions are in SDK 33's `libc.a`; `libm.a` is an eight-byte compatibility
archive. Long-double text conversion selects `libc-printscan-long-double.a`
before libc. The fixtures check these conversions without declaring GNU `q`
library functions as aliases or changing their ABI.

The feature macro enables the existing GNU libstdc++ extensions for type traits,
`numeric_limits<__float128>` and `std::abs(__float128)`. A fresh GNU runtime must
be built with the current compiler and qualified again. Its headers use generic
floating builtins or the existing binary128 `long double` path; these tested
extensions do not require libquadmath.

The complete existing license inventory remains in the bundle. Compiler-rt's
notice includes Apache-2.0 with LLVM exceptions and its retained legacy
University of Illinois/MIT notices. WASI libc and its math components retain
their complete component notices. The packager verifies those bytes. This
change adds no libquadmath archive, header or LGPL payload.

This support contract does not expose `<quadmath.h>`, GNU `sqrtq`/`fmaq` and
related library functions, GNU `__builtin_huge_valq`/`__builtin_infq`/
`__builtin_nanq`, complex128, dynamic rounding modes or floating exception flags.
Full GNU libquadmath requires separate numerical and portability work: WASI
defines only `FE_TONEAREST` and no observable floating exception flags, while
upstream `fmaq.c` uses toward-zero rounding and inexact flags in its numerical
algorithm. Defining missing constants cannot supply that behavior.

## Qualification

The [fixture module](gnu-float128-fixtures.mjs) contains 36 original C/C++ sources
and exact dyadic, integer or byte expectations. It covers type size/alignment,
feature macros, decimal/hexadecimal literals, precision beyond binary64,
arithmetic, comparisons, signed zero, NaN payloads, subnormals, conversions,
global/packed/heap storage, callbacks and multiple translation units. C++
overload tests check both actual object signatures and mixed GCC/Clang linking.
The complete native matrix has 78 runs. Six GNU-only type-relationship and
libstdc++ references explicitly exclude Clang instead of substituting a
different type or library. Packaging patch `0014` requires this complete proof
through `--gnu-float128-qualification`, reopens every object and program, and
checks the same source, tool, header and runtime identities as the existing
binary128/int128 gates.

Use the pinned source/tool setup in [README.md](README.md#reproduction). Build
the native compiler and a fresh GNU runtime before the native matrix:

```sh
node producer/gcc-wasi/wide-integer-test.mjs \
  --suite producer/gcc-wasi/gnu-float128-fixtures.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-current/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/gnu-float128-qualification"
```

Keep source, runtime, tool and fixture inputs unchanged during qualification.
Rerun the existing binary128, int128, ABI and SIMD gates with the same compiler.
Only after native qualification, build the Wasm-host compiler from the same
locked sources and run the fixture module through the actual SDK compiler and
Chromium Worker, including independent Node execution of its emitted programs.
The separate GCC 13/16 x86 producers are unaffected.
