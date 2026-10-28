# GCC binary128 extension qualification

This qualifies the existing GCC C `_Float128` and GNU complex `long double`
paths alongside [scalar binary128](LONG-DOUBLE.md). It uses literal C/C++ source,
real GCC frontends and the GCC RTL WebAssembly backend. WABT assembles objects;
external LLVM `wasm-ld` links the pinned WASI runtime. Clang provides independent
reference objects in tests. Emscripten builds the compiler host.

The [fixtures](fp-extension-fixtures.mjs) contain 25 profiles at O0/O2:
**50 browser programs**. The full [native harness](fp-extension-native.mjs)
requires **124 runs**, comprising 56 `_Float128` and 68 complex cases.
Six ABI profiles run all four GCC/GCC, GCC/Clang, Clang/GCC and Clang/Clang
directions at both optimizations, giving 48 mixed/same-compiler ABI runs.
Completed compiler identities, results and browser measurements belong in the
[completion report](../../docs/gcc-wasi-completion-20261027.md).

## C `_Float128`

The matrix covers F128 literals, 16-byte size/alignment and 113-bit precision;
arithmetic, comparisons, conversions including int128, control flow;
quiet-NaN payload transport, signed zero, subnormal and exponent boundaries;
nearest-even tie cases and selected overflow/underflow boundaries;
global, stack, heap, packed and volatile storage and copying;
scalar/singleton/multifield arguments and results, callbacks and function
pointers; variadic arguments, `va_copy` and 16-byte caller-buffer alignment.

The explicit libc bridge converts to the actual binary128 `long double` type
before using `%Lf`, `strtold` or long-double libm. It does not pass `_Float128`
to a mismatched variadic format or claim f128-named libc interfaces.

Pinned WASI SDK 33 Clang 22.1.0 rejects the C `_Float128` spelling. Its reference
headers explicitly use its real binary128 `long double` and L literals. GCC
always receives a separate original subject header using `_Float128` and F128
literals. Subject/reference directories, models and hashes are recorded. No
GCC compilation failure is retried with Clang or transformed source. GNU
`__float128` is a separate, unsupported spelling in this profile.

## GNU complex `long double`

The matrix covers 32-byte size, 16-byte alignment and binary128 real/imaginary
component order; construction, arithmetic, conjugation, scaled multiplication
and division, equality, Boolean control flow and scalar conversions; quiet-NaN
payload components, signed zero and subnormal transport; packed/global/heap/
volatile storage and copying; direct, indirect and callback calls, aggregates,
complex varargs and `va_copy`; actual `cabsl`, `csqrtl`, `cexpl`, `clogl` and
`conjl`; GNU C++ templates, static lifetime, multiple units, `std::complex`,
`vector` and `accumulate` with the newly built GNU runtime.

This selected profile does not establish every transcendental error bound,
nonfinite complex branch-cut case, signaling-NaN exception flag, rounding mode
or complete ISO C/C++ conformance. These scalar types need no SIMD opt-in.

## Correct typed math feature detection

The original nine-patch baseline passed 123/124 runs. The unchanged O0 GNU C++
`std::abs(3+4i)` test returned `5 + 2^-53`, with bits
`4001400000000000:0200000000000000`, instead of exactly 5. ABI cases passed;
the defect was in GNU runtime feature detection.

Autoconf's generic `char function()` probes did not match real Wasm function
types. Strict linking rejected them even though the WASI implementation was
available. Missing feature macros selected `math_stubs_long_double.o`, whose
fallback `sqrtl` converted through double. Reversing library order was used
only as a diagnosis; production linking keeps its normal order.

[fp-extension-math-probe.py](fp-extension-math-probe.py) includes the actual
`math.h`/`stdlib.h` declarations and takes a live volatile function pointer.
It compiles through GCC to WAT, assembles a relocatable object and links with
`--fatal-warnings`. The measured matrix has 67 math/stdlib names, including
`at_quick_exit`, `quick_exit`, `strtof` and `strtold`. Undeclared legacy aliases
remain unavailable; all required replacements for reduced-precision math
stubs must link. Only measured answers enter `CONFIG_SITE`.

[build-libstdcxx.sh](build-libstdcxx.sh) verifies unchanged probe inputs and
artifacts before reuse and after the GNU build. Its receipt embeds all typed
probe evidence and source/tool/runtime/header identities. Packaging reopens
these artifacts, checks the cache against the actual results and rejects
missing required functions. A successful status string alone is insufficient.

## Reproduction

Use the exact source/tool/runtime pins and native-first build sequence in
[README.md](README.md#reproduction). Build and qualify a fresh GNU runtime with
the same compiler before running:

```sh
node producer/gcc-wasi/fp-extension-native.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/fp-extension-qualification"
```

Then build the matching Wasm-host GCC and a fresh complete bundle. From the
matching wasm-idle checkout run:

```sh
node scripts/verify-gcc-wasi.mjs \
  --manifest /absolute/path/to/new-bundle/gcc-toolchain.v2.json \
  --suite /absolute/path/to/wasm-llvm/producer/gcc-wasi/fp-extension-fixtures.mjs \
  --save-intermediates --output out/gcc-wasi-fp-extensions-browser
```

All 50 programs must compile through Wasm-host GCC and execute with exact input
and expected output in Chromium Workers and independently in Node WASI. Saved
WAT/object captures cover each main translation unit; compiler reports record
every requested source unit. Native interoperation with external Clang objects
is a separate test path, not a new SDK binary-input API or fallback compiler.
Existing manifest/SDK options remain compatible; no additional floating-type
request flag or claimed general conformance capability is introduced.
