# GCC WebAssembly backend review — 2026-10-27

This follow-up extends the real GCC 17 WebAssembly output path and reviews its
binary interfaces, SDK execution checks and build provenance. The original
[2026-10-26 qualification](gcc-wasi-validation.md) remains a separate historical
record. GCC 13.3's x86 backend and LLVM/Clang's source-compilation path are not
replaced or upgraded by these changes.

## Review findings and corrections

| Finding | Observable failure | Correction |
| --- | --- | --- |
| High: aggregate ABI | A singleton integer argument could silently pass its address as the value; floating-point/return cases also produced incompatible signatures or invalid calls. | One recursive classification for signatures, argument registers and results; preserve indirect handling for over-aligned, multi-field and nontrivial C++ types. |
| High: narrow integer results | A signed-char result exported to Wasm returned `155` instead of `-101` at `-O2`. | Apply the target's sign/zero promotion to the external function ABI. |
| High: command entry signature | The SDK accepted `_start: () -> i32`, discarded its return value and reported success. | Require the WASI command entry type `() -> ()`; reject implicit Wasm start sections. |
| High: memory and input consistency | Imported shared memory bypassed the defined-memory check; a caller could change input bytes between inspection and execution. | Check imported and defined memory; compile, inspect and execute the same private snapshot/module. |
| High: inherited WASI import names | Imports named `constructor` or `toString` passed the supported-function check through JavaScript's prototype chain. | Require an own property of the actual WASI import object before accepting a function. |
| Medium: atomic libcall signature | GCC's fallback emitted five call arguments but declared six, so WABT rejected compare-exchange objects. | Remove the source-only `weak` parameter from a copied external declaration, preserving symbol metadata. |
| Medium: source and build discovery | Locked patches could not add target files; ignored files could affect configure without entering the source digest; an incremental compiler reused option discovery from before `wasm.opt` existed. | Include locked additions in the private-index source digest, reject unrelated tracked/untracked/ignored inputs, and rerun target configuration before incremental builds. |
| Medium: Worker failure handling | Malformed response types could leave requests pending or be interpreted as another operation. | Reject malformed replies, terminate the Worker and settle pending requests. |
| Medium: qualification evidence | A partial SIMD Worker suite omitted disabled cases; a packaging check could accept missing execution evidence. | Include all enabled/disabled cases and verify outputs, command success, actual program bytes, compiler, linker and runtime identities. |

The ABI correction follows the WebAssembly [Basic C ABI](https://github.com/WebAssembly/tool-conventions/blob/main/BasicCABI.md).
The focused suite contains 25 cases at `-O0` and `-O2` in four directions:
GCC/GCC, GCC/Clang, Clang/GCC and Clang/Clang. The original compiler passed
122/200 and failed 78; the corrected backend passes 200/200. Clang compiles
independent comparison objects only. Original submitted programs continue to
pass through GCC's frontend and RTL backend.

Coverage includes singleton signed/unsigned 8/16/32/64-bit integers, float,
double, pointers, nested struct/union/array wrappers, packed and bitfield
records, zero-length members and empty aggregates. Direct calls, volatile
function pointers, callbacks, return values, varargs and caller-copy semantics
are checked. Over-aligned records, flexible arrays, multiple fields and
nontrivial C++ objects retain their required indirect behavior. This is a
bounded ABI qualification, not a claim of complete C/C++ interoperability.

## SIMD implementation

The new `-msimd128` target option enables six GCC vector modes and corresponding
RTL patterns: 16×i8, 8×i16, 4×i32, 2×i64, 4×f32 and 2×f64. The default and
`-mno-simd128` remain scalar. The browser SDK exposes `simd: true` only for a
capable manifest and probes the actual Wasm engine.

The [SIMD scope](../producer/gcc-wasi/SIMD.md) lists instructions, examples and
limits. The 25 execution cases cover all six types, pointer and GCC by-value
interfaces, lane/constants operations and six disabled profiles. Qualification
requires actual SIMD instructions in GCC WAT and disassembled Wasm, then exact
stdin/stdout under WASI. The SDK detects SIMD from decoded instructions and
types because the pinned assembler does not emit `target_features`.

The ABI remains indirect for vector arguments and results. Direct LLVM `v128`
interoperation, `wasm_simd128.h`, automatic-vectorization performance, relaxed
SIMD and dedicated comparison/shift/shuffle patterns are not qualified. GNU
scalar lowering may implement vector operations without a dedicated pattern;
accepting the option does not promise every expression uses SIMD. x86 AVX2/FMA
intrinsics and target pragmas are unrelated to this feature.

## Integrated execution results

All results below cover the combined five-patch compiler and rebuilt GNU
libstdc++, using Node 22.23.3 and Chromium 156.0.8078.4. The complete measured
identities, case outputs and retained local evidence paths are in
[the machine-readable report](gcc-wasi-backend-review.json).

| Validation | Result | Scope |
| --- | --- | --- |
| Native baseline | 13/13 | GCC → relocatable Wasm → WASI link → exact I/O |
| Rebuilt GNU runtime | 2/2 | Multiple C++ units/STL/static lifetime; iostream |
| Native ABI | 200/200 | 25 fixtures × O0/O2 × four GCC/Clang directions |
| Native SIMD | 25/25 | 19 enabled and six scalar profiles; two disabled/default macro diagnostics also pass |
| Native atomic libcall ABI | 8/8 | Widths 1/2/4/8 at O0/O2; test-only providers |
| Actual Chromium GCC compilation | 75/75 | Baseline 17, SIMD 25, GCC/GCC ABI at O2 25, atomic ABI 8 |
| Independent program execution | 75/75 in each host | Exact stdin/stdout under Chromium Worker and Node WASI Preview 1 |
| Worker SIMD WAT/object inspection | 25/25 | Required opcodes present; disabled profiles contain no SIMD instructions |
| Existing GCC 13.3 x86 | 20/20 | libm, multiple units, AVX2/FMA and pragmas; artifacts byte-identical to the previous qualification |
| Existing scalar bundle with new SDK | 1/1 | C stdin/stdout milestone; no new target flags sent to the legacy compiler |
| SDK / production install | 67/67 and 7/7 | Types, Worker contracts, Wasm inspection, installed API and consumer TypeScript |
| Rejected features | 6/6 and 3/3 | Unsupported SDK options/pragma and unavailable GNU runtime APIs |
| Producer contracts | 5/5 Node, 8/8 Python | Source, packaging and imported runtime provenance; now part of default CI |

The final manifest SHA-256 is
`b06aa6bd983dfcb7c340ed6b8fb816c3a0269f3519cd93893e7f2fcf12aae039`.
The combined GCC source diff is
`3c4d488662d98fd82673910f9528c9aec3ff67d668d0b94029f36e616af94057`;
the source lock is
`5920b26ca26081dac7c3ff1c28913b9999dae138db7cbaa5946c7c359c73c38a`.
The browser qualification binds that exact manifest. Its packaging-time
`qualification.status` remains `unverified`: the separate execution receipts,
not a rewritten manifest or self-declared capability, establish these results.

Wasm programs export `memory` and `_start`, import only supported
`wasi_snapshot_preview1` functions, and use unshared wasm32 memory. Object
milestones contain relocatable linking metadata. SIMD inspection checks actual
instructions/types, including objects without a `target_features` section.
The Worker opcode checker also verifies captured WAT/object/program hashes,
GCC options, fixture identities and both execution hosts' outputs.

### Initial loading and package cost

| Payload | Bytes |
| --- | ---: |
| Complete compiler/assembler/linker/sysroot and manifest, raw | 75,169,503 |
| Same assets, gzip level 9 | 23,945,148 |
| Same assets, Brotli quality 6 estimate | 20,203,618 |
| Actual initial response bodies, including SDK modules | 29,452,158 |
| Raw SDK modules requested by the qualification server | 5,507,010 |
| Installed GCC SDK and production dependencies | 2,628,116 |

The initial response measurement includes all nine manifest/tool/runtime
payloads and requested SDK Worker modules. The isolated server actually serves
the bundle with gzip and SDK modules without compression. Brotli is a
deterministic estimate, not a measured browser transfer; HTTP headers and
provenance/license downloads are not included in these execution payloads.
The installed SDK uses four packages and 176 files. All public package/adaptor
installations together use 42,409,308 bytes; compiler assets are separate.

## Reproduction and provenance

The compiler core, assembler, linkers, libc and Emscripten revisions remain the
[pinned initial versions](gcc-wasi-validation.md#exact-bundle-and-dependencies).
The additional backend corrections are `0003-simd128.patch`,
`0004-basic-c-abi.patch` and `0005-atomic-libcall-abi.patch`; their exact digests
are in [sources.lock.json](../producer/gcc-wasi/sources.lock.json).

Follow [the producer commands](../producer/gcc-wasi/README.md#reproduction) for
native compilation, the 200-case interop suite, the 25-case SIMD suite and the
8-case atomic libcall suite, then build the same compiler for the Wasm host.
GNU libstdc++ must be rebuilt with the changed ABI in a fresh runtime directory.
Packaging rejects a previous compiler's runtime even if its GCC version string
is unchanged. The atomic providers are clearly marked test-only ordinary
loads/stores; no atomic runtime is included or implied.

The consumer's `scripts/verify-gcc-wasi.mjs --manifest ... --suite ...` runs the
producer fixture modules through the actual Chromium GCC Worker. The SIMD suite
also exports disabled cases, which are included automatically. Browser ABI
qualification uses GCC for every translation unit; native mixed-compiler and
raw-export checks are reported separately. The ordinary 17-case GNU C/C++ suite
and unchanged x86 20-case regression are also rerun.

After the Worker SIMD command with `--save-intermediates`, verify its actual
machine instructions with:

```sh
node producer/gcc-wasi/verify-simd-worker.mjs \
  --qualification /path/to/wasm-idle/out/gcc-wasi-simd-browser/qualification.json \
  --objdump "$GCC_WASI_WORK_DIR/wabt-native/wasm-objdump" \
  --output /path/to/new-simd-opcode-verification.json
```

The integrated native build, native tests, browser compiler build, GNU runtime
build/tests and all Worker tests completed with exit code 0. Their private logs
are recorded in the JSON report, including:

- `/home/seorii/logs/gcc-wasi-integrated-native-reconfigure-20261027-sxo2hu_i.log`
- `/home/seorii/logs/gcc-wasi-integrated-browser-20261027-6ycnd9vx.log`
- `/home/seorii/logs/gcc-wasi-integrated-libstdcxx-20261027-awo4ths_.log`
- `/home/seorii/logs/gcc-wasi-integrated-workers-20261027-si0h8geb.log`

The browser recipe's broad `all-gcc` bootstrap still encounters the unsupported
`gcov-tool`/`ftw` link. Its exit code 2 is retained separately; the mandatory
final `cc1` and `cc1plus` targets both build successfully and are the modules
executed in the 75-case qualification. No gcov support is claimed.

Local worktrees are `.worktrees/wasm-llvm-gcc-wasi-20261026` and
`.worktrees/wasm-idle-gcc-wasi-20261026` beneath the hancomac workspace.
The new persistent bundle is producer `out/gcc-wasi-review-bundle-20261027`.
The original scalar bundle and qualification remain preserved. New producer
code is under `producer/gcc-wasi/`; consumer API/runtime changes are under
`packages/gcc/`, with qualification tools under `scripts/`.

## Remaining backend work

- `long double` remains binary64 in GCC and binary128 in WASI libc. Correct
  support needs TFmode, loads/stores, two-i64 argument and sret lowering,
  arithmetic/conversion/comparison helpers and a rebuilt GNU runtime. Changing
  a type-size macro alone would produce incorrect code.
- Direct vector/LLVM ABI, vector-containing aggregates and `__int128` are not
  qualified. The SDK continues to accept source/header units rather than
  arbitrary external binary objects and libraries.
- Exceptions, RTTI, threads/TLS/atomic semantics and dynamic linking remain
  unavailable. Correcting a libatomic function signature does not provide
  synchronization or a WASI threads runtime.
- GNU timezone database, C++26 debugger functions and prebuilt `std` modules
  remain unavailable. Their omitted runtime APIs retain explicit failures.
- Alias definitions, weakrefs, profiling and general debug output still need
  backend work. This remains an experimental, unmerged GCC author port.

Generated compilers and runtime assets are local outputs; these PRs do not
deploy a binary service.
