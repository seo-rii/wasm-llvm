# Runtime vector permutations

The pinned GCC Wasm target supports runtime `__builtin_shuffle` selectors through
GCC's existing scalar fallback. This qualification defines that path for the six
128-bit GNU vector modes (`V16QI`, `V8HI`, `V4SI`, `V2DI`, `V4SF`, `V2DF`) in C and
C++, at `-O0` and `-O2`. It adds regression coverage and a documented lowering
contract; it does not add a backend patch or change package capabilities.

## Selector semantics

`__builtin_shuffle(a, mask)` selects from one vector; `__builtin_shuffle(a, b,
mask)` selects from their concatenation. The mask is an integer vector with the
same element width and number of lanes as the data vector. For `N` data lanes,
selectors are reduced modulo `N` or `2*N`, respectively, in memory order.
Negative selectors follow the same rule: `-1` selects the last available lane.
It is not the don't-care selector accepted by the different, constant-selector
`__builtin_shufflevector` builtin. See GCC's [vector extension
contract](https://gcc.gnu.org/onlinedocs/gcc/Vector-Extensions.html).

For example, with four lanes per vector, the two-input selectors `{-1, 8, 9, -8}`
select `{b[3], a[0], a[1], a[0]}`. Large signed and unsigned mask values are valid
when representable in the mask element type. The fixtures avoid out-of-range
signed conversions and retain exact 64-bit selectors as decimal strings.

## Current lowering

The target implements the constant permutation hook and `i8x16.shuffle`, but
has no variable `vec_perm` instruction pattern. GCC's `lower_vec_perm` in
`gcc/tree-vect-generic.cc` expands the runtime operation piecewise:

1. Mask the selector to obtain a lane index.
2. For two inputs, use the selector's `N` bit to choose the input vector.
3. Load the selected scalar lane and construct the result vector.

The native harness enables `-Wvector-operation-performance` and requires GCC's
piecewise-expansion diagnostic. It also inspects the actual `convert` function
in both GCC WAT and the assembled object: scalar selector masking and the
mode's scalar load must be present. Runtime `i8x16.swizzle` and relaxed swizzle
are not emitted by this qualified path. Enabled SIMD may still use `v128`
loads, stores, lane extraction or result construction around scalar selection.
Disabled SIMD and the native compiler default produce scalar programs that
validate with SIMD disabled.

| Data mode | Required scalar data load in `convert` |
| --- | --- |
| i8x16 | `i32.load8_s` |
| i16x8 | `i32.load16_s` |
| i32x4 | `i32.load` |
| i64x2 | `i64.load` |
| f32x4 | `f32.load` |
| f64x2 | `f64.load` |

Any future swizzle lowering must preserve GCC's modulo rule before converting
lane selectors to byte selectors: ordinary Wasm swizzle zeroes bytes selected
by indices outside its 16-byte input. See the [Wasm swizzle
semantics](https://webassembly.github.io/spec/core/exec/numerics.html#op-ivswizzle).
This result makes no performance or auto-vectorization guarantee. Constant
shuffles retain their existing [instruction contract](SIMD-EXTENDED.md).

## Qualification

`runtime-permutation-fixtures.mjs` exports `cases`, `disabledCases` and
`defaultCases`. The runtime matrix covers six data modes, one or two inputs,
signed or unsigned masks, C or C++, `-O0` or `-O2`, and three feature profiles.
All selectors arrive through stdin, and an address-taken operation is invoked
through a volatile function pointer. Two distinct input sets include integer
high bits and floating-point signed zeros, quiet NaN payloads, subnormals and
infinities; output is compared as all 16 result bytes.

| Profile | Runtime cases | Original constant cases | Total |
| --- | ---: | ---: | ---: |
| Enabled | 96 | 12 | 108 |
| Explicitly disabled | 96 | 2 | 98 |
| Default | 96 | 0 | 96 |
| Total | 288 | 14 | 302 |

The fourteen constant fixtures are imported unchanged from
`simd-extended-fixtures.mjs`. Their enabled `permute` functions must contain
`i8x16.shuffle`. Function-scoped inspection prevents an opcode in another
function, a comment, a string or a local declaration from satisfying a check.

The native harness compiles the original GNU builtin expression with GCC and
links and executes its relocatable Wasm object. A separate Clang source selects
the same bytes with scalar unsigned mask-and operations and disables loop/SLP
vectorization. This independent Clang oracle never replaces the GCC source or
output; the constant cases use their unchanged original source in both
compilers. Fixture expectations use modulo arithmetic, independently checked
against the mask-and selection. Every execution must match exact stdout and
exit status, export `_start` and memory, and import only WASI Preview 1 functions.

```sh
node --test producer/gcc-wasi/runtime-permutation-fixtures.test.mjs \
  producer/gcc-wasi/runtime-permutation-inspect.test.mjs

node producer/gcc-wasi/test-runtime-permutation.mjs \
  --compiler /path/to/native-build/gcc \
  --source /path/to/locked-patched-gcc \
  --work /path/to/gcc-wasi-work \
  --sdk /path/to/wasi-sdk-33 \
  --sysroot /path/to/single-thread-wasi/sysroot \
  --output /path/to/new-qualification-directory
```

Use Node 22.18+ or 24.10+. The work directory must contain the matching native
build and qualification receipts and native WABT tools. The harness verifies
the current source lock, exact patched GCC source, build recipe and compiler
identities before execution. It records commands, sources, WAT, objects,
disassemblies, linked programs, runtime/header hashes and the separate GCC and
Clang results in `qualification.json`, then rechecks input and artifact hashes.
`--cases ID,...` selects a diagnostic subset and records all unselected cases;
such a result is not full-suite qualification.

For the public SDK harness in `wasm-idle`, a local suite wrapper should export
`cases = [...enabledCases, ...disabledCases, ...defaultCases]` from the three
fixture exports, then run `scripts/verify-gcc-wasi.mjs --manifest BUNDLE.json
--suite WRAPPER.mjs --save-intermediates --output NEW_DIR`. All 302 original GCC
programs must be compiled with the real Wasm-host GCC, WABT and WASI LLD in
Chromium Worker, executed in Worker, and independently executed with Node WASI.
The saved WAT/object operation bodies must pass the same inspector.

The 96 default fixtures intentionally omit the SDK request's `simd` property.
The current SDK translates that omission to `-mno-simd128`; those executions
qualify the public API default. The native harness separately omits both
compiler SIMD flags, qualifying the compiler's own default. These are distinct
checks and must not be reported as the same frontend invocation.

The 2026-10-30 native qualification passed 302 GCC executions and 302 independent
Clang executions with all 549 input files unchanged. It uses the already built
17-patch compiler at source-diff SHA-256
`152915d721c9b743f0345efd564bbf143bf53b8f7bf36b8f261dd25ba1cdd7d1`.
The actual SDK Worker passed all 302 original GCC programs, and each resulting
program also passed independent Node WASI execution. All 486 Worker inputs
remained unchanged. Reinspection checked 302 WAT/object operation bodies per GCC
host and reopened 3,926 native/Worker artifacts. The immutable package manifest
has SHA-256
`d8fa39679b4c9f9f8fd5376ed84b33942f0ac81f76b0e10ce8767efe4b7e547d`.
Exact identities, counts and separate execution receipts are in the
[review receipt](../../docs/gcc-wasi-runtime-permutation-20261030.json).
