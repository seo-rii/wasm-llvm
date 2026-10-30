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
There is no `i8x16.mul` instruction or pattern. Integer vector division and SIMD
conversions do not have dedicated patterns. Patch `0013` adds the eight Wasm
signed/unsigned saturating add/subtract operations for 8-bit and 16-bit lanes;
see the [builtin contract and qualification](SIMD-SATURATING.md).
The additional `0006` patch supplies comparisons, scalar-count shifts, condition
selection and fixed-width constant shuffles; see [its exact scope](SIMD-EXTENDED.md).
The focused qualification requires the corresponding instructions in both GCC
assembly and the assembled Wasm object, then links and executes each program.

This does not provide x86 intrinsic compatibility, a `wasm_simd128.h` intrinsic
API, relaxed SIMD, or an auto-vectorization performance guarantee. It does not
by itself change the draft backend's vector calling convention. Bundles with
patch `0003` alone use indirect memory arguments and a hidden result pointer.
Patch `0007` adds [direct vector ABI support](VECTOR-ABI.md) when both translation
units enable SIMD, with separate GCC/Clang interoperation qualification. The
disabled profile keeps its indirect convention. Do not mix those two profiles
across vector interfaces or infer compatibility from a shared GCC version string.
Existing scalar WASI libc calls keep their ordinary ABI.

The pinned WABT assembler emits the relocatable `linking` section but does not
emit a `target_features` section for SIMD instructions. A loader must determine
SIMD use by decoding instructions or validating the module on the execution
engine; searching bytes for `0xfd` is insufficient because immediates and data
can contain the same byte.

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
