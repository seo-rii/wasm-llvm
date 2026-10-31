# C++ runtime type information

Issue [#67](https://github.com/seo-rii/wasm-llvm/issues/67) adds optional RTTI to
the experimental GCC 17 Wasm target. The implementation uses GCC's C++ frontend,
its emitted typeinfo/vtables, and a freshly built GNU `libsupc++`/`libstdc++`.
Exception handling remains disabled. Current validation state and exact source
identities are recorded in [the evidence receipt](../../docs/gcc-wasi-rtti-20261030.json).

The SDK keeps `-fno-rtti` as its default. An RTTI request requires a bundle that
advertises the qualified `rtti` capability and uses `-frtti`. A native frontend
test labelled `default` means that the RTTI flag was omitted from a direct GCC
or Clang invocation; it does not describe the SDK default. Existing bundles
without RTTI support and the separate x86 target keep their existing behavior.

## Compiler and runtime changes

Patch `0019-rtti-one-only.patch` emits public C++ vague-linkage data definitions
with Wasm weak binding. GCC creates typeinfo objects and names before assigning
their initializers. Its generic `make_decl_one_only` fallback selects
`DECL_COMMON` at that point, and later clears that flag for initialized data.
The existing backend therefore emitted strong `_ZTI*` and `_ZTS*` symbols, so
multiple translation units containing an inline polymorphic class failed to
link. The patch uses the remaining `DECL_COMDAT` marker on defined data and
lets the strict Wasm linker coalesce the copies.

The compiler keeps its existing function and alias behavior. It does not
advertise generic COMDAT group support: that would also cause the C++ frontend
to emit unsupported weak ABI compatibility aliases in ordinary STL code.
Ordinary C tentative definitions have no `DECL_COMDAT` marker and retain their
existing strong Wasm binding, including duplicate-definition rejection under
both `-fcommon` and `-fno-common`.

The GNU runtime is rebuilt with `-frtti -fno-exceptions`. Its WASI-specific
`configure.host` case adds only `-fno-exceptions`; adding `-frtti` to CXXFLAGS
alone would be insufficient if `EXTRA_CXX_FLAGS` still contained `-fno-rtti`.
The build checks both actual generated Makefile variables and records them.
Build and qualification receipts must agree on `rtti: true`, `exceptions: false`,
the compiler/source hashes, and the archive bytes. Two existing `-fno-rtti`
GNU programs, one native frontend flag-omission program, and two explicit
`-frtti` GNU programs are executed before the runtime is packaged. The second
enabled program prints through `std::ostringstream` and `std::cout`, exercising
the RTTI-enabled streambuf dispatch and ordinary output path.

Enabling RTTI also exposes the GNU `std::print` native-filebuf terminal helper.
WASI Preview 1 has file descriptors and `unistd.h`, but its header intentionally
omits `dup`. The runtime port excludes only that native-filebuf duplication
branch on WASI; the existing FILE*/stdio streambuf dispatch and ordinary print
path remain available. This does not claim support for duplicating native
terminal handles or add a replacement `dup` implementation.

## Qualification contract

The portable matrix is defined in [rtti-fixtures.mjs](rtti-fixtures.mjs).
The 74 real GCC/Clang objects cover `-O0`/`-O2`, separate provider/consumer
translation units, and the following boundaries:

| Coverage | Contract |
| --- | --- |
| Single inheritance | Successful and failed pointer casts, null pointer casts, dynamic `typeid`, and `void*` casts |
| Multiple inheritance | Cross-casts, pointer adjustment, and complete-object addresses |
| Virtual inheritance | Shared virtual base identity and sibling cross-casts |
| Inline/no-key classes | Three TUs, weak typeinfo/name definitions, and equal typeinfo addresses |
| GNU standard base | User classes derived from `std::exception` with the current GNU runtime |
| Frontend profiles | Explicit enabled, explicit disabled, and native flag omission |
| C controls | Existing ordinary tentative-definition binding and duplicate rejection |

The native qualification passed all 96 independent link cases: 88 actual WASI
executions and eight strict-link rejections. Each successful case records one
stdin/stdout pair. The hierarchy cases use two runtime-selected inputs for every
supported provider/consumer compiler pairing. Object inspection reopens actual
Wasm linking-v2 symbols and relocations, checks typeinfo/name binding and
visibility, and verifies the four-i32-to-i32 `__dynamic_cast` ABI. A distinct
eight-case frontend diagnostic matrix requires RTTI expressions to fail with
`-fno-rtti`. All 1,750 frozen inputs and artifacts were verified unchanged.

Eight exception-dependent boundary objects are compiled and strictly linked,
but never executed or counted as successful runtime cases. Failed reference
casts depend on `__cxa_bad_cast`; `typeid` on a null polymorphic pointer depends
on `__cxa_bad_typeid`. Their ABI is inspected, while exceptions remain outside
the supported no-exceptions profile.

Four of the strict-link rejections preserve an existing mixed C++ ABI boundary:
Clang references `std::exception`'s D2 destructor as `(i32) -> i32`, while the
GNU archive built by this GCC backend defines `(i32) -> void`. These Clang
provider combinations must fail with `--fatal-warnings`. The remaining four
reject duplicate ordinary C definitions. Successful mixed-object cases qualify
only their tested interfaces; they do not establish general GCC/Clang C++ ABI
compatibility.

## Reproduction

Use a new work directory, the pinned SDK, and a fresh GNU runtime for source19.
All source preparation and build inputs must remain unchanged until the
qualification completes. On a small root filesystem, put the work directory
and `TMPDIR` on a volume with sufficient space.

```sh
export GCC_WASI_WORK_DIR=/absolute/path/to/new-gcc-wasi-work
export WASI_SDK_PATH=/absolute/path/to/wasi-sdk-33.0-x86_64-linux
export GCC_LIBSTDCXX_WORK_DIR="$GCC_WASI_WORK_DIR/libstdcxx-current"
export GCC_WASI_JOBS=2 GCC_WASI_WABT_JOBS=2

bash producer/gcc-wasi/build-native.sh
bash producer/gcc-wasi/build-wabt.sh native
# Prepare the locked libc/CRT sysroot with prepare-runtime.py as in README.md.
bash producer/gcc-wasi/build-libstdcxx.sh
node producer/gcc-wasi/test-libstdcxx.mjs "$GCC_LIBSTDCXX_WORK_DIR/qualification"
node producer/gcc-wasi/test-rtti.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/rtti-qualification"
```

Package source19 with `--rtti-qualification .../qualification.json` alongside
the existing native qualifications. The package gate binds the exact source
matrix, compiler/assembler/linker identities, header trees, GNU archives,
ordered link inputs, real object metadata, and executed output bytes. Browser
compiler and actual Worker execution are separate qualification stages.

## Preserved baseline

The source18 baseline compiled 44 positive objects and linked 28 of 40 programs;
all 56 attempted WASI executions passed. The twelve link failures separated
duplicate typeinfo symbols, the old GNU runtime's missing `std::exception`
typeinfo, and the existing Clang destructor ABI disagreement. All 20 independent
host-GCC executions passed. The first baseline attempt completed its program
matrix but failed final source verification because `/tmp` ran out of space.
That attempt is preserved; the second reran the whole matrix with `TMPDIR` on
the data volume and verified all 1,551 frozen inputs unchanged.

The production object inspector was also applied to these preserved source18
objects. It rejects the fourteen old GCC typeinfo definitions with strong
binding while accepting the other 38 baseline objects, including the separate
exception boundaries. Optimizable uses such as a constant `typeid` inequality
do not require a relocation after the compiler has folded the expression.
