# GCC SIMD vector ABI

The optional SIMD profile passes and returns the six supported 128-bit GNU
vector types directly as WebAssembly `v128` values. Single-element aggregates
containing one such vector use the same value type, recursively through nested
structs, unions and one-element arrays. The compiler uses the same classification
for code generation, direct call signatures and indirect call signatures.

The patch keeps vector-containing aggregate storage in `BLKmode` while retaining
a direct vector at the call boundary. It also prevents integer/vector register
ties, because a Wasm `v128` local cannot be split into integer container
registers. These two changes fix reproduced GCC internal compiler errors during
argument copying and O2 subregister lowering. Supported vector hard registers
are counted as one local, so the return register does not overlap the stack
pointer in GCC dataflow. That final correction follows the register model; a
separate runtime failure from the old register count was not reproduced.

This is compatibility with the pinned LLVM 22.1.0 implementation. The official
[WebAssembly Basic C ABI](https://github.com/WebAssembly/tool-conventions/blob/main/BasicCABI.md)
explicitly leaves vector types outside its stable ABI guarantee. Its singleton,
indirect aggregate and caller-copy rules are used here, together with the pinned
[Clang WebAssembly classifier](https://github.com/llvm/llvm-project/blob/4434dabb69916856b824f68a64b029c67175e532/clang/lib/CodeGen/Targets/WebAssembly.cpp).
Do not infer compatibility with a future vector ABI from these results.

## Classification

| Type with `-msimd128` | Argument | Result |
| --- | --- | --- |
| `vector_size(16)` of char, short, int, long long, float or double | `v128` | `v128` |
| Trivial singleton containing that vector, including packed or recursively nested wrappers | `v128` | `v128` |
| Over-aligned singleton with extra padding | Caller-owned copy pointer | Hidden result pointer |
| Multiple fields, multiple union alternatives, or a packed vector following a byte field | Caller-owned copy pointer | Hidden result pointer |
| C++ type with nontrivial copy constructor/destructor | C++ ABI indirect argument | Hidden result pointer |

A normal C array parameter still decays to a pointer. The singleton-array row
means an array of length one *inside a passed-by-value aggregate*. References and
pointers remain references and pointers. The C++ tests use the GNU C++ frontend
without exceptions, RTTI or threads. Their cross-compiler function names use
`extern "C"` so the comparison isolates the argument/result ABI; it does not
qualify arbitrary C++ name mangling or mixing libc++ with libstdc++.

With SIMD disabled, the existing GCC-only vector convention remains indirect
and operations can be scalarized. No Clang interop is claimed for that profile.
Do not link objects with vector-valued interfaces compiled using different
profiles or an older GCC bundle's indirect vector convention. Link with
`wasm-ld --fatal-warnings` so signature mismatches fail rather than produce
trapping stubs. SIMD arithmetic coverage is documented separately in
[SIMD.md](SIMD.md); direct vector ABI support does not imply automatic
vectorization, all `wasm_simd128.h` builtins, relaxed SIMD, or x86 intrinsics.
Vector varargs and other vector widths are outside this qualification.

## Provenance and qualification

The change is a GCC target backend patch, `patches/0007-vector-abi.patch`, against
GCC 17.0.0, Sourceware `gcc-wasm-2` commit
`ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27`, following the patches recorded in
`sources.lock.json`. It is GPL-3.0-or-later like the GCC files it changes. It
changes neither source-language input nor the choice of compiler for a GCC unit.

The native pipeline is real `cc1`/`cc1plus` → annotated WAT → patched WABT
`wat2wasm -r --enable-annotations` → LLVM `wasm-ld --fatal-warnings` → Node WASI
Preview 1. The WABT commit is
`651c9ffbce3d0525d2d1324fab79160e5fcf8173`. Clang/LLD come from wasi-sdk 33.0,
LLVM commit `4434dabb69916856b824f68a64b029c67175e532`. The same curated
single-threaded WASI libc sysroot is used by both comparison compilers.

`vector-abi-cases.mjs` has 84 enabled cases: six vector lane types crossed with
14 C/C++ aggregate shapes. Each case uses a separate caller and provider,
direct calls, volatile function-pointer calls, a callback crossing both
translation units, argument mutation with caller-copy verification, array and
struct copies, and mixed scalar/vector argument positions. Its input comes from
stdin. Six more cases check the disabled profile with GCC only.

`test-vector-abi.mjs` runs the enabled cases at O0 and O2 in all four directions:
GCC/GCC, GCC/Clang, Clang/GCC and Clang/Clang. The disabled cases run at O0 and O2
with GCC/GCC, for **684 executions** in a full run. Clang is an explicit ABI
comparison compiler, never a fallback for a GCC compile failure. The report
records each command, tool/source/runtime hash, object hash, final Wasm hash,
imports, exports, memory and expected exported function signatures. It verifies
the same compiler and source bytes remain in place throughout the run. The
shared `inspect-vector-abi.mjs` helper is also hashed; producer packaging can
independently inspect the actual program bytes using the same type-table
reader, after WebAssembly engine validation.

The output directory must be new. After preparing the compiler and runtime as
described in [README.md](README.md), run:

```sh
node producer/gcc-wasi/test-vector-abi.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --work "$GCC_WASI_WORK_DIR" \
  --sdk "$WASI_SDK_PATH" \
  --output /path/to/new-vector-abi-report
```

To reproduce a smaller failure, use `--cases vector-abi-i32x4-singleton`,
`--optimizations 0`, and `--directions gcc-clang,clang-gcc`. Compilation, assembly,
linking, execution and ABI assertion failures remain failures in the JSON report
and cause a nonzero exit status. Before this patch, real baseline GCC objects
failed both mixed-compiler directions: `(i32,i32)->void` differed from Clang's
`(v128)->v128` for both the raw vector and its singleton wrapper.

The cases also retain the SDK compile request shape for the separate Chromium
Worker qualification. That path runs GCC/GCC units only; the native cross-compiler
matrix must not be described as cross-compiler compilation in a browser.

## Recorded native result

The 2026-10-27 final private ABI run passed **684/684**, exit 0, with tool,
backend source, runtime, fixture, harness and inspector hashes unchanged. Its
`report.json` SHA-256 is
`6a2fdff06ff74a62abb2bd5a4d586cd5f38eac2c5274a6f46a467cb8be05796e`.
The real native `cc1` SHA-256 is
`60e0744eec0f9afb0273f252cf7c3a1a2ff789740ec4bd58946cab74147cab3a`;
`cc1plus` is
`cd124e6baa1c6fbff2f4b4beffbaa690b37164b3012f51fb1d80cea4fe19d0e6`.

That isolated compiler used baseline patches 1–5 and the vector ABI changes,
including the single-register `v128` correction. Patch 7 is packaged with context
after patch 6; both patch application and its unchanged ABI implementation were
checked in a separate target source tree. A compiler combining the separate SIMD
operation extension must rerun this ABI suite and the operation suite. The
private native result alone does not attest to the combined browser bundle.
