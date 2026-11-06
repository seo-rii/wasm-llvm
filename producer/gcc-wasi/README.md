# GCC WebAssembly output producer

This is a separate experimental GCC 17 compiler for **Wasm output**. The x86
producer in `../gcc-browser` uses GCC 16.2 after a separate main-branch update;
the matching SDK also retains compatibility with existing GCC 13.3 x86 bundles.
The Wasm backend does not replace either x86 output profile. Both compiler hosts
can run as Emscripten Wasm, but their generated program targets are different.

The complete source path is real GCC `cc1`/`cc1plus` → GCC RTL WebAssembly backend
→ annotated WAT → the pinned WABT assembler → relocatable Wasm object → external
LLVM `wasm-ld` + WASI CRT/libc/libm/runtime → WASI Preview 1 execution. Emscripten
builds the compiler host; Clang never compiles user source in this path.

See [the upstream and ABI assessment](../../docs/gcc-wasi-research.md),
[initial native and Chromium results](../../docs/gcc-wasi-validation.md),
[backend review and SIMD qualification](../../docs/gcc-wasi-backend-review.md),
[additional SIMD operations and vector ABI](../../docs/gcc-wasi-simd-extension.md),
[SIMD saturating arithmetic](SIMD-SATURATING.md),
[SIMD conversions](SIMD-CONVERSIONS.md),
[explicit relaxed SIMD](RELAXED-SIMD.md),
[native atomics, GNU libatomic and shared entries](ATOMICS.md),
[lane-wise vector shifts and their scalar fallback](SIMD-LANE-SHIFTS.md),
[SIMD intrinsic header](SIMD-HEADER.md),
[strong function and data aliases](SYMBOL-ALIASES.md),
[weak references and weak definitions](WEAK-REFERENCES.md),
[optional C++ RTTI](RTTI.md),
[optional GCC gcov coverage](COVERAGE.md),
[embedded DWARF4 debug information](DWARF.md)
([measured qualification](../../docs/gcc-wasi-dwarf-20261103.md)),
[binary128 implementation and reproduction](LONG-DOUBLE.md),
[binary128 qualification results](../../docs/gcc-wasi-long-double.md),
[public int128 implementation and reproduction](INT128.md),
[GNU float128 type, ABI and runtime contract](GNU-FLOAT128.md),
[int128 qualification results](../../docs/gcc-wasi-int128.md),
[empty record ABI repair](EMPTY-ABI.md),
[floating extension qualification](FP-EXTENSIONS.md),
[wide builtin/bitfield qualification](WIDE-INTEGER.md),
[anonymous bitfield ABI qualification](ANONYMOUS-BITFIELD-ABI.md),
[current completion results](../../docs/gcc-wasi-completion-20261027.md),
[source pins](sources.lock.json), and [runtime pins](runtime.lock.json).
The June 2026 GCC announcement approved a development direction; this backend is
an unmerged author port, not a released upstream GCC target. Keeping its GCC 17
core changes separate avoids an invasive backport into the x86 compiler and
preserves its existing intrinsic, pragma, libm and GNU C++ behavior.

## Pinned inputs

| Component | Version / source |
| --- | --- |
| GCC compiler and libstdc++ | Experimental `17.0.0`, Sourceware `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| GCC backend implementation | `8f90eb001a5b25ef1e6285c8dc9f9bc13e1a8acd`, based on GCC `33ac889aa27d9917e6e7d07c282015b7c48e0440` |
| Local GCC patches | `0001`–`0026`: void returns, host widths, SIMD128, Basic C ABI, atomic libcalls, SIMD operations, vector ABI, binary128, public int128, empty C++ records, declared/anonymous bitfield ABI, saturating SIMD arithmetic, GNU float128, SIMD conversions, the 169-name intrinsic header, strong aliases, weak references, one-only RTTI binding, single-counter coverage, embedded DWARF4, explicit relaxed SIMD, native atomics, the GNU libatomic target port, native TLS and GNU TLS cleanup; SHA-256 pinned in `sources.lock.json` |
| Annotated-WAT assembler | WABT fork `1.0.37`, `651c9ffbce3d0525d2d1324fab79160e5fcf8173`, five locked [SIMD target feature](TARGET-FEATURES.md), [symbol alias](SYMBOL-ALIASES.md), [DWARF transport](DWARF.md), [atomic/bulk-memory feature](ATOMICS.md) and [TLS metadata/alias](#tls-profile-and-reproduction) patches; PicoSHA2 `27fcf6979298949e8a462e16d09a0351c18fcaf2` |
| Native linker / compiler builtins | WASI SDK 33, LLVM `22.1.0`, `4434dabb69916856b824f68a64b029c67175e532` |
| WASI libc / libm / CRT | `161b3195fc2558d2b1ba3eb9ffae3b2b47407623` from the SHA-pinned SDK 33 archive |
| Browser linker | Existing wasm-llvm WASI-host LLD `22.1.8`, `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1`; archive and original producer receipt pinned |
| Compiler host | Emscripten `6.0.0`, `afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3`; emsdk `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` |
| Host arithmetic libraries | GMP 6.3.0, MPFR 4.2.1, MPC 1.3.1; authenticated GNU source archives from `../gcc-browser/sources.lock.json` |

The linker archive and its original toolchain receipt are preserved under
`snapshots/`. `runtime.lock.json` pins those files so rebuilding the current
Clang artifacts does not change this GCC profile's qualified linker inputs.
After updating the runtime lock, rerun `prepare-runtime.py` into a new output
directory before packaging so the import receipt records the current lock hash.

The first local GCC patch fixes a real code-generation defect: pointer comparison
with `void_type_node` misclassified `typedef void` and emitted an undeclared `$return`
local. Both return emission and indirect function signatures use `VOID_TYPE_P`.
The native `-O0` and `-O2` probes fail before the patch and execute after it.
No user-source rewriting is performed. `prepare-source.py` checks the entire
tracked source diff against precisely the locked patches using a temporary Git
index; unrelated source changes are rejected.

The second patch fixes five printf argument-width mismatches in the backend.
On a 32-bit Wasm compiler host, the draft port passed `size_t` to a 64-bit
format and used native `long` formats for GCC's wide integers. This corrupted
constant labels (including duplicate `LC0`) and could truncate i64 constants,
sizes or relocation addends. Real browser compilation exposed the wrong
string output; the patch uses GCC's host-width format macros and types. The
suite includes multiple literals and signed/unsigned values above 32 bits.

The subsequent patches add [optional SIMD128 code generation](SIMD.md), fix
singleton/empty aggregate and narrow integer calling conventions, and correct
the external compare-exchange libcall signature. The ABI suite links real GCC
and Clang caller/callee objects in both directions. Clang is an independent test
oracle here, not a compilation fallback. The atomic test provider validates the
five-argument ABI only; it is not distributed as an atomic runtime.
Patches `0006` and `0007` add [SIMD operations](SIMD-EXTENDED.md) and
[direct vector calls](VECTOR-ABI.md), with native mixed-compiler qualification
and a separate Wasm-host GCC Worker qualification.
Patch `0008` adds [binary128 `long double`](LONG-DOUBLE.md), including GCC TFmode,
two-word storage, the WASI argument/result convention and soft-float helpers.
It also fixes a generic `gcc/optabs.cc` transformation that moved a pseudo-result
library call before its argument setup. This changes the output ABI; GNU
libstdc++ must be rebuilt with the patched compiler. The binary128 document
defines the qualification matrix; completed results and loading sizes belong
in the separate validation report linked above.
Patch `0009` adds [public signed/unsigned int128](INT128.md), reusing TI pair
storage with the WASI two-i64 argument/indirect-result ABI and generic integer
optabs. It adds the scalar complement word optab and i32 runtime shift counts.
Native execution also exposed a host-buffer overread while emitting 16-byte
`CONST_INT` initializers; the serializer now emits explicit bounded zero/sign
extension. The int128 document defines the full 42-program/116-run matrix.
Patch `0010` repairs [empty C++ record ABI](EMPTY-ABI.md), including generic GCC
O0 parameter setup. Patch `0011` preserves named bitfields' declared storage
alignment and uses their original storage type for singleton call classification.
The [bitfield matrix](WIDE-INTEGER.md) includes packed and ordinary mixed-compiler
controls; [additional singleton regressions](singleton-bitfield-fixtures.mjs)
cover narrow short/long-long and packed int/long-long fields.
Patch `0012` fixes [anonymous bitfield singleton classification](ANONYMOUS-BITFIELD-ABI.md)
without changing storage layout and preserves nonzero storage modes of ABI-empty
records while omitting their unused hard return locals.

## Reproduction

Use Linux x86-64, Python 3.11+, Node 22.18+ or 24.10+, GNU make, GCC/G++, git, bison, flex,
cmake, curl, patch, tar, xz, and native GMP/MPFR/MPC development packages. Install
the exact SDK and emsdk revisions above. Build paths must not contain whitespace.
`out/` is local, ignored build/evidence storage. A separate wasm-idle checkout
with the matching GCC API changes provides the browser qualification harness.
Use the same Node executable for the native qualifications and packaging:
the binary128 and int128 gates bind the executed Node binary as well as
compiler and runtime inputs. Exact versions used by a completed run belong in its report.

```sh
export GCC_WASI_WORK_DIR="$PWD/out/gcc-wasi-work"
export WASI_SDK_PATH=/absolute/path/to/wasi-sdk-33.0-x86_64-linux
export EMSDK_PATH=/absolute/path/to/emsdk-6.0.0
export GCC_WASI_EMSDK="$EMSDK_PATH"
export GCC_WASI_JOBS=4
export GCC_WASI_WABT_JOBS=2
export GCC_WASI_PLAYWRIGHT_PROJECT=/absolute/path/to/wasm-idle

bash producer/gcc-wasi/build-wabt.sh all
bash producer/gcc-wasi/build-native.sh
python3 producer/gcc-wasi/prepare-runtime.py \
  --sdk-archive /absolute/path/to/wasi-sdk-33.0-x86_64-linux.tar.gz \
  --output "$GCC_WASI_WORK_DIR/runtime-c"
node producer/gcc-wasi/qualify-native.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --suite "$GCC_WASI_PLAYWRIGHT_PROJECT/scripts/gcc-wasi-fixtures.mjs" \
  --cases c-hello,c-core,c-libm,c-wide-integers-o0,c-wide-integers-o2,c-errno,c-multiple,c-defines,c-wasm32-abi,cpp-core,cpp-static-lifecycle,cpp-typedef-void-o0,cpp-typedef-void-o2 \
  --output "$GCC_WASI_WORK_DIR/native-programs"
node producer/gcc-wasi/abi-interop.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/abi-qualification"
node producer/gcc-wasi/test-atomic-libcall.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/atomic-abi-qualification"
node producer/gcc-wasi/test-simd.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-qualification"
node producer/gcc-wasi/test-simd-extended.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" --oracle clang \
  --output "$GCC_WASI_WORK_DIR/simd-extended-qualification"
node producer/gcc-wasi/test-simd-saturating.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-saturating-qualification"
node producer/gcc-wasi/test-simd-conversions.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-conversions-qualification"
node producer/gcc-wasi/test-simd-header.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-header-qualification"
node producer/gcc-wasi/test-simd-relaxed.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-relaxed-qualification"
python3 producer/gcc-wasi/test-simd-relaxed-driver.py \
  --work "$GCC_WASI_WORK_DIR" --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-relaxed-driver-qualification"
node producer/gcc-wasi/test-vector-abi.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/vector-abi-qualification"

bash producer/gcc-wasi/build-host-deps.sh
bash producer/gcc-wasi/build-browser.sh
```

Run lengthy commands in the background with a private log from the start and an
exit-status file. Keep sources, recipes and native compiler binaries stable
until dependent builds finish. Check process/status files while running; inspect
bounded log excerpts after exit. A completed native compile/link/run receipt is
mandatory before `build-browser.sh` starts. Its source/patch identity must match.
`qualify-native.mjs` preserves an existing `native-qualification.json` so it
cannot replace a gate while another build consumes it. When reusing a work
directory after rebuilding GCC, first finish all consumers of the old gate and
archive it. Replace it with the new successful `provenance.json` only after
checking that its `gccSource` and `buildReceiptSha256` match the new native build.
A fresh work directory needs no gate replacement.

The native driver in the draft port injects unsupported `-stdlib=libc++`; the
recipe clears that driver spec for the real frontend self-tests. The browser
SDK invokes the real frontend directly with explicit includes and libraries.
The browser host is the explicit `browser-frontends` profile. GCC's supported
`--disable-gcov` configure option excludes `gcov`, `gcov-dump` and `gcov-tool`;
filesystem traversal for these host utilities is not provided. The normal
`all-gcc` preparation must exit zero before either real `cc1`/`cc1plus` module
is separately linked. Failure aborts packaging, and both the profile and actual
bootstrap result are bound into the compiler receipt. Existing build directories
configured with gcov enabled are rejected. The matching native build supplies
the official gcov analysis utilities for the separate target coverage profile.
The recipe canonicalizes Emscripten cache/ports paths before configuration:
Emscripten's cold-cache library builder can resolve generated relative source
paths incorrectly when the cache directory is a symlink. Function/type detection
must run successfully against real headers; its answers are not overridden.

For actual GNU C++ runtime support, use the isolated runtime recipe. Its typed
math/stdlib probes bind live function addresses to real declarations and strict
Wasm linking, preventing reduced-precision fallback stubs from replacing
available long-double libm functions; see [the math repair](FP-EXTENSIONS.md).
It copies the pinned runtime source and adds a WASI configure case with real
feature probes. Patch `0017` supports the original `std::type_info::__equal`
alias, so the former forwarding-function substitution has been removed. The
compiler source remains untouched. This is GNU libstdc++, not libc++ or a shim.
Patch `0019` fixes vague-linkage typeinfo/name coalescing. The runtime now
builds with `-frtti -fno-exceptions` and verifies both generated CXXFLAGS and
EXTRA_CXX_FLAGS. Its native qualification executes two existing RTTI-disabled
programs, one native frontend flag-omission program and two explicitly enabled
programs, including C++23 streambuf printing; the SDK default remains
`-fno-rtti`. See [RTTI.md](RTTI.md).
The WASI `errno` header also has an explicit GCC single-thread profile patch:
`__GCC_WASI_SINGLE_THREAD__=1` selects the existing libc's ordinary linear-memory
storage. Real C and C++ overflow tests confirm that libc and GCC use the same
`errno`; missing profile markers and `_REENTRANT` are rejected. This remains the
default profile and does not use TLS. The separate [TLS profile](#tls-profile-and-reproduction)
installs its own opt-in header and runtime providers. The imported default archive
bytes and patched header identities are recorded in `runtime-build.json`.

```sh
# Select a new directory for the current compiler; preserve old runtimes.
export GCC_LIBSTDCXX_WORK_DIR="$GCC_WASI_WORK_DIR/libstdcxx-current"
bash producer/gcc-wasi/build-libstdcxx.sh
node producer/gcc-wasi/test-libstdcxx.mjs "$GCC_LIBSTDCXX_WORK_DIR/qualification"

node producer/gcc-wasi/test-long-double.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/long-double-qualification"
node producer/gcc-wasi/test-int128.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/int128-qualification"

node producer/gcc-wasi/test-empty-abi.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/empty-abi-qualification"
for suite in builtins bitfields; do
  node producer/gcc-wasi/wide-integer-test.mjs \
    --suite "producer/gcc-wasi/wide-integer-$suite-fixtures.mjs" \
    --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
    --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
    --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
    --output "$GCC_WASI_WORK_DIR/wide-$suite-qualification"
done
node producer/gcc-wasi/wide-integer-test.mjs \
  --suite producer/gcc-wasi/singleton-bitfield-fixtures.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/singleton-bitfield-qualification"
node producer/gcc-wasi/wide-integer-test.mjs \
  --suite producer/gcc-wasi/anonymous-bitfield-fixtures.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/anonymous-bitfield-qualification"
node producer/gcc-wasi/wide-integer-test.mjs \
  --suite producer/gcc-wasi/gnu-float128-fixtures.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/gnu-float128-qualification"
node producer/gcc-wasi/fp-extension-native.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/fp-extension-qualification"

node producer/gcc-wasi/test-symbol-alias.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/symbol-alias-qualification"

node producer/gcc-wasi/test-weakrefs.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/weakref-qualification"

node producer/gcc-wasi/test-rtti.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/rtti-qualification"

export GCC_LIBGCOV_WORK_DIR="$GCC_WASI_WORK_DIR/libgcov-current"
export GCC_WASI_SYSROOT="$GCC_WASI_WORK_DIR/runtime-c/sysroot"
bash producer/gcc-wasi/build-libgcov.sh
node producer/gcc-wasi/test-coverage.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_SYSROOT" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --libgcov "$GCC_LIBGCOV_WORK_DIR" \
  --native-gcov "$GCC_WASI_WORK_DIR/gcc-native/gcc/gcov" \
  --output "$GCC_WASI_WORK_DIR/coverage-qualification"

# First build/reopen GNU libatomic and seal the native atomics proof as described
# in ATOMICS.md. These variables identify those independently qualified outputs.
export GCC_LIBATOMIC_WORK_DIR="$GCC_WASI_WORK_DIR/libatomic-current"
export GCC_ATOMICS_QUALIFICATION="$GCC_WASI_WORK_DIR/atomics-qualification.json"
# Also complete the TLS reproduction below before packaging source26.
export GCC_TLS_LIBC_DIR="$GCC_WASI_WORK_DIR/tls-libc-current"
export GCC_TLS_RUNTIME_DIR="$GCC_WASI_WORK_DIR/tls-runtime-current"
export GCC_TLS_QUALIFICATION="$GCC_WASI_WORK_DIR/tls-qualification.json"
export GCC_TLS_RUNTIME_QUALIFICATION="$GCC_WASI_WORK_DIR/tls-runtime-qualification/qualification.json"
node producer/gcc-wasi/package.mjs \
  --work "$GCC_WASI_WORK_DIR" --runtime "$GCC_WASI_WORK_DIR/runtime-c" \
  --simd-qualification "$GCC_WASI_WORK_DIR/simd-qualification/qualification.json" \
  --simd-extended-qualification "$GCC_WASI_WORK_DIR/simd-extended-qualification/qualification.json" \
  --simd-saturating-qualification "$GCC_WASI_WORK_DIR/simd-saturating-qualification/qualification.json" \
  --simd-conversions-qualification "$GCC_WASI_WORK_DIR/simd-conversions-qualification/qualification.json" \
  --simd-header-qualification "$GCC_WASI_WORK_DIR/simd-header-qualification/qualification.json" \
  --simd-relaxed-qualification "$GCC_WASI_WORK_DIR/simd-relaxed-qualification/qualification.json" \
  --simd-relaxed-driver-qualification "$GCC_WASI_WORK_DIR/simd-relaxed-driver-qualification/qualification.json" \
  --vector-abi-qualification "$GCC_WASI_WORK_DIR/vector-abi-qualification/report.json" \
  --long-double-qualification "$GCC_WASI_WORK_DIR/long-double-qualification/report.json" \
  --int128-qualification "$GCC_WASI_WORK_DIR/int128-qualification/report.json" \
  --gnu-float128-qualification "$GCC_WASI_WORK_DIR/gnu-float128-qualification/report.json" \
  --empty-abi-qualification "$GCC_WASI_WORK_DIR/empty-abi-qualification/report.json" \
  --bitfield-qualification "$GCC_WASI_WORK_DIR/wide-bitfields-qualification/report.json" \
  --anonymous-bitfield-qualification "$GCC_WASI_WORK_DIR/anonymous-bitfield-qualification/report.json" \
  --symbol-alias-qualification "$GCC_WASI_WORK_DIR/symbol-alias-qualification/qualification.json" \
  --weakref-qualification "$GCC_WASI_WORK_DIR/weakref-qualification/qualification.json" \
  --rtti-qualification "$GCC_WASI_WORK_DIR/rtti-qualification/qualification.json" \
  --coverage-qualification "$GCC_WASI_WORK_DIR/coverage-qualification/qualification.json" \
  --dwarf-qualification "$GCC_WASI_WORK_DIR/dwarf-qualification/qualification.json" \
  --libgcov "$GCC_LIBGCOV_WORK_DIR" \
  --libatomic "$GCC_LIBATOMIC_WORK_DIR" \
  --libatomic-qualification "$GCC_WASI_WORK_DIR/libatomic-qualification/qualification.json" \
  --atomics-qualification "$GCC_ATOMICS_QUALIFICATION" \
  --tls-runtime "$GCC_TLS_RUNTIME_DIR" --tls-libc "$GCC_TLS_LIBC_DIR" \
  --tls-qualification "$GCC_TLS_QUALIFICATION" \
  --tls-runtime-qualification "$GCC_TLS_RUNTIME_QUALIFICATION" \
  --native-gcov "$GCC_WASI_WORK_DIR/gcc-native/gcc/gcov" \
  --native-linker "$WASI_SDK_PATH/bin/wasm-ld" \
  --libstdcxx "$GCC_LIBSTDCXX_WORK_DIR" --output out/gcc-wasi-bundle
```

For the current twenty-six-patch compiler, `--long-double-qualification`,
`--int128-qualification`, `--gnu-float128-qualification`, `--empty-abi-qualification`,
`--bitfield-qualification`, `--anonymous-bitfield-qualification`, `--symbol-alias-qualification`,
`--weakref-qualification`, `--rtti-qualification`, `--coverage-qualification`, `--dwarf-qualification`,
`--libgcov`, `--native-gcov`, `--simd-relaxed-qualification`,
`--simd-relaxed-driver-qualification`, `--libatomic`, `--libatomic-qualification`,
`--atomics-qualification`, `--tls-runtime`, `--tls-libc`, `--tls-qualification`,
`--tls-runtime-qualification`, all five baseline SIMD
qualifications, `--vector-abi-qualification`, the native linker and a freshly rebuilt, qualified
`--libstdcxx` runtime are required. The wide-scalar matrices include GNU library
interfaces, so a C-only proof cannot satisfy their complete gates. GNU float128
requires all 36 C/C++ O0/O2 sources and 78 native runs, including mixed-compiler
ABI checks and GNU header tests. Six explicitly GNU-specific references cannot
run with the pinned Clang frontend/library and are recorded as inapplicable.
Earlier
compiler profiles can omit `--libstdcxx` and advertise `libstdcxx: false` with core C++ language support. Every supplied GNU
runtime must have a successful real native qualification receipt.
The coverage gate reopens the two official runtime objects and their archive,
all 36 translation units, 28 cases, 32 executions, eight metadata controls and
120 unsupported-option diagnostics. It checks raw notes/profile identities and
official gcov JSON counts, including the previous profile bytes consumed by
each merge run. Matching analysis-tool versions and hashes are retained in
bundle provenance. See [the coverage contract](COVERAGE.md).
The embedded DWARF gate also requires full same-source native GCC/WABT/GNU
runtime qualification, actual LLVM source/type/location consumers and retained
Chromium paused-frame values. Partial examples cannot satisfy it. See
[the debug contract and reproduction command](DWARF.md).
Packaging verifies input inventories, source identities, the native gate and
module formats. It writes a fresh output directory and the final v2 manifest
last. It always emits `qualification.status:
"unverified"`; artifact integrity is not compiler qualification.
The `--simd-qualification` must contain all enabled and disabled native
cases from the exact compiler binary and current test inputs. It enables the
manifest's SIMD capability; that provisional bundle still needs real Chromium
qualification. Earlier compiler profiles can omit it to keep SIMD unavailable
through the SDK; patch `0013` requires the SIMD receipts during packaging.
Compiler profiles containing patches `0006` and `0007` also require the complete
extended SIMD and vector ABI receipts to advertise SIMD. These bind source
files, C/C++ compiler hashes, exact frontend options, runtime bytes and all
O0/O2 caller/callee combinations.
The packager reopens the actual programs and checks their Wasm types and memory;
receipt JSON alone cannot establish the vector ABI.
Patch `0013` additionally requires `--simd-saturating-qualification`: every
C/C++ and O0/O2 builtin profile, independent lane-result expectations, exact
encoded saturation opcodes, scalar controls and default/disabled/type diagnostics.
It binds the current native compiler, locked sources, headers and tools, and
reopens the assembly, objects and executable programs. See
[SIMD-SATURATING.md](SIMD-SATURATING.md) for the supported builtin signatures.
Patch `0015` further requires `--simd-conversions-qualification`: all 176 canonical
C/C++ O0/O2 cases, 12 additional default-SIMD fallback controls and 192 rejected
builtin compilations. Required direct/composed/scalar instructions must appear
in the actual conversion function. The gate preserves every preceding SIMD,
vector ABI and wide-scalar qualification requirement; see
[SIMD-CONVERSIONS.md](SIMD-CONVERSIONS.md).
Patch `0016` requires `--simd-header-qualification`: all 169 public API names in
C/C++ at O0/O2, four disabled and four default scalar controls, 296 rejected
compilations, and the same 680 canonical sources compiled with the original
pinned Clang header. The gate reopens all objects and programs, checks the
live `convert` function's instructions and requires exact header equality
across source, native installation, browser resources and packaged sysroot.
The complete GCC GPL and Runtime Library Exception notices are retained and
checked by identity; see [SIMD-HEADER.md](SIMD-HEADER.md).
Patch `0017` requires `--symbol-alias-qualification`: 106 native executions,
40 frontend rejections and 32 strict-link rejections with successful controls.
The gate reopens the real linking symbols and relocations and extracts `tinfo.o`
from the packaged GNU archive to verify shared function identity. See
[SYMBOL-ALIASES.md](SYMBOL-ALIASES.md) for source, binding and visibility coverage.
Patch `0018` requires `--weakref-qualification`: 232 real GCC/Clang objects and
528 cases comprising 480 WASI executions and 48 strict-link rejections. The
gate binds exact source, compile/include/link arguments, tools, current-source
GNU runtime and the WASI runner, then reopens the objects, linking metadata,
function signatures and executable programs. Both strong/weak encounter orders
and both strong-override link orders are covered. Same-unit GCC local aliases
must share the defined target's function index or data storage; external weakrefs
must name their public target. See [WEAK-REFERENCES.md](WEAK-REFERENCES.md).
The [source18 evidence](../../docs/gcc-wasi-weakrefs-20261030.json) records
completed native, Wasm-host compiler and actual Chromium Worker qualification.
The binary128 gate requires all 42 O0/O2 fixtures and 124 applicable native
GCC/Clang runs, the pinned print/scan extension and the rebuilt GNU archives.
It checks both actual Clang invocations, executed tool paths, header inventories,
runtime hashes and reopened Wasm artifacts. A passing native gate enables
`capabilities.longDouble`; it does not replace Chromium qualification.
The public-int128 gate independently requires all 42 fixtures and 116 applicable
native runs, matching source/tool/header/runtime identities and actual ABI/I/O.
It enables optional `capabilities.int128`, defaulting to false for older
manifests without changing their link plan. It selects no synthetic compiler
implementation or additional runtime library; existing compiler-rt supplies the
wide helpers. Bundle qualification additionally requires real Worker execution.

When the backend ABI changes, rebuild GNU libstdc++ in a fresh runtime directory.
The packager rejects runtime receipts from a different compiler or patch set.
For incremental compiler builds the recipes rerun target option discovery, so
new `.opt` files cannot leave stale generated headers. Preserve earlier native
gates and receipts separately before qualifying a newly built compiler.

Run the consumer's actual Chromium Worker pipeline after building its package:

```sh
cd "$GCC_WASI_PLAYWRIGHT_PROJECT"
pnpm --filter @wasm-idle/core build
pnpm --filter @wasm-idle/gcc build
node scripts/verify-gcc-wasi.mjs \
  --manifest /absolute/path/to/wasm-llvm/out/gcc-wasi-bundle/gcc-toolchain.v2.json \
  --output out/gcc-wasi-browser-qualification
node scripts/verify-gcc-wasi.mjs \
  --manifest /absolute/path/to/wasm-llvm/out/gcc-wasi-bundle/gcc-toolchain.v2.json \
  --suite /absolute/path/to/wasm-llvm/producer/gcc-wasi/long-double-fixtures.mjs \
  --save-intermediates --output out/gcc-wasi-long-double-browser
node scripts/verify-gcc-wasi.mjs \
  --manifest /absolute/path/to/wasm-llvm/out/gcc-wasi-bundle/gcc-toolchain.v2.json \
  --suite /absolute/path/to/wasm-llvm/producer/gcc-wasi/int128-fixtures.mjs \
  --save-intermediates --output out/gcc-wasi-int128-browser
```

This harness compiles the original C/C++ fixtures inside a Chromium Worker,
checks Wasm object metadata and final imports/exports/memory, runs their exact
stdin/stdout checks in both Chromium and independent Node WASI, and records
the source manifest digest. Its transfer report covers all compiler/runtime
assets and actual requested SDK Worker modules. `loading-sizes.json` separately
records deterministic raw, gzip level 9 and Brotli quality 6 bundle estimates;
those estimates do not pretend to be a measured browser transfer.
Each wide-scalar invocation schedules its own complete 42-fixture suite,
compiling with real Wasm-host GCC and executing each resulting program in
Chromium and Node WASI.
The native mixed-compiler directions are separate from this GCC-only Worker
pipeline. Commands and suite counts are reproduction requirements, not a claim
that a particular bundle has passed; consult the linked qualification results.

Additional focused checks:

```sh
node --test producer/gcc-wasi/*.test.mjs
python3 producer/gcc-wasi/prepare-runtime.test.py -v
GCC_WASI_WASM_LD="$WASI_SDK_PATH/bin/wasm-ld" node producer/gcc-wasi/test-wabt.mjs
node producer/gcc-wasi/test-wabt-browser.mjs
```

See wasm-idle's `scripts/gcc-wasi-README.md` for independent native/O2 checks,
reference comparisons and the x86 browser regression suite. Qualify retained
GCC 13.3 bundles and the current GCC 16.2 bundle separately with the final SDK.

## TLS profile and reproduction

TLS is opt-in: `-mtls` enables native C `_Thread_local`, GNU `__thread` and C++
`thread_local`, and defines `__wasm_tls__`. The default remains `-mno-tls`.
The compiler option is independent of `-matomics`; an SDK request uses `tls: true`
and must name a verified bundle with the TLS capability. Static non-PIC linking
and the effective local-exec TLS model are required. Explicit other default TLS
models, PIC/PIE and effective debug information are rejected; `-g0` is supported.
TLS does not currently provide DWARF TLS locations, dynamic loading, pthreads or
`std::thread`.

Patch `0025` emits real TLS symbols (linking flag `0x100`), TLS data segments
(flag `2`) and `R_WASM_MEMORY_ADDR_TLS_SLEB` relocations (type `21`). Addresses
use the current instance's mutable `__tls_base`. LLD produces the initialization
image and `__wasm_init_tls`, `__tls_size` and `__tls_align` exports. The assembler
preserves these records, including C++ inline TLS weak aliases. It records the
actual atomics/bulk-memory ABI requirements; there is no invented `tls`
target-feature name. Private-memory programs can therefore require engine
atomic instruction support even when user atomic lowering is disabled.

Patch `0026` ports GNU `atexit_thread.cc` with real GNU new/delete and the WASI
allocator. `__cxa_thread_atexit` keeps an allocation-backed per-thread LIFO list,
including registrations made during cleanup. Ordinary normal return and `exit`
use `--wrap=exit --wrap=__wasm_call_dtors` to run TLS destructors before process
atexit callbacks and static destructors. Shared entries call the exported
`__wasm_call_thread_dtors` after normal return. `abort`, `_Exit`, `quick_exit`,
traps, cancellation and timeout do not promise TLS destructor execution.

The private TLS libc is rebuilt from unmodified wasi-libc commit
`161b3195fc2558d2b1ba3eb9ffae3b2b47407623`, using the pinned SDK compiler and
single-thread allocator while retaining genuine TLS. Its source archive SHA-256
is `3bc20d349e6f9fbc4602fb29c80706a25b2875569c3320b11f7f4cf291903f9c`;
the SDK and archive pins are in [runtime.lock.json](runtime.lock.json).
GCC still compiles user programs and the GNU cleanup runtime. Shared TLS uses the
actual pinned SDK threads libc, including its allocator and `sched_yield` import.

The runtime installs exactly nine static archives under the sysroot:

| Directory | Providers |
| --- | --- |
| `lib/wasm32-wasi-tls/` | `libgcc-wasi-tls.a`, `libc.a`, `libc-printscan-long-double.a`, `libm.a`, `libclang_rt.builtins-wasm32.a` |
| `lib/wasm32-wasi-threads/` | `libgcc-wasi-tls-shared.a`, `libc.a`, `libm.a`, `libclang_rt.builtins-wasm32.a` |

It also installs `include/wasm32-wasi-tls/__errno.h`, derived from the pinned SDK
header. TLS compilation places this directory before the ordinary sysroot
includes. The header requires the TLS profile and declares the real libc TLS
storage; it does not replace libc's errno implementation. Actual libc overflow
and cross-Worker checks must agree with GCC's `&errno`. The existing default
header and ordinary library files remain unchanged. Private long-double print
and scan use the private TLS `libc-printscan-long-double.a`, so their errno
references cannot accidentally select the default ordinary libc provider.

Shared SDK TLS requests also require `atomics: true`, fixed `sharedMemory` pages
and an explicit `reservedBytes` budget. LLD's `-z stack-size=reservedBytes`
reserves an arena before the heap: `__stack_high - __stack_low` equals that
budget and `__stack_high == __heap_base`. The host allocates aligned, disjoint
TLS blocks, stacks and guards inside it, sets each Worker's stack, calls
`__wasm_init_tls`, then releases the cohort to its entry function. This prevents
the real allocator from reusing host-assigned TLS or stacks. The result retains
the final memory copy, per-Worker values and `stackRegions`, and adds
`tlsRegions` with each block's bounds and alignment. A trap, cancellation or
timeout terminates the cohort; it does not run a replacement host destructor.

Build the base C/GNU runtime and current native tools above first. Use fresh
output directories. Keep the pinned SDK archive at `${WASI_SDK_PATH}.tar.gz`
and preserve the wasi-libc source archive: package replay reopens both. The
commands below produce the native backend and runtime evidence independently.

```sh
export GCC_TLS_LIBC_DIR="$GCC_WASI_WORK_DIR/tls-libc-current"
export GCC_TLS_RUNTIME_DIR="$GCC_WASI_WORK_DIR/tls-runtime-current"
export GCC_TLS_QUALIFICATION="$GCC_WASI_WORK_DIR/tls-qualification.json"
export GCC_TLS_RUNTIME_QUALIFICATION="$GCC_WASI_WORK_DIR/tls-runtime-qualification/qualification.json"

python3 producer/gcc-wasi/tls-native-check.py \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --output "$GCC_WASI_WORK_DIR/tls-driver"
python3 producer/gcc-wasi/tls-native-shared-check.py \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --output "$GCC_WASI_WORK_DIR/tls-shared" --reserved-bytes 131072
python3 producer/gcc-wasi/build-tls-libc.py \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --source-archive /absolute/path/to/wasi-libc-161b3195fc2558d2b1ba3eb9ffae3b2b47407623.tar.gz \
  --output "$GCC_TLS_LIBC_DIR" --jobs 2
python3 producer/gcc-wasi/build-tls-runtime.py \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sdk-archive "${WASI_SDK_PATH}.tar.gz" --gcc-source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_SYSROOT" --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --tls-libc "$GCC_TLS_LIBC_DIR" --output "$GCC_TLS_RUNTIME_DIR"
node producer/gcc-wasi/test-tls-runtime.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_SYSROOT" --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --runtime "$GCC_TLS_RUNTIME_DIR" --output "$GCC_WASI_WORK_DIR/tls-runtime-qualification"

node --input-type=module <<'JS'
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeNativeTlsQualification, reopenNativeTlsQualification }
  from './producer/gcc-wasi/tls-native-qualification.mjs';
const work = path.resolve(process.env.GCC_WASI_WORK_DIR);
const nativePath = path.join(work, 'native-build.json');
const nativeBytes = await fs.readFile(nativePath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = {
  work, sdk: path.resolve(process.env.WASI_SDK_PATH),
  gccSource: JSON.parse(nativeBytes).gccSource,
  sourceLockSha256: hash(await fs.readFile('producer/gcc-wasi/sources.lock.json')),
  nativeBuild: { path: nativePath, bytes: nativeBytes.length, sha256: hash(nativeBytes) }
};
await writeNativeTlsQualification(process.env.GCC_TLS_QUALIFICATION, {
  driver: path.join(work, 'tls-driver/qualification.json'),
  shared: path.join(work, 'tls-shared/qualification.json')
}, expected);
await reopenNativeTlsQualification(process.env.GCC_TLS_QUALIFICATION, expected);
JS
```

The backend gate requires 40 driver cases (22 executions, 16 diagnostics and
two dynamic-inline multi-TU object checks), plus eight two-Worker cases across
C/C++ and O0/O2. The GNU runtime gate requires 24 ordinary and eight shared cases,
including errno, dynamic inline initialization, more than 128 registrations,
LIFO cleanup and normal/abrupt exit boundaries. Counts alone are insufficient:
the gates bind compiler sources, binaries, libraries, tools, fixture inputs and
result bytes.

Packaging calls `reopenNativeTlsQualification(file, expected)`, then
`reopenTlsRuntimeBuild(directory, expected)` and
`reopenTlsRuntimeExecutionQualification(report, file, expected)`. The runtime
context adds `sysroot`, `gccCxxSysroot`, `tlsRuntime` and `tlsLibc`; execution
also receives the reopened build's `build` record as `runtimeBuild` and its
`files` inventory. Runtime build replay calls
`reopenTlsLibcBuild(directory, { work, sdk, sourceArchive })` for a fresh build
of the official libc sources. These APIs rebuild and execute actual artifacts;
an archive build remains `built-unverified` until execution qualification passes.

Original WAT-to-object and object-to-program bytes are replayed exactly. Fresh
GCC output may reorder complete import declarations; the narrow
[TLS assembly comparator](tls-assembly-replay.mjs) checks every other byte. The
gates create separate canonical assembly/object/program copies for exact comparison.
Raw qualified artifacts remain intact, and both retained and fresh programs
execute. The package preserves these replay reports and recipe identities.

Pass all four TLS package arguments shown above. Source26 requires both native
and runtime proofs; missing providers, changed inputs or mixed compiler builds
are rejected. A packaged candidate still has `qualification.status: "unverified"`.
The final bundle must independently pass the matching SDK's actual Chromium
compile/run and lifecycle qualification before it is advertised as qualified.

## Supported profile and limitations

The default profile is single-threaded, statically linked, wasm32 little endian
WASI Preview 1. Programs export `memory` and `_start`; their only host imports
are `wasi_snapshot_preview1` functions. `int`, `long`, pointers and `size_t` are
32-bit, unlike Linux x86-64. Plain `char` is unsigned in this GCC port, and its
`wchar_t` uses a different C++ underlying type from Clang's WASI target.

Scalar integer/float/double arithmetic, branches, loops, calls, function
pointers, GCC-to-GCC structures, globals, allocation, stdin/stdout, double libm,
headers, multiple translation units and real `-D` options are qualification
targets. The default C++ profile uses `-fno-exceptions -fno-rtti -fuse-cxa-atexit
-fno-threadsafe-statics` consistently so single-threaded global/local static
objects are constructed and destroyed. GNU library/STL support is gated by its
own build and execution tests, independently of the C++ frontend.

SIMD128 is available with explicit SDK `simd: true` and a qualified capable bundle;
the default scalar profile passes `-mno-simd128`. See [the exact SIMD scope](SIMD.md).
The separate `relaxedSimd: true` request requires SIMD128, a qualified capable
bundle and an engine probe. Its 20 operations have the allowed result sets
specified by WebAssembly; see [the relaxed profile](RELAXED-SIMD.md).
RTTI requires an explicit SDK request and a bundle with qualified RTTI support.
Atomics require explicit `atomics: true`, a capable qualified bundle and an engine
probe. Naturally aligned 1/2/4/8-byte operations use native instructions; generic
and 16-byte operations use the original GNU libatomic with target memory locks.
A separate shared-entry runner supports fixed shared memory and private Worker
stacks under the restrictions in [ATOMICS.md](ATOMICS.md). TLS is a separate
explicit [profile](#tls-profile-and-reproduction), with its own runtime and
qualification gates. These profiles do not provide pthreads, `std::thread`,
exceptions or dynamic linking.
Failed reference casts and null-polymorphic `typeid` remain exception-dependent
boundaries; mixed GCC/Clang C++ support is limited to the qualified interfaces
described in [RTTI.md](RTTI.md).
Coverage requires `coverage: true` and a qualified capable bundle. It uses
official single-thread arc counters and libgcov normal-exit writes to an exact
writable `/profile` preopen. The SDK returns original notes and binary profile
files for matching native gcov analysis. PGO, atomic counter updates, manual
gcov APIs and abrupt-exit recovery remain unsupported; see [COVERAGE.md](COVERAGE.md).
Debug requires explicit `debug: true`, a verified capable bundle, and `-O0`.
It embeds standard DWARF4 in WAT/object/executable output; other optimization
levels are rejected by the SDK. See [DWARF.md](DWARF.md).
x86 AVX2/FMA intrinsics and target pragmas belong to the unchanged
x86 API. Unsupported target attributes/pragmas are GCC errors in this profile.
The default GNU C++ runtime still omits the time-zone database, C++26 debugger
functions and prebuilt `std` modules; these require separate runtime qualification
and packaging. Their APIs have no substitute implementations. The runtime
qualification requires `std::chrono::get_tzdb`, `std::is_debugger_present` and
`import std` to fail at linking or compilation. The SDK accepts source/header
inputs through C++23; it does not accept precompiled modules.

An optional [GNU C++26 debugger component](DEBUGGER.md) adds the original
`<debugging>` implementation with an explicit CDP Worker observer-registration
contract. It preserves this default runtime profile and its negative tests.
Only a verified bundle with the separate debugger capability accepts C++26 in
the SDK. Breakpoints are terminal Wasm traps; automatic DevTools detection and
resuming C++ execution after them are outside that profile.

ABI limitations remain and must not be hidden by passing scalar tests:

- Patch `0008` changes `long double` to IEEE binary128 (16-byte size/alignment,
  113-bit precision). Its ABI, libc/libm, formatted I/O and GNU library tests
  gate `capabilities.longDouble`. Older manifests omit this field or set it
  false; their original link command is preserved, and their binary64
  long-double library/variadic interfaces remain unsupported. See
  [the binary128 scope and tests](LONG-DOUBLE.md).
- Patch `0009` enables public signed/unsigned `__int128`, with 16-byte layout
  and low/high i64 arguments and indirect results. Its complete native matrix
  gates `capabilities.int128`; actual Worker qualification is separate. Scalar
  int128 needs no SIMD opt-in. See [the exact integer scope and tests](INT128.md).
- Singleton and empty aggregate interoperation passes the focused Basic C ABI
  suite. With `-msimd128`, the six vector modes and qualified singleton vector
  aggregates use direct `v128` arguments/results. Both sides must select this
  profile; disabled SIMD retains indirect vector calls. The vector convention
  is compared against pinned Clang 22.1.0, not every future compiler version.
  The separate [floating extension matrix](FP-EXTENSIONS.md) qualifies selected
  C `_Float128` and GNU complex long-double operations and ABI cases.
  Complete C/C++ ABI compatibility remains unqualified.
- Patch `0010` repairs trivial C++ empty records, including `alignas(16)`, with
  direct/indirect/callback and nontrivial/member/array/union controls. Patch
  `0011` repairs named wide-bitfield layout and declared-type singleton
  classification; mixed-object linking and execution are checked separately
  from same-compiler runs. See [empty ABI](EMPTY-ABI.md) and
  [wide integer scope](WIDE-INTEGER.md).

Linking uses `--fatal-warnings` to reject detectable signature mismatches. It
cannot detect every layout/calling-convention mismatch. The SDK accepts user
source units and explicitly validated static object/archive link inputs. The backend
supports the qualified strong aliases described in [SYMBOL-ALIASES.md](SYMBOL-ALIASES.md)
and the weak-reference/weak-definition contract in
[WEAK-REFERENCES.md](WEAK-REFERENCES.md). Weak alias definitions, COMDAT groups,
symbol versioning, advanced profiling and debug profiles beyond embedded DWARF4
at `-O0` remain outside this profile;
this is an experimental qualified profile,
not a claim that all GCC tests or all ISO C/C++ programs pass.

## Distribution and provenance

GCC is GPL-3.0-or-later; the runtime exception applies only to eligible runtime
files and uses. WABT is Apache-2.0, PicoSHA2 MIT, and LLVM/wasi-libc have their
recorded component licenses. Static host GMP/MPFR/MPC and Emscripten notices are
included. `licenses/sources.json` identifies exact pinned source notices,
including third-party code actually present in the imported libc archive.

Bundles include source locks, the compiler and runtime build receipts, original
LLVM producer metadata, exact local GCC patches, and sysroot file inventories.
When distributing binaries, make their exact corresponding source, patches,
build scripts and linked dependency sources available alongside the binary
download under the applicable licenses. This producer does not upload, publish
or deploy compiler assets automatically.
