# GCC WebAssembly output producer

This is a separate experimental GCC 17 compiler for **Wasm output**. The existing
GCC 13.3 x86 producer in `../gcc-browser` is unchanged. Both compiler hosts can run
as Emscripten Wasm, but their generated program targets are different.

The complete source path is real GCC `cc1`/`cc1plus` → GCC RTL WebAssembly backend
→ annotated WAT → the pinned WABT assembler → relocatable Wasm object → external
LLVM `wasm-ld` + WASI CRT/libc/libm/runtime → WASI Preview 1 execution. Emscripten
builds the compiler host; Clang never compiles user source in this path.

See [the upstream and ABI assessment](../../docs/gcc-wasi-research.md),
[initial native and Chromium results](../../docs/gcc-wasi-validation.md),
[backend review and SIMD qualification](../../docs/gcc-wasi-backend-review.md),
[source pins](sources.lock.json), and [runtime pins](runtime.lock.json).
The June 2026 GCC announcement approved a development direction; this backend is
an unmerged author port, not a released upstream GCC target. Keeping its GCC 17
core changes separate avoids an invasive GCC 13 backport and preserves the x86
compiler's existing intrinsic, pragma, libm and GNU C++ behavior.

## Pinned inputs

| Component | Version / source |
| --- | --- |
| GCC compiler and libstdc++ | Experimental `17.0.0`, Sourceware `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| GCC backend implementation | `8f90eb001a5b25ef1e6285c8dc9f9bc13e1a8acd`, based on GCC `33ac889aa27d9917e6e7d07c282015b7c48e0440` |
| Local backend patches | `0001`–`0005`: void returns, host widths, SIMD128, Basic C ABI, atomic libcalls; SHA-256 pinned in `sources.lock.json` |
| Annotated-WAT assembler | WABT fork `1.0.37`, `651c9ffbce3d0525d2d1324fab79160e5fcf8173`; PicoSHA2 `27fcf6979298949e8a462e16d09a0351c18fcaf2` |
| Native linker / compiler builtins | WASI SDK 33, LLVM `22.1.0`, `4434dabb69916856b824f68a64b029c67175e532` |
| WASI libc / libm / CRT | `161b3195fc2558d2b1ba3eb9ffae3b2b47407623` from the SHA-pinned SDK 33 archive |
| Browser linker | Existing wasm-llvm WASI-host LLD `22.1.8`, `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1`; archive and original producer receipt pinned |
| Compiler host | Emscripten `6.0.0`, `afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3`; emsdk `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` |
| Host arithmetic libraries | GMP 6.3.0, MPFR 4.2.1, MPC 1.3.1; authenticated GNU source archives from `../gcc-browser/sources.lock.json` |

The local GCC patch fixes a real code-generation defect: pointer comparison with
`void_type_node` misclassified `typedef void` and emitted an undeclared `$return`
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

## Reproduction

Use Linux x86-64, Python 3.11+, Node 22.18+ or 24.10+, GNU make, GCC/G++, git, bison, flex,
cmake, curl, patch, tar, xz, and native GMP/MPFR/MPC development packages. Install
the exact SDK and emsdk revisions above. Build paths must not contain whitespace.
`out/` is local, ignored build/evidence storage. A separate wasm-idle checkout
with the matching GCC API changes provides the browser qualification harness.

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
node producer/gcc-wasi/qualify-native.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --suite producer/gcc-wasi/abi-probes.mjs \
  --cases abi-cpp-typedef-void-o0,abi-cpp-typedef-void-o2 \
  --output "$GCC_WASI_WORK_DIR/typedef-void"

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

bash producer/gcc-wasi/build-host-deps.sh
bash producer/gcc-wasi/build-browser.sh
```

Run lengthy commands in the background with a private log from the start and an
exit-status file. Keep sources, recipes and native compiler binaries stable
until dependent builds finish. Check process/status files while running; inspect
bounded log excerpts after exit. A completed native compile/link/run receipt is
mandatory before `build-browser.sh` starts. Its source/patch identity must match.

The native driver in the draft port injects unsupported `-stdlib=libc++`; the
recipe clears that driver spec for the real frontend self-tests. The browser
SDK invokes the real frontend directly with explicit includes and libraries.
`all-gcc` also includes host utilities that are not needed in a Worker. The
browser recipe records its bootstrap exit status, then requires both real
`cc1` and `cc1plus` modules to link successfully. It never marks an incomplete
compiler build successful merely because intermediate objects exist.

For actual GNU C++ runtime support, use the isolated runtime recipe. It copies
the pinned runtime source, adds a WASI configure case with real feature probes,
and replaces one unsupported alias definition with a forwarding function. The
compiler source remains untouched. This is GNU libstdc++, not libc++ or a shim.
The WASI `errno` header also has an explicit GCC single-thread profile patch:
`__GCC_WASI_SINGLE_THREAD__=1` selects the existing libc's ordinary linear-memory
storage. Real C and C++ overflow tests confirm that libc and GCC use the same
`errno`; missing profile markers and `_REENTRANT` are rejected. This does not add
a TLS ABI or alter user source. The imported archive bytes and patched header
identities are both recorded in `runtime-build.json`.

```sh
export GCC_LIBSTDCXX_WORK_DIR="$GCC_WASI_WORK_DIR/libstdcxx"
bash producer/gcc-wasi/build-libstdcxx.sh
node producer/gcc-wasi/test-libstdcxx.mjs "$GCC_LIBSTDCXX_WORK_DIR/qualification"

node producer/gcc-wasi/package.mjs \
  --work "$GCC_WASI_WORK_DIR" --runtime "$GCC_WASI_WORK_DIR/runtime-c" \
  --simd-qualification "$GCC_WASI_WORK_DIR/simd-qualification/qualification.json" \
  --native-linker "$WASI_SDK_PATH/bin/wasm-ld" \
  --libstdcxx "$GCC_LIBSTDCXX_WORK_DIR" --output out/gcc-wasi-bundle
```

The optional `--libstdcxx` input must have a successful real native qualification
receipt. Without it, the package explicitly advertises `libstdcxx: false` and
contains only core C++ language support. Packaging verifies input inventories,
source identities, the native gate and module formats. It writes a fresh output
directory and the final v2 manifest last. It always emits `qualification.status:
"unverified"`; artifact integrity is not compiler qualification.
The optional `--simd-qualification` must contain all enabled and disabled native
cases from the exact compiler binary and current test inputs. It enables the
manifest's SIMD capability; that provisional bundle still needs real Chromium
qualification. Omitting it keeps SIMD unavailable through the SDK.

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
```

This harness compiles the original C/C++ fixtures inside a Chromium Worker,
checks Wasm object metadata and final imports/exports/memory, runs their exact
stdin/stdout checks in both Chromium and independent Node WASI, and records
the source manifest digest. Its transfer report covers all compiler/runtime
assets and actual requested SDK Worker modules. `loading-sizes.json` separately
records deterministic raw, gzip level 9 and Brotli quality 6 bundle estimates;
those estimates do not pretend to be a measured browser transfer.

Additional focused checks:

```sh
node --test producer/gcc-wasi/package.test.mjs producer/gcc-wasi/prepare-source.test.mjs
python3 producer/gcc-wasi/prepare-runtime.test.py -v
GCC_WASI_WASM_LD="$WASI_SDK_PATH/bin/wasm-ld" node producer/gcc-wasi/test-wabt.mjs
node producer/gcc-wasi/test-wabt-browser.mjs
```

See wasm-idle's `scripts/gcc-wasi-README.md` for independent native/O2 checks,
reference comparisons and the original GCC 13 browser regression suite.

## Supported profile and limitations

The intended profile is single-threaded, statically linked, wasm32 little endian
WASI Preview 1. Programs export `memory` and `_start`; their only host imports
are `wasi_snapshot_preview1` functions. `int`, `long`, pointers and `size_t` are
32-bit, unlike Linux x86-64. Plain `char` is unsigned in this GCC port, and its
`wchar_t` uses a different C++ underlying type from Clang's WASI target.

Scalar integer/float/double arithmetic, branches, loops, calls, function
pointers, GCC-to-GCC structures, globals, allocation, stdin/stdout, double libm,
headers, multiple translation units and real `-D` options are qualification
targets. C++ uses `-fno-exceptions -fno-rtti -fuse-cxa-atexit
-fno-threadsafe-statics` consistently so single-threaded global/local static
objects are constructed and destroyed. GNU library/STL support is gated by its
own build and execution tests, independently of the C++ frontend.

SIMD128 is available with explicit SDK `simd: true` and a qualified capable bundle;
the default scalar profile passes `-mno-simd128`. See [the exact SIMD scope](SIMD.md).
Exceptions, RTTI, threads/TLS/atomics and shared/dynamic linking are unsupported.
x86 AVX2/FMA intrinsics and target pragmas belong to the unchanged
x86 API. Unsupported target attributes/pragmas are GCC errors in this profile.
The GNU C++ time-zone database, C++26 debugger functions and prebuilt `std`
modules are omitted because they require unsupported atomic or signal
interfaces. Their APIs have no substitute implementations. The runtime
qualification requires `std::chrono::get_tzdb`, `std::is_debugger_present` and
`import std` to fail at linking or compilation. The SDK accepts source/header
inputs through C++23; it does not accept precompiled modules.

ABI limitations remain and must not be hidden by passing scalar tests:

- GCC `long double` is binary64 (8 bytes); WASI libc expects binary128 (16).
  Long-double runtime interfaces and their varargs are unsupported.
- Singleton and empty aggregate interoperation now passes the focused Basic C
  ABI suite. Vector arguments/returns still use the port's indirect convention;
  direct LLVM `v128` ABI, vector aggregates and `__int128` are not qualified.

Linking uses `--fatal-warnings` to reject detectable signature mismatches. It
cannot detect every layout/calling-convention mismatch. The SDK accepts user
source units, not arbitrary external binary objects or libraries. The backend
also lacks several upstream features such as alias definitions, weakrefs,
profiling and general debug output; this is an experimental qualified profile,
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
