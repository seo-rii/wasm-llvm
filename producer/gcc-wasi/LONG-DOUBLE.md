# GCC binary128 long double

Patch `0008-binary128-long-double.patch` implements IEEE binary128 `long double`
in the separate GCC 17 WebAssembly output compiler. It follows patches
`0001`–`0007`; exact source and patch identities are in
[sources.lock.json](sources.lock.json).
This document describes the implementation and required qualification. Completed
run results, failures, browser status and asset sizes are recorded separately in
[the binary128 validation report](../../docs/gcc-wasi-long-double.md). The commands
and matrix counts below are not a declaration that a bundle has passed.

The original port used binary64 `long double`, while WASI SDK 33's libc uses
binary128. The new output type has 16-byte size and alignment, 113-bit precision
and `LDBL_MAX_EXP == 16384`. This is the generated program's ABI. Emscripten's
compiler-host ABI and the separate GCC 13.3/16.2 x86 output profiles are
independent.

## GCC lowering and ABI

GCC selects TFmode for C and C++ `long double`. Each TF pseudo uses two
little-endian i64 locals. Moves expand to word operations even at O0; scalar
binary128 does not require SIMD or use a `v128` local. GCC's generic argument
assembly also introduces internal TImode storage. The patch supports those
containers, whole-value bit copies and their DI or narrow integer word views.
This does not enable the public `__int128` type or integer arithmetic in TI mode.

Arithmetic, comparisons and numeric conversions use GCC's soft-float optabs and
the pinned WASI compiler-rt archive. The runtime helpers execute binary128
operations; the compiler does not narrow operands to host `double`. Comparison
helpers return i32. Negation, absolute value and copysign operate on the sign
bit, preserving signed zero and NaN payloads in the storage representation.

The Basic C ABI classification is shared by definitions, imports and indirect
calls:

| Value or use | WebAssembly convention |
| --- | --- |
| Named scalar `long double` | Two i64 parameters, low word then high word |
| Eligible singleton record, union or array wrapper | The same two-i64 argument convention |
| Scalar or singleton binary128 result | Hidden first i32 result pointer; no direct Wasm result |
| Overaligned, multifield, packed-offset or nontrivial C++ aggregate | Aggregate pointer convention; C++ invisible-reference rules still apply |
| Variadic binary128 value | Memory argument area with 16-byte alignment; `va_arg` and `va_copy` use the same layout |
| Named binary128 mixed with an enabled vector | Binary128 retains its i64 pair; the vector uses the separately qualified direct v128 convention |

Soft-float imports record their final lowered signatures, including an existing
hidden result pointer exactly once. Patch `0008` also changes
`gcc/optabs.cc:emit_libcall_block_1`: a CALL is not moved by the ordinary
pseudo-assignment hoist. In this port, scalar-result calls use pseudo registers
and their arguments are sibling RTL USE operands. The old transformation could
move a comparison helper before the partial-word stores that prepared its
arguments. Keeping the call in order corrects that dependency error without
changing the calling convention or rewriting source.

## Runtime and SDK contract

The runtime importer includes SDK 33's real `libc-printscan-long-double.a`.
[runtime.lock.json](runtime.lock.json) pins its bytes and SHA-256. It is linked
before libc to select long-double formatted I/O, including `%Lf` input and
`%Lf`/`%La` output. Other long-double libc/libm calls and soft-float helpers use
the pinned libc, libm and compiler-rt archives. `--fatal-warnings` rejects linker
signature warnings; execution tests remain necessary for layout and varargs.

GNU libstdc++ must be rebuilt with this exact patched GCC in a fresh
`GCC_LIBSTDCXX_WORK_DIR`. A runtime built for the earlier binary64 ABI cannot be
reused. The existing recipe builds real GNU headers, libstdc++ and libsupc++;
Clang's libc++ is used only for the independent Clang reference tests. Existing
single-thread, no-exceptions, no-RTTI settings and the explicit errno header
profile remain in effect.

For a compiler containing patch `0008`, the packager requires
`--long-double-qualification`, `--native-linker` and the qualified rebuilt
`--libstdcxx` runtime. It checks the complete native matrix, current compiler and
recipe identities, actual tool commands, headers, runtime archives, source
units, object files and linked programs. It reopens the programs and checks
their function types, memory and imports/exports. Missing or partial proof does
not produce a binary128-capable bundle.

The optional v2 manifest field `capabilities.longDouble` records this capability.
The SDK treats an omitted field as false and preserves the old link plan for
both omitted and explicit false values. True requires libc and libm and adds
the print/scan archive before libc. It is a bundle capability, not a
`compile({ longDouble: ... })` option. Loading the compiler still requires the
trusted manifest digest and verified asset hashes. The producer initially emits
`qualification.status: "unverified"`; native proof does not substitute for the
real browser compiler test.

## Reproduce the qualification

Use the pinned tools and environment in [README.md](README.md#reproduction).
Build the current native compiler and imported runtime, run the native gate and
build the Wasm-host compiler as documented there. Run long operations with
private logs and recorded exit status. Keep compiler sources, binaries, runtime
inputs and test recipes fixed until their consumers finish. Every qualification
output directory must be new.

From the wasm-llvm repository root, build a fresh GNU runtime and run the complete
native matrix:

```sh
export GCC_LIBSTDCXX_WORK_DIR="$GCC_WASI_WORK_DIR/libstdcxx-binary128"
bash producer/gcc-wasi/build-libstdcxx.sh
node producer/gcc-wasi/test-libstdcxx.mjs "$GCC_LIBSTDCXX_WORK_DIR/qualification"

node producer/gcc-wasi/test-long-double.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/long-double-qualification"
```

[The fixture module](long-double-fixtures.mjs) contains 42 cases: 21 profiles at
both O0 and O2. ABI cases run GCC/GCC, GCC/Clang, Clang/GCC and Clang/Clang
caller/provider combinations; other cases run the two same-compiler controls.
The complete native gate requires **124 runs**, not a filtered subset.
Two mixed vector profiles use `simd: true`; the other 40 cases use the scalar
profile. Every source receives real macro options, including `ONLINE_JUDGE=1`.
Sources are compiled without translation; Clang is an independent oracle and
interop partner, never a GCC fallback.

Coverage includes layout and precision beyond binary64; arithmetic and
conversions; NaNs, infinities, subnormals and signed zero; globals, stack, heap,
packed storage and copies; direct and indirect calls and callbacks; nested and
singleton aggregates; variadic argument mixtures and `va_copy`; long-double
libm, print/scan and `strtold`; multiple C/C++ units, initialization/destruction,
GNU `numeric_limits`, vector/accumulate, cmath and iostreams.

Package with the other current native qualifications from README:

```sh
node producer/gcc-wasi/package.mjs \
  --work "$GCC_WASI_WORK_DIR" --runtime "$GCC_WASI_WORK_DIR/runtime-c" \
  --simd-qualification "$GCC_WASI_WORK_DIR/simd-qualification/qualification.json" \
  --simd-extended-qualification "$GCC_WASI_WORK_DIR/simd-extended-qualification/qualification.json" \
  --vector-abi-qualification "$GCC_WASI_WORK_DIR/vector-abi-qualification/report.json" \
  --long-double-qualification "$GCC_WASI_WORK_DIR/long-double-qualification/report.json" \
  --native-linker "$WASI_SDK_PATH/bin/wasm-ld" \
  --libstdcxx "$GCC_LIBSTDCXX_WORK_DIR" --output out/gcc-wasi-bundle
```

Then, from the matching wasm-idle checkout:

```sh
pnpm --filter @wasm-idle/core build
pnpm --filter @wasm-idle/gcc build
node scripts/verify-gcc-wasi.mjs \
  --manifest /absolute/path/to/wasm-llvm/out/gcc-wasi-bundle/gcc-toolchain.v2.json \
  --suite /absolute/path/to/wasm-llvm/producer/gcc-wasi/long-double-fixtures.mjs \
  --save-intermediates --output out/gcc-wasi-long-double-browser
```

This sends **42 fixture programs** through the real Wasm-host GCC in Chromium
Workers, with all translation units compiled by GCC. Each resulting program runs
with its specified stdin and expected stdout in Chromium and independently in
Node WASI.
Mixed GCC/Clang object linking belongs to the separate native matrix; the SDK
does not accept external object files. Saved intermediates cover the main
translation unit, while the compilation report records every tool stage.

Recreate bundle and browser loading measurements for the final compiler and GNU
runtime. `loading-sizes.json` covers the manifest, all compiler/assembler/linker
payloads and the complete sysroot tar, including the print/scan archive. It
records raw, gzip level 9 and Brotli quality 6 sizes. The browser report also
measures actual initial requests and SDK Worker module bytes. Earlier bundle
sizes do not describe a new binary128 build.

## Boundaries and distribution

Public `__int128` is unsupported. `_Float128` and complex long-double arithmetic
have only small boundary probes and are outside this formal qualification
matrix. The matrix does not establish complete ISO C/C++ or C ABI conformance,
all math-library accuracy guarantees or every floating-point environment mode.
Exceptions, RTTI, threads/TLS/atomics, shared memory, dynamic linking and external
binary inputs retain their existing unsupported status. Binary128 alone does
not enable SIMD or x86 AVX2/FMA. GNU timezone databases, C++26 debugger functions
and prebuilt std modules retain their existing exclusions.

License and corresponding-source obligations are unchanged; see
[Distribution and provenance](README.md#distribution-and-provenance). Include
the exact GCC patch series, including the generic optabs change, and all linked
runtime/dependency sources and notices when distributing a compiler bundle.
