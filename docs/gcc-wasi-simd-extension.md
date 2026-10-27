# GCC WebAssembly SIMD and vector ABI extension

This follow-up extends the actual GCC 17 WebAssembly backend with comparisons,
scalar-count shifts, conditional selection, constant shuffles, and direct
`v128` calling conventions. The compilation path remains GCC C/C++ frontend →
GCC RTL → annotated WAT → pinned WABT → external LLD → WASI Preview 1.
Clang is used only for explicitly independent comparison objects and programs.

The integrated seven-patch native compiler passed 992 execution/ABI cases,
62 additional independent Clang oracle programs, and two GNU runtime programs.
The Wasm-host compiler passed all 317 Chromium Worker programs, including the
additional 90-case O0 vector ABI qualification. Exact inputs, outputs and logs
are in [the machine-readable report](gcc-wasi-simd-extension.json). The earlier
five-patch build remains separately recorded in [the preceding report](gcc-wasi-backend-review.md).

## Qualification

| Suite | Native | Chromium Worker and independent Node WASI |
| --- | ---: | ---: |
| C/C++ core, I/O, libm, headers, macros, static lifetime | 13 | 17 including GNU iostream/STL |
| Scalar/aggregate ABI | 200, O0/O2 and four GCC/Clang directions | 25 |
| Original SIMD | 25 | 25 |
| Extended SIMD | 62, plus 62 separate Clang oracles | 62 |
| Vector ABI | 684, O0/O2 and four enabled GCC/Clang directions | 90 at default O2 plus 90 at O0 |
| Atomic libcall ABI with test-only providers | 8 | 8 |
| Rebuilt GNU libstdc++ | 2 | Included in the 17-case baseline |

ABI matrix counts include mixed objects and independent Clang-only references.
Every Worker program is compiled from its original source by the real Wasm-host
GCC; its output is executed by both Chromium's WASI Worker and Node 22.23.3.
Chromium is 156.0.8078.4. There is no Clang fallback in the browser path.

All 87 original/extended SIMD captures also passed actual WAT and object-opcode
checks, including no vector instructions or v128 types in disabled profiles.
Vector ABI qualification checks exported Wasm function signatures, an unshared
memory, direct/indirect calls, callbacks and caller-copy semantics. Native
qualification rechecks compiler, target source, fixture and runtime identities.

The existing actual GCC 13.3 x86 Worker regression passed 20/20: six native I/O
runs, four objdump checks, two expected diagnostics and Worker cancellation.
All 18 comparable assembly/ELF artifacts are byte-identical to the preceding run;
301 regression inputs remained unchanged. Producer contracts passed 11 Node
tests, eight runtime provenance tests, and the repository contract check.

## Bundle identity and initial loading

The v2 manifest SHA-256 is
`9c00045d58e963185d8079d871b5d1741b47193922381083d1c4ec9bb1a73adb`.
The combined GCC patch diff SHA-256 is
`d706fef42fc4cda84a955d1e3130b0171a965a7e4c7c0cfccdb5caf40b6d70c7`.
Both native and Wasm-host compiler receipts identify that exact source.

| Initial payload | Bytes |
| --- | ---: |
| Manifest, both GCC frontends, assembler, linker and full sysroot | 75,197,580 |
| Same bundle, gzip level 9 | 23,951,651 |
| Same bundle, Brotli quality 6 estimate | 20,205,872 |
| SDK modules, uncompressed by the local Vite server | 5,507,010 |
| Actual initial response bodies, gzip bundle plus SDK modules | 29,458,661 |

Every manifest payload appeared in the server's transfer records. HTTP headers
are recorded separately. Brotli is a measured compression estimate, not the
encoding served by this qualification. Offline source/build provenance and
license files are not initial execution payloads. The manifest retains the
packager's `unverified` status; separate execution receipts qualify its exact bytes.

## Backend changes

- [`0006`](../producer/gcc-wasi/patches/0006-simd-operations.patch) implements
  scalar-count left/right shifts for four integer widths; signed and unsigned
  comparisons; f32/f64 comparisons including unordered NaN cases; `v128.bitselect`;
  and constant permutations lowered to `i8x16.shuffle`. Unsigned i64 ordering uses
  sign-bit bias and signed comparison because Wasm has no unsigned i64 comparison.
- [`0007`](../producer/gcc-wasi/patches/0007-vector-abi.patch) passes supported
  vectors and eligible singleton aggregates directly as `v128` with `-msimd128`.
  Over-aligned, multiple-member and nontrivial C++ aggregates retain their required
  indirect conventions. The disabled SIMD profile keeps its original indirect ABI.
- Register-mode and aggregate-storage hooks prevent GCC from splitting a `v128`
  into unsupported integer registers. These address reproduced O2 direct-vector
  and O0 singleton-aggregate compiler crashes. A supported v128 also occupies one
  logical hard register; that model correction was identified during source review.
- Source preparation applies dependent locked patches to a clean checkout using
  a verified combined diff. Existing source edits and the real Git index remain
  protected. Packaging requires complete native SIMD/vector receipts, exact options,
  C/C++ tool hashes and runtime identities, and rechecks the actual program types.

The [SIMD operation specification](../producer/gcc-wasi/SIMD-EXTENDED.md) and
[vector ABI specification](../producer/gcc-wasi/VECTOR-ABI.md) define the fixtures
and implementation limits. WebAssembly's [Basic C ABI](https://github.com/WebAssembly/tool-conventions/blob/main/BasicCABI.md)
states that vector conventions may change; interoperation is qualified against
the pinned Clang version rather than every future toolchain.

## Versions

| Component | Pinned input |
| --- | --- |
| GCC / GNU libstdc++ | Experimental 17.0.0, `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| Original GCC backend | `8f90eb001a5b25ef1e6285c8dc9f9bc13e1a8acd`, upstream base `33ac889aa27d9917e6e7d07c282015b7c48e0440` |
| Local backend | Patches 0001–0007, exact SHA-256 values in [sources.lock.json](../producer/gcc-wasi/sources.lock.json) |
| Annotated-WAT assembler | WABT fork 1.0.37, `651c9ffbce3d0525d2d1324fab79160e5fcf8173` |
| Native LLD / comparison Clang | WASI SDK 33, LLVM 22.1.0, `4434dabb69916856b824f68a64b029c67175e532` |
| WASI libc / libm / CRT | `161b3195fc2558d2b1ba3eb9ffae3b2b47407623` |
| Browser LLD | 22.1.8, `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1` |
| Compiler host | Emscripten 6.0.0, `afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3` |
| Browser WASI host | `@bjorn3/browser_wasi_shim` 0.4.2 |

The compiler remains an unmerged author port. The [June GCC announcement](https://gcc.gnu.org/pipermail/gcc/2026-June/248353.html)
approved the development direction, not the implementation or a released target.
GCC 13.3 x86 and its libm, C++, AVX2/FMA and pragma behavior use their separate bundle.

## Reproduction

Follow the complete [producer commands](../producer/gcc-wasi/README.md#reproduction)
with a fresh output directory for each qualification. Native build, native execution,
browser build, GNU runtime build, packaging and actual Worker execution are separate
gates. Rebuild the GNU runtime after changing the backend's source identity.

The additional native commands are:

```sh
node producer/gcc-wasi/test-simd-extended.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" --work "$GCC_WASI_WORK_DIR" \
  --sdk "$WASI_SDK_PATH" --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --oracle clang --output out/simd-extended-native
node producer/gcc-wasi/test-vector-abi.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" --work "$GCC_WASI_WORK_DIR" \
  --sdk "$WASI_SDK_PATH" --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output out/vector-abi-native
```

The wasm-idle `scripts/verify-gcc-wasi.mjs` harness accepts each producer fixture
module through `--suite`. Use `--save-intermediates` for the original and extended
SIMD suites, then verify the saved WAT and assembled objects:

```sh
node producer/gcc-wasi/verify-simd-worker.mjs \
  --qualification /path/to/simd-extended-worker/qualification.json \
  --suite producer/gcc-wasi/simd-extended-fixtures.mjs \
  --objdump "$GCC_WASI_WORK_DIR/wabt-native/wasm-objdump" \
  --output out/simd-extended-worker-opcodes.json
node --test producer/gcc-wasi/*.test.mjs
python3 producer/gcc-wasi/prepare-runtime.test.py -v
```

To repeat the additional O0 Worker run, create a trusted local module at
`out/vector-abi-o0/cases.mjs` in the producer checkout with the following content.
Pass its absolute path to the SDK harness's `--suite` and use a fresh `--output`.
The original source, headers, stdin and expected output remain the same; the
SDK's optimization value is the string `'0'`.

```js
import { cases as enabled, disabledCases as disabled } from '../../producer/gcc-wasi/vector-abi-cases.mjs';
const atO0 = fixture => ({ ...fixture, id: fixture.id + '-worker-o0', request: { ...fixture.request, optimization: '0' } });
export const cases = enabled.map(atO0);
export const disabledCases = disabled.map(atO0);
```

All required native, GNU runtime, Wasm-host compiler, packaging and Worker jobs
completed with exit code 0. Their private logs and status paths are recorded in
the JSON report. The draft native driver's first selftest rejects its own
`-stdlib=libc++`; the recipe's explicit driver spec and final native selftests
succeed. The browser bootstrap's unused `gcov-tool` fails on Emscripten's missing
`ftw`, while both required frontend modules link and execute successfully.

Failed preparation attempts are retained separately: a patch-context conflict,
disk exhaustion, a stale native qualification gate, and the O0 test wrapper's
initial numeric profile value. The corrected runs completed; none of those
attempts is counted as a successful compiler qualification. Task-owned build
outputs were relocated with matching hashes before the successful rebuild.

## Remaining limits

`long double` still uses binary64 in GCC and binary128 in WASI libc. This round's
native investigation reproduced mismatched function signatures and a variadic
`%Lf` call that exits successfully with the wrong output when the SDK's optional
printscan archive is supplied. Fatal linker warnings cannot detect that mismatch.
This feature remains unsupported; no source-wide rejection is claimed.

Full support requires TFmode storage and moves, paired-i64 arguments, hidden result
pointers, correct soft-float libcall signatures, 16-byte variadic layout, the real
`libc-printscan-long-double.a`, and rebuilt GNU runtime/browser qualification.
Existing compiler-rt helpers were verified but do not implement a GCC TFmode backend
by themselves. The detailed local investigation is retained under
`out/gcc-wasi-long-double-20261027/`.

Exceptions, RTTI, threads/TLS/atomics, dynamic linking, relaxed SIMD, saturating and
conversion SIMD patterns, runtime-index shuffles and a `wasm_simd128.h` API remain
unsupported or unqualified. No automatic-vectorization performance claim is made.
SIMD is explicitly enabled with SDK `simd: true`; x86 intrinsic or target-pragmas
do not select it. Arbitrary externally compiled objects remain outside the SDK API.

## Worktrees

- Producer: `/home/seorii/dev/hancomac/.worktrees/wasm-llvm-gcc-wasi-20261026`
- SDK: `/home/seorii/dev/hancomac/.worktrees/wasm-idle-gcc-wasi-20261026`

Primary checkouts and unrelated repositories were preserved. The SDK implementation
is unchanged in this follow-up; its documentation describes the additional producer
features and verification commands. The producer changes include the two backend
patches, new SIMD/vector fixtures and native harnesses, binary ABI inspection,
strict package/Worker proof checks, dependent-patch preparation, and these reports.

The complete local evidence archive is
`out/gcc-wasi-extended-20261027/qualification-artifacts.tar.gz` in the producer
worktree: 157,885,724 bytes, SHA-256
`f420fbfe0ad85c8b742e5c681a6387b9b76706e478efd3ff89e2be73f9ad0790`.
All 8,965 archived files were reopened and checked against their recorded hashes.
It persists the native compiler, executable browser bundle, program artifacts,
logs and exact local verification scripts. After extracting it into a fresh
directory, the usable bundle is `artifacts/bundle/gcc-toolchain.v2.json`.
The live bundle is also available under `out/gcc-wasi-extended-artifacts-20261027/bundle`;
its working storage uses tmpfs, while the archive resides on persistent disk.
