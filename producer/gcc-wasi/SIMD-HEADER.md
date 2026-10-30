# GCC WebAssembly SIMD intrinsic header

Patch `0016-wasm-simd128-header.patch` installs an independently implemented
`wasm_simd128.h` through GCC's target header mechanism. It provides the
documented **169-name subset** of SDK 33's WebAssembly SIMD128 interface.
The exact names are listed in `simd-header-api.mjs` and covered by the matching
source fixtures. This is a bounded subset of the LLVM header.

| API group | Names |
| --- | ---: |
| Unaligned load and store | 2 |
| Constructors, splats, lane extraction and replacement | 40 |
| Wrapping integer arithmetic | 15 |
| Floating arithmetic | 10 |
| Bitwise operations | 4 |
| Integer and floating comparisons | 48 |
| Scalar-count shifts | 12 |
| Signed and unsigned saturating arithmetic | 8 |
| Integer and floating conversions | 26 |
| Constant shuffles | 4 |
| **Total** | **169** |

Compile with `-msimd128`. Inclusion without `__wasm_simd128__` produces an
explicit diagnostic; the header does not silently enable a target pragma.
`v128_t` has the same four-`int32_t`, 16-byte-aligned representation as the
pinned SDK header. Public vector values remain 128 bits wide.

Ordinary operations are inline functions. Extraction, replacement and fixed
shuffles are macros because their lane indices must be compile-time constants
within range. These 24 immediate macros evaluate each vector or scalar data
operand once. They do not provide an address-taking interface. Narrow lane
extraction retains the exact signed or unsigned scalar return type.

Typed target builtins retain splat, extraction and replacement operations until
RTL expansion, where they use the existing Wasm vector optabs. Byte and
halfword extraction selects an explicit signed or unsigned i32 extension.
This prevents ordinary C vector expressions from becoming memory updates at
O0 or shuffles at O2 when the public operation requires a direct instruction.
The builtins are implementation details of this header subset.

The patch also legalizes aligned scalar views of a native v128 register during
partial copies. A real vector temporary with matching lane size preserves the
other bytes while extracting or replacing a lane. The rule covers the six
existing 128-bit vector modes and excludes half vectors, TI and TF containers.

Loads and stores use a vector access type with alignment one and `may_alias`;
callers may pass an unaligned address. Integer add/subtract/multiply/negate use
unsigned vector arithmetic for defined wraparound. Shift counts are masked to
the lane width, while signed right shift preserves sign extension. Float
comparisons retain the normal NaN and signed-zero behavior.

Saturation calls the real GCC target builtins introduced by patch `0013`.
Conversions use patch `0015`'s canonical typed builtins and GCC conversion
optabs. Unsigned narrow operations consume signed wider lanes. The unsigned
f32 saturation builtin returns a signed vector carrying the unsigned result
bits. Half-vector conversions use local full-width widen/pack expressions;
there is no additional public 64-bit or 256-bit vector ABI. Float64 truncation
and demotion zero their unused high lanes.

The subset excludes relaxed SIMD, float16, runtime swizzle, min/max/abs/sqrt
and rounding APIs, dot/extended multiplication/reductions, extra memory
operations, historical aliases and constant-only constructor variants.

## Qualification contract

The current fixture contract has 676 enabled programs: each of the 169 API
names in C and C++, at both `-O0` and `-O2`. Four scalar controls run with SIMD
disabled. The native harness additionally runs those four controls without a
SIMD flag, for 684 GCC executions. The 680 canonical positive/control fixtures
also compile with pinned Clang and its original SDK header, producing an
independent Node WASI reference for the same expected outputs.

The 296 diagnostic cases include every immediate macro with nonconstant,
negative and past-end indices in all four language/optimization profiles,
plus default and explicit disabled feature diagnostics. Programs exercise
operand single evaluation, unaligned and aliased memory, lane order, integer
wrapping, scalar shift masks, NaNs, signed zeros and saturation/conversion
boundaries. Each live operation has an address-taken `convert` function so
opcode inspection examines the actual operation body.

The gate requires complete API coverage and current source, compiler, tool,
header and runtime identities. It reopens the source, WAT, objects and linked
programs, checks real decoded instructions in `convert`, compares both
compiler executions with the fixture oracle, and verifies the installed
header equals the target source header. A JSON success marker alone is
insufficient. All previous runtime, ABI and SIMD package gates still apply.

Final distribution qualification must use the same-source Wasm-host GCC in an
actual Chromium Worker and execute its outputs independently in Node WASI.
It records a real positive SDK SIMD engine probe. The existing SDK test's
forced-negative `WebAssembly.validate` path is labelled as a mocked negative,
not evidence of an actual browser without SIMD support.

## License and installation

The new independent header is attributed to wasm-llvm contributors and uses
`GPL-3.0-or-later WITH GCC-exception-3.1`, including the full GCC header notice.
The compiler distribution retains the complete `COPYING3` and
`COPYING.RUNTIME` files. Existing GCC source copyright notices remain intact.
The API/type/semantic reference is LLVM commit
`4434dabb69916856b824f68a64b029c67175e532`, whose original header is
`Apache-2.0 WITH LLVM-exception`; LLVM-only attributes and source are not
transplanted into the GCC implementation.

The target `extra_headers` declaration installs the file into the native GCC
include directory. The existing browser build copies that directory into its
resource headers; packaging places those exact bytes into the sysroot tar.
The package gate checks byte equality at each boundary and retains the full
license notices.

## Status

The [qualification record](../../docs/gcc-wasi-simd-header-20261030.json)
binds the final sixteen-patch source and freshly rebuilt GNU runtime. The
complete matrix passed 3,546 executions: 2,071 inherited regression executions,
684 GCC header executions, 680 independent original-header Clang executions,
48 partial-copy executions split equally between GCC and Clang, 48 half-vector
ABI controls, 13 smoke programs and two GNU runtime programs. All 568 expected
compiler diagnostics passed, including the header's 296 diagnostics. The
package gate reopened all 1,364 header objects and 1,364 linked programs.
Focused fixture, instruction-inspector and package tests passed 58/58.

The same-source Wasm-host compiler and package passed actual Chromium Worker
qualification: 1,531 canonical programs plus four default-option controls each
executed in Chromium and independently in Node WASI. All 568 raw compiler
diagnostics passed. Reinspection checked 979 SIMD opcode cases, 382 ABI object
signatures and 4,145 saved artifact files. The source, native-installed,
browser-resource and sysroot-tar header bytes match, and the package retains
the complete GPL and Runtime Library Exception notices. The SDK's real
Chromium SIMD probe passed; its separate negative unit probe remains explicitly
mocked. These results and frozen input identities are recorded for
[PR #99](https://github.com/seo-rii/wasm-llvm/pull/99).

The preserved first full GCC attempt found 18 partial-copy internal compiler
errors and 50 direct-instruction mismatches. All 50 existing object files
produced the expected outputs in a separate execution check. The final native
compiler passes the unchanged public-header fixtures after adding typed lane
operations and scalar/vector copy legalization. An independent 24-source
C/C++ O0/O2 vector-copy suite checks both ends and preservation of nonzero
surrounding bytes. Its original compiler failed eight cases; the final compiler
and pinned Clang each pass all 24. Earlier attempts and preliminary lane-only
runs are preserved and excluded from final execution totals.
