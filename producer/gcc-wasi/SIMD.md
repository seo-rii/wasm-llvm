# Optional SIMD128 backend

`patches/0003-simd128.patch` extends the pinned GCC WebAssembly target. The
compiler selects these instructions through GCC machine modes and RTL patterns;
the producer does not rewrite submitted source or generated assembly.

`-msimd128` enables the six 128-bit GNU vector modes: `V16QI`, `V8HI`, `V4SI`,
`V2DI`, `V4SF`, and `V2DF`. It also defines `__wasm_simd128__`.
`-mno-simd128` and the compiler default leave the feature disabled. A source can
use `__attribute__((vector_size(16)))` with integer or floating point elements.

The patch contains vector constants, loads, stores, moves, lane replacement and
extraction, scalar splats, addition and subtraction, integer multiplication for
16/32/64-bit lanes, floating point multiplication and division, negation, and
integer bitwise operations. Unsupported vector operations can use GCC's scalar
lowering; accepting `-msimd128` does not promise that every expression vectorizes.
There is no `i8x16.mul` instruction or pattern. Integer vector division has no
dedicated pattern. Patch `0015` adds selected integer/float and widening/narrowing
[SIMD conversions](SIMD-CONVERSIONS.md), including documented composed and scalar
paths. Patch `0013` adds the eight Wasm
signed/unsigned saturating add/subtract operations for 8-bit and 16-bit lanes;
see the [builtin contract and qualification](SIMD-SATURATING.md).
The additional `0006` patch supplies comparisons, scalar-count shifts, condition
selection and fixed-width constant shuffles; see [its exact scope](SIMD-EXTENDED.md).
Runtime `__builtin_shuffle` uses the qualified
[scalar permutation fallback](SIMD-RUNTIME-PERMUTATION.md), including modulo
selectors for one or two vectors in all six modes.
The focused qualification requires the corresponding instructions in both GCC
assembly and the assembled Wasm object, then links and executes each program.

Patch `0016` supplies the documented 169-name
[`wasm_simd128.h` subset](SIMD-HEADER.md). This does not provide x86 intrinsic
compatibility, relaxed SIMD, or an auto-vectorization performance guarantee.
Patch `0003` does not by itself change the draft backend's vector calling
convention. Bundles with
patch `0003` alone use indirect memory arguments and a hidden result pointer.
Patch `0007` adds [direct vector ABI support](VECTOR-ABI.md) when both translation
units enable SIMD, with separate GCC/Clang interoperation qualification. The
disabled profile keeps its indirect convention. Do not mix those two profiles
across vector interfaces or infer compatibility from a shared GCC version string.
Existing scalar WASI libc calls keep their ordinary ABI.

The pinned WABT assembler with `wabt-0001-simd-target-features.patch` records
actual SIMD instructions and `v128` types in one `target_features` section,
including relocatable objects. Merely enabling SIMD does not mark scalar code
as SIMD. The patch also records `relaxed-simd` when assembling those WAT
instructions; this does not add relaxed SIMD support to the GCC backend.
Existing feature declarations are preserved and conflicting declarations fail
assembly. See [target feature qualification](TARGET-FEATURES.md).

Loaders must still decode instructions and validate on the execution engine.
Feature metadata can be missing or untrusted, and searching bytes for `0xfd`
is insufficient because immediates and data can contain the same byte. The SDK's
decoder and its data/integer/floating-point immediate regressions remain intact.

To qualify an isolated native build containing this patch:

```sh
node producer/gcc-wasi/test-simd.mjs \
  --compiler /path/to/native-build/gcc \
  --source /path/to/patched-gcc-source \
  --work /path/to/gcc-wasi-work \
  --sdk /path/to/wasi-sdk-33 \
  --output /path/to/new-qualification-directory
```

Use Node 22.18+ or Node 24.10+ for this command; the SDK repository recommends
Node 22.23.3. The harness records the GCC revision, hashes of
all target sources and the compiler, assembler and linker, all commands,
module imports/exports, and actual stdout in `qualification.json`. It checks
compiler identity again after execution. The output directory must be new.
`simd-fixtures.mjs` supplies both enabled and disabled versions of the same
arithmetic programs, with stdin and independently checked expected outputs.

Native execution and Chromium Worker execution must both pass before treating
or distributing a bundle as execution-qualified. Packaging after native
qualification can advertise `capabilities.simd: true` while retaining an
unverified browser qualification state, so the actual Worker path can be
tested. Native qualification alone does not establish that the Wasm-host
compiler or browser path works.

The native qualification on 2026-10-27 passed all 25 execution cases: 12
pointer-interface arithmetic cases at `-O0` and `-O2`, six GCC vector argument
and return cases, one constants/lane-access case, and six disabled-SIMD cases.
All use real stdin/stdout and WASI Preview 1. The negative feature-macro check
also passed. This qualification records emitted instructions for the tested
expressions; it does not establish every implemented pattern or arbitrary
vector program as correct.

The integrated Wasm-host GCC also passes all 25 cases through Chromium Worker,
with independent Node WASI execution of each resulting program. Captured GCC
WAT and assembled objects pass `verify-simd-worker.mjs`: it checks the exact
fixture/manifest/artifact identities, frontend options and required disassembled
opcodes. See the [integrated review report](../../docs/gcc-wasi-backend-review.md)
for the qualified bundle hash and reproducible Worker commands.
Those results describe the original five-patch bundle. The subsequent
[extension report](../../docs/gcc-wasi-simd-extension.md) identifies the seven-patch
compiler, new operations and vector ABI, including its own browser qualification.
