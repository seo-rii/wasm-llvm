# GCC WebAssembly output: source and ABI assessment

Assessment date: 2026-10-26. This describes the selected experimental upstream
sources. Execution results and shipped capabilities must be established by the
producer and SDK qualification tests; an upstream feature or proposal is not a
passing product test.

## Upstream status and source selection

The GCC Steering Committee's [2026-06-15 announcement](https://gcc.gnu.org/pipermail/gcc/2026-June/248353.html)
approves the direction of adding a WebAssembly backend. It explicitly leaves
implementation review to GCC global reviewers and requests an experienced
co-maintainer. It does not announce a merged backend or a released compiler.

The author's [Sourceware PR 160](https://forge.sourceware.org/gcc/gcc-TEST/pulls/160)
was still an open, unmerged draft when inspected. Its branch is newer than the
author's GitHub mirror and is the source selected here:

| Item | Pinned source |
| --- | --- |
| GCC repository | `https://forge.sourceware.org/feedable/gcc-TEST.git` |
| Branch used for discovery | `gcc-wasm-2` |
| Complete GCC revision | `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| Backend implementation commit | `8f90eb001a5b25ef1e6285c8dc9f9bc13e1a8acd` |
| Underlying GCC upstream revision | `33ac889aa27d9917e6e7d07c282015b7c48e0440` |
| `gcc/BASE-VER` | `17.0.0` (development source, not a GCC 17 release) |
| Last branch commit date | 2026-05-28, as returned by the Sourceware Git API |
| WABT repository | `https://github.com/feedab1e/wabt.git` |
| WABT revision | `651c9ffbce3d0525d2d1324fab79160e5fcf8173` |
| WABT reported version | `1.0.37` (the commit identifies the fork extension) |
| PicoSHA2 gitlink | `27fcf6979298949e8a462e16d09a0351c18fcaf2` |
| Browser assembler build compiler | Emscripten `6.0.0`; full version and artifact hashes recorded in its build receipt |

The [original GCC patch submission](https://gcc.gnu.org/pipermail/gcc-patches/2026-May/717771.html)
describes the port as work in progress and reports remaining tests. Those are
the author's test results, not results reproduced by this project. The official
[GCC 17 changes page](https://gcc.gnu.org/gcc-17/changes.html) still identifies
that release as unreleased. An API lookup of the upstream GCC mirror's
`gcc/config/wasm` directory returned no such directory on the assessment date.

Keep the existing GCC 13.3 x86-64 bundle separate. This backend depends on GCC
core changes to argument processing and data-flow handling in addition to its
target files. Backporting it to GCC 13.3 would create another compiler variant
and put existing x86 behavior at risk. A separately pinned Wasm-output bundle
allows focused qualification without changing the x86 compiler version.

## Actual compilation boundary

The program-source path is GCC C/C++ frontend → GCC middle end and RTL backend
→ annotated WAT → WABT `wat2wasm -r --enable-annotations` → relocatable Wasm
object → LLVM `wasm-ld` and WASI libraries → WASI Preview 1 command module.
WABT is an assembler, and `wasm-ld` is a linker; neither substitutes Clang for
the GCC frontend or code generator. Emscripten may compile the compiler and
assembler themselves to make them run in a browser. That is the compiler's
host architecture, independent of the user's program's output target.

Unmodified upstream WABT is not an interchangeable dependency. The selected
fork implements symbol and relocation annotations used by this GCC backend.
Its [upstream WABT PR 2649](https://github.com/WebAssembly/wabt/pull/2649)
was still open and unmerged at inspection. These annotations express symbols,
function-table addresses, memory relocations and constructor priorities. WABT
must preserve those records so the linker can resolve independent translation
units; parsing WAT while discarding unknown annotations is not sufficient.

The compiler source defines `-stdlib=libc++` as its C++ driver default. This
does not provide libstdc++, and the GCC source contains no dedicated WASI
libstdc++ platform configuration. A WASI libc++ archive is not evidence of
libstdc++ support. The selected target runtime and linker revisions, their
licenses, and their actual test coverage belong in the final bundle receipt.

## ABI and feature boundaries

The primary evidence is the pinned [target header](https://forge.sourceware.org/feedable/gcc-TEST/raw/commit/ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27/gcc/config/wasm/wasm.h),
[code generation](https://forge.sourceware.org/feedable/gcc-TEST/raw/commit/ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27/gcc/config/wasm/wasm-cg.cc),
and [assembly output](https://forge.sourceware.org/feedable/gcc-TEST/raw/commit/ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27/gcc/config/wasm/wasm-asm.cc).

| Area | Source-level status and qualification requirement |
| --- | --- |
| Data model | Little endian; pointers, `int`, `long` are 32 bits; `long long` is 64 bits. `size_t` is unsigned long and `ptrdiff_t` is long. Stack alignment is 16 bytes. |
| Plain `char` | The port defaults to unsigned. This differs from the installed WASI SDK's Clang default and must be made explicit in comparisons. |
| Wide characters | The port uses `long` for `wchar_t`; the installed WASI SDK uses `int`. Equal size does not make all C++ type-dependent behavior identical. |
| Floating point | Scalar f32/f64 instructions exist. The target header does not select WASI's 128-bit `long double` ABI. Do not claim long-double libc compatibility without fixing and testing it. |
| Calls | Direct and indirect call patterns exist, along with a function table. Varargs are passed through a linear-memory argument buffer. Test callbacks and printf/scanf separately. |
| Aggregates | Aggregate arguments are passed by reference; return handling also involves GCC's aggregate classification. Cross-compiler struct ABI requires an explicit interop test. |
| Imports | Object output imports `env.__stack_pointer`, `env.memory` and `env.__indirect_function_table`; final WASI programs must resolve these at link time. Inspect final imports instead of treating object imports as the runtime ABI. |
| Entry point | GCC maps zero-argument `main` to `__main_void`, and argument-taking `main` to `__main_argc_argv`, for WASI CRT integration. |
| Static initialization | Constructor-priority annotations exist. Actual execution before `main`, multi-unit ordering and destruction require runtime tests. |
| Exceptions | `TARGET_EXCEPT_UNWIND_INFO` returns `UI_NONE`; libgcc does not select an exception runtime. C++ exception support is not established. |
| RTTI | No evidence of a qualified runtime in this port. Test and report separately from exceptions. |
| Threads/TLS | Explicitly excluded by the port's tests. No browser shared-memory support should be inferred. |
| Dynamic linking | Not established by the GCC backend. Assembler support for relocation kinds alone does not establish compiler/runtime support. |
| Wasm SIMD | No target SIMD implementation in the selected machine description. x86 AVX2/FMA intrinsics and `target` pragmas are separate x86 features. |
| Debug/profiling | Debug output is `NO_DEBUG`; profiling reports an unsupported diagnostic. |
| Other gaps | The port's test adjustments also exclude LTO, named sections, weakrefs, nonlocal goto, computed label values and unprototyped-call cases. |

The [port's test adjustments](https://gcc.gnu.org/pipermail/gcc-patches/2026-May/717773.html)
are useful negative evidence. They must not be used to silently skip a required
product test and then label the corresponding feature supported.

### Native ABI probes on the pinned backend

`producer/gcc-wasi/abi-probes.mjs` contains executable C/C++ probes, including
negative qualification cases. These are intended to reveal unsupported behavior;
the presence of a fixture is not a supported-feature claim. On the unmodified
backend revision, native GCC compilation, the pinned assembler, WASI SDK 33's
linker/sysroot, and Node's WASI Preview 1 runtime established the following:

| Probe | Result before local fixes or policy flags |
| --- | --- |
| Varargs with `int`, `double`, `long long` | Passed with exact expected stdout. |
| `qsort` calling a GCC-generated function pointer | Passed with exact expected sorted output. |
| Global addresses, data relocation addends and function-pointer arrays across C files | Passed. |
| GCC-only singleton and mixed aggregate arguments/returns | Both passed. |
| GCC caller with Clang comparison object, mixed aggregate | Passed. This is an ABI comparison, not a claim that GCC compiled the comparison object. |
| GCC caller with Clang comparison object, singleton aggregate | Failed: `make_single` signatures differ, and the linked module traps. |
| GCC caller with Clang comparison object, singleton argument only | Failed silently: expected `42`, but the callee received the memory address (`65520` in this run) as its integer value. Both Wasm signatures are `(i32) -> i32`, so no linker warning is possible. |
| Constructor priorities 201 and 301 | Passed; both ran before `main` in the expected order. |
| C++ global static destructor | Failed silently: construction and `main` ran, destruction did not. |
| C++ function-local static | Failed to link: unresolved `__cxa_guard_acquire` and `__cxa_guard_release`. |
| `sizeof(long double)`, alignment and mantissa bits | GCC printed `8 8 53`; WASI SDK Clang printed `16 16 113`. |
| Calling WASI `sqrtl` | Failed: GCC emitted `(f64) -> f64`, while the runtime requires `(i32, i64, i64) -> void`; execution trapped. |

The aggregate and long-double differences are defined against the
[WebAssembly Basic C ABI](https://github.com/WebAssembly/tool-conventions/blob/main/BasicCABI.md),
including its singleton aggregate rule and 128-bit long double. `wasm-ld` normally
reports signature mismatches as warnings and can still emit a trapping program.
Production linking must use `--fatal-warnings` so this is a failed compilation.
That option does not detect every ABI mismatch: the argument-only singleton
probe links and exits successfully with the wrong result. GCC-to-GCC aggregate
tests alone cannot prove interoperability with the sysroot or arbitrary
Clang-produced libraries.

Re-running the C++ static-lifetime probes with both `-fuse-cxa-atexit` and
`-fno-threadsafe-statics` passed using WASI libc alone: each printed
`construct`, `main`, and `destroy` in order. These are valid options for the
explicitly single-threaded bundle; they do not establish thread-safe statics,
libstdc++, RTTI, or exception support. Both options must be used consistently by
native and browser compilation paths. C++ guard calls could alternatively be
provided by a qualified C++ ABI runtime, but that alternative was not needed for
these probes.

The long-double libm fixture casts `sqrtl`'s result to `double` for printing.
WASI SDK 33 disables `%Lf` formatting in its default libc; that separate runtime
feature requires the opt-in `c-printscan-long-double` library. The probe therefore
tests the `sqrtl` calling convention without conflating it with printf's optional
long-double formatting support. No complete 128-bit backend support is claimed.

## Licenses and maintenance

The new GCC target files identify their copyright holder as the Free Software
Foundation and are licensed GPL-3.0-or-later, matching GCC compiler code. The
repository includes several other licenses; its GitHub repository-level
GPL-2.0 classification is not the license of this backend. Runtime libraries
have their own notices and the GCC runtime exception where applicable.

The WABT fork uses Apache-2.0. Its pinned PicoSHA2 submodule is a separate
dependency with its own MIT notice. The browser assembler distribution retains
the WABT and Emscripten notices; any bundle publisher must also retain dependency
notices and provide the corresponding compiler source and local patches when
distributing the GPL compiler. The final source receipt must identify what was
actually built, including local patches, rather than only citing a branch name.

There is one visible backend author, an unmerged GCC proposal, and an unmerged
assembler extension. No release or supported maintenance contract was found.
The fork revision is therefore a reproducibility pin, not a stability claim.

## Reproducing the assembler builds

From the wasm-llvm worktree, point to an existing Emscripten 6.0.0 installation:

```sh
GCC_WASI_EMSDK=/path/to/emsdk \
GCC_WASI_WORK_DIR="$PWD/out/gcc-wasi-work" \
GCC_WASI_WABT_JOBS=2 \
bash producer/gcc-wasi/build-wabt.sh all
```

`native` and `browser` can be requested separately. The script pins both the
WABT revision and its submodule, uses isolated browser caches, and emits
`wabt-native/provenance.json` and `wabt-browser/provenance.json`. It builds the
real upstream `wat2wasm.cc` program for both hosts. The browser module uses
MEMFS, exposes `FS`, `callMain` and `HEAPU8`, and requires no Node filesystem.
The normal WABT Emscripten CLI enables NODERAWFS, so this recipe links its
unmodified CLI entry point against the WABT library with explicit Worker flags.

```sh
GCC_WASI_WORK_DIR="$PWD/out/gcc-wasi-work" \
GCC_WASI_WASM_LD=/path/to/wasi-sdk/bin/wasm-ld \
node producer/gcc-wasi/test-wabt.mjs
```

The test assembles two translation units with both hosts, compares their exact
object bytes, checks the function-table relocation record, links both object
sets, validates the resulting modules, and executes an indirect call returning
42. `--native-only` runs the same link and execution check before the browser
assembler is built. This assembler test uses authored WAT; it is separate from
the required tests that prove GCC generated WAT from real C/C++ source.

The browser-only assembler smoke test uses a real Chromium module Worker:

```sh
GCC_WASI_PLAYWRIGHT_PROJECT=/path/to/wasm-idle \
node producer/gcc-wasi/test-wabt-browser.mjs
```

Both assembler tests passed for the pinned source. The Worker test loaded
`as.mjs` and `as.wasm`, assembled a function-table relocation, and produced an
object byte-for-byte equal to the native assembler's output. The measured
assembler payload was 61,491 bytes of JavaScript and 597,157 bytes of Wasm:
658,648 bytes raw, 220,622 bytes with gzip level 9, or 166,223 bytes with Brotli
quality 11. These figures cover the assembler pair only; compiler, linker,
headers, libraries, manifest and SDK Workers must be counted separately for a
complete browser cold-start transfer budget.
