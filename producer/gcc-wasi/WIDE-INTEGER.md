# GCC wide integer builtins and bitfields

This extends the qualification of the existing [public int128 backend](INT128.md).
It uses real GCC `cc1`/`cc1plus`, GCC Wasm code generation, annotated-WAT objects,
external LLVM `wasm-ld` and WASI Preview 1 execution. The compiler's Wasm host and
the generated program's `wasm32-wasi` target remain separate. No source rewrite,
Clang fallback or substitute integer implementation is part of GCC compilation.

The expanded matrix qualifies the existing backend with **122 native runs**
and **52 Chromium Worker programs**. Its bitfield probes exposed a named-field
alignment ABI defect and actual nested-record corruption between GCC and Clang
objects. Patch `0011-bitfield-layout.patch` addresses layout and singleton call
classification together. The [completion report](../../docs/gcc-wasi-completion-20261027.md)
binds the final eleven-patch compiler, current runtime, results and artifacts;
earlier C5 results alone do not qualify a rebuilt browser bundle.

## Source-level builtin scope

[The builtin fixtures](wide-integer-builtins-fixtures.mjs) contain twelve
profiles, each at O0 and O2. GCC always receives the original GNU builtin source.
Clang references use either that same accepted source or an explicit portable
reference program stored separately in the fixture. Portable references are
comparison inputs; they never replace a failed GCC compilation or enter the
Worker compiler request.

| Profile | GCC source exercised | Native Clang comparison |
| --- | --- | --- |
| `clzg-defined-zero` | `__builtin_clzg` on unsigned int128, including zero with a defined fallback | Same source |
| `ctzg-defined-zero` | `__builtin_ctzg` on unsigned int128, including zero with a defined fallback | Same source |
| `popcountg` | `__builtin_popcountg` across both words | Same source |
| `parityg` | `__builtin_parityg` | Portable bit-count loop |
| `ffsg` | `__builtin_ffsg`, including zero | Portable trailing-bit loop |
| `clrsbg` | `__builtin_clrsbg`, including zero, minus one and signed extremes | Portable sign-bit loop |
| `constant-folding` | Constant inputs to generic count builtins and variable `__builtin_add_overflow_p`, `__builtin_sub_overflow_p`, `__builtin_mul_overflow_p` | GCC only; explicitly skipped |
| `bswap128` | `__builtin_bswap128` | Portable sixteen-byte reversal |
| `overflow-builtins` | Signed and unsigned `__builtin_add_overflow`, `__builtin_sub_overflow`, `__builtin_mul_overflow` | Same source |
| `stdc-bit-operations` | Accepted C-only `__builtin_stdc_*` bit functions | Portable loops and shifts |
| `stdc-rotate` | C-only `__builtin_stdc_rotate_left` and `__builtin_stdc_rotate_right` | Portable modulo-width rotations |
| `builtin-provider-abi` | Independent provider TU with `popcountg` and `clzg`, direct and indirect calls | Same source, all four compiler directions |

The `stdc-bit-operations` profile exercises `bit_width`, `bit_floor`, `bit_ceil`,
`count_ones`, `count_zeros`, `has_single_bit`, `leading_zeros`, `trailing_zeros`,
`leading_ones`, `trailing_ones`, `first_leading_one`, `first_trailing_one`,
`first_leading_zero` and `first_trailing_zero`, each with the `__builtin_stdc_`
prefix. `bit_ceil` is called only when its result is representable. Rotate counts
include 0, 64, 128 and larger values, and both rotate builtins check single
evaluation of arguments with side effects. Constant-input tests check results;
their profile name does not assert a particular optimization pass or WAT shape.

Volatile inputs keep the variable paths live. Expected counts, byte reversals
and rotations use independent BigInt calculations outside the compiler path.
Zero count operations use defined forms. Overflow checks use the builtin's
defined result semantics; ordinary undefined signed overflow and invalid shifts
are excluded. Real `-DONLINE_JUDGE=1` options reach every GCC source.

### Word expansion and runtime helpers

The pinned compiler-rt archive does not contain `__clrsbti2`. That symbol's
absence alone does not show a source-level failure. Actual GCC compilation of
`__builtin_clrsbg(__int128)` produced two `i64.clz` operations at both O0 and O2,
with no `__clrsbti2` call or object import. No helper stub was added. Other
exercised paths emitted calls including `__bswapdi2` and `__multi3`, resolved by
the existing pinned runtime libraries. The native report retains WAT, objects,
helper calls, imports, word opcodes, linked programs and actual execution.

The builtin profiles account for **24 Worker programs and 50 native runs**.
The provider profile uses all four GCC/GCC, GCC/Clang, Clang/GCC and Clang/Clang
main/provider directions. The other profiles use same-compiler controls, except
the two GCC-only constant cases, whose absent Clang comparison is explicit in
the report. No claim is made for unlisted target-specific builtin interfaces.

## Bitfield layout and ABI repair

The pinned [WebAssembly Basic C ABI](https://github.com/WebAssembly/tool-conventions/blob/25aceba5adba8f3f7cdbadd8e8705784aebcad6a/BasicCABI.md#bit-fields)
requires named bitfields to retain the declared type's alignment and fit in a
storage unit suitable for that type. Unnamed bitfield types do not raise the
record's alignment. This is an ABI requirement beyond agreement between two
compilers on field arithmetic.

The original port left `PCC_BITFIELD_TYPE_MATTERS` at GCC's default false.
For the following ordinary records, the preserved C5 compiler and pinned WASI
SDK 33 Clang 22.1.0 produced these actual results:

```c
typedef unsigned __int128 U;
struct Bits { U low:61; U middle:19; U high:48; };
struct Nested { unsigned char before; struct Bits bits; unsigned char after; };
```

| Observation | C5 GCC | Pinned Clang |
| --- | --- | --- |
| `sizeof(struct Bits)` | 16 | 16 |
| Alignment of `struct Bits` | 1 | 16 |
| `sizeof(struct Nested)` | 18 | 48 |
| Offset of `Nested.bits` | 1 | 16 |
| Offset of `Nested.after` | 17 | 32 |

Both same-compiler controls read and write the correct logical fields. The
nested-record test then links independently compiled pointer-based providers
and consumers, with direct and indirect calls. At O0 and O2, both mixed compiler
directions read incorrect field values even though the Wasm function types
validate and linking succeeds. The test asserts logical values without assuming
Clang offsets. A zeroed, oversized allocation keeps the pre-fix offset accesses
within the reserved storage. The original failing artifacts remain evidence of
the ABI defect.

Patch `0011` sets `PCC_BITFIELD_TYPE_MATTERS` to 1 for this Wasm target. GCC's
ordinary record layout then applies named fields' declared type alignment and
storage-unit boundaries. The default `TARGET_ALIGN_ANON_BITFIELD` remains false,
preserving the unnamed-field rule. Packed fields retain the packed layout.
Record layout can narrow a bitfield's internal `TREE_TYPE` to its value width.
Singleton call classification instead uses `DECL_BIT_FIELD_TYPE`, preserving the
original declared storage type. Otherwise a short or int bitfield's enlarged
record becomes incorrectly indirect, while a packed narrow field can become
incorrectly direct. Existing scalar ABI tests exposed four mixed-compiler
failures before this second part of the repair. The additional
[singleton fixtures](singleton-bitfield-fixtures.mjs) cover short/long-long and
packed int/long-long direct, indirect and callback calls at O0/O2: 32 native
runs and eight browser programs. No x86 target configuration is changed.

[The bitfield fixtures](wide-integer-bitfields-fixtures.mjs) cover:

- Unsigned 61/19/48-bit fields, signed 65-bit fields and a 127-bit field, with
  cross-word updates, sign extension and neighboring fields preserved.
- Packed 9/73/46-bit fields between byte tags at an intentionally unaligned heap
  address, and packed 100/100/56-bit fields crossing a 128-bit storage boundary.
- Explicit 32-byte alignment, GNU union word views and C++ volatile members,
  copies and member calls.
- C and C++ controls for named `int`/`short` alignment, unnamed wide fields,
  zero-width boundaries, declared storage-unit boundaries and packed records.
- Ordinary, packed, aligned and nested multi-TU records, with direct calls,
  function pointers and callbacks where applicable, in all four native compiler
  directions.

Signed field updates stay within range. Unsigned truncation follows the field
width. Raw layout comparisons cover named bits only; the boundary control masks
unused bits and bounds its copy by the actual object size, including on the
smaller broken C5 layout. Padding values are not expected output. GNU union
views and GNU wide bitfield types are explicit extensions in this test profile.

The bitfield profiles account for **28 Worker programs and 72 native runs**.
Their pinned Clang controls pass, while the old compiler's alignment and mixed
nested-record failures remain recorded. Fresh GNU runtime libraries and all
earlier scalar, vector, binary128 and int128 gates must be rerun after changing
record layout; the old runtime's receipt cannot qualify the rebuilt compiler.

## Reproduce the complete matrix

Use the fixed source and tools from [README.md](README.md#reproduction), including
the current eleven-patch lock and newly built native and Wasm compiler hosts.
Keep every input stable until consumers finish and use new output directories.
Run with the same Node 22 executable used for the matching bundle qualification.

```sh
node producer/gcc-wasi/wide-integer-test.mjs \
  --suite producer/gcc-wasi/wide-integer-fixtures.mjs \
  --lock producer/gcc-wasi/sources.lock.json \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/wide-integer-qualification"
```

The combined fixture module binds both child modules through its `dependencies`
list. The native report records their bytes alongside the harness, lock,
compiler, tools, headers, backend sources and runtime archives, then checks that
inputs remain unchanged. A complete run has **122 cases** and kind
`gcc-wasi-wide-integer-qualification`. Filtered runs are diagnostic subsets.

After producing a fresh trusted bundle and building the matching SDK, run from
the wasm-idle checkout:

```sh
node scripts/verify-gcc-wasi.mjs \
  --manifest /absolute/path/to/new-bundle/gcc-toolchain.v2.json \
  --suite /absolute/path/to/wasm-llvm/producer/gcc-wasi/wide-integer-fixtures.mjs \
  --save-intermediates --output out/gcc-wasi-wide-integer-browser
```

All **52 programs**, 26 each at O0 and O2, must compile through actual Wasm-host
GCC and execute with exact stdin/stdout in Chromium Workers and Node WASI. Saved
WAT and object captures cover each main TU; the compiler processes every requested
source TU. Native mixed-compiler linking is separate from browser compilation.
Final validation must bind the trusted manifest and all assets to the same
source, inspect imports/exports and memory, and retain the complete reports and
artifacts. These fixtures need the existing libc/libm/compiler-rt link profile,
no additional int128 flag, no libstdc++ archive and no SIMD. They do not add a new
SDK option or manifest capability.

Mixed unnamed/named bitfield singleton shapes retain a separate
[unqualified ABI follow-up](https://github.com/seo-rii/wasm-llvm/issues/93).
The preserved evidence compares C7 GCC WAT with Clang IR; it is not a claim of
C8 mixed-program execution. This scope does not qualify threads, wide atomic
interfaces, dynamic linking, exceptions, RTTI or complete C/C++ conformance. Earlier ABI and SIMD suites and
the separate GCC x86 regressions remain necessary for the final bundle.
