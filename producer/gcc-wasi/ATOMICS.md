# Native atomics and GNU libatomic

The opt-in profile compiles real GCC C/C++ source to WebAssembly atomic
instructions and links the original GNU libatomic from the same pinned GCC
source. It supplies a separate freestanding shared-memory entry contract. It
does not provide pthreads, `std::thread`, TLS, dynamic linking or a threaded WASI
command runtime.

## Compiler and runtime contract

`-matomics` enables naturally aligned 1/2/4/8-byte loads, stores, exchanges,
compare-exchanges and fetch/op-fetch arithmetic and bitwise operations. NAND
uses a native atomic load/CAS loop. Weak CAS may behave as strong CAS. All
accepted memory orders are conservatively strengthened to sequential
consistency; signal fences remain compiler barriers. GCC memory effects and
compiler barriers cover synchronized ordinary memory accesses as well as the
atomic object itself. Narrow high-bit values are compared after matching zero
extension, including the failed-CAS expected-value update.

Known misaligned typed operations are diagnosed. A runtime pointer to a typed
atomic object must satisfy its natural alignment; unknown addresses are not a
promise of an unaligned helper fallback. Sixteen-byte operations remain runtime
calls and are not lock-free. GNU generic operations can handle unaligned byte
ranges through the runtime lock path. A GCC generic builtin can specialize to a
sized operation when its type is known, so callers must still respect typed
alignment requirements.

The target port retains GNU's generic and sized operation bodies. Its shared
linear-memory lock table uses native 32-bit CAS/load/store instructions. Lock
selection covers all stripes overlapping a byte range, acquires unique stripes
in ascending order and releases them in reverse order. Sized and generic
16-byte operations use the same protocol. No JavaScript atomic provider,
fixture helper implementation or pthread shim is linked into the runtime.
The static archive carries the complete GPLv3 and GCC Runtime Library Exception
notices.

The atomic profile disables GCC IPA-reference analysis, including attempts to
re-enable it through command-line order, function attributes or optimization
pragmas. The restriction addresses an observed hoist of an ordinary load across
a valid atomic publication barrier. The regression uses ordinary memory, not a
volatile workaround. The non-atomic profile retains its existing optimization
policy. A related upstream report describes atomic/asm barrier handling by this
pass: [GCC PR80728](https://gcc.gnu.org/legacy-ml/gcc-bugs/2017-05/msg01368.html).

The actual GCC driver forwards WABT's `--enable-threads` when atomics are enabled.
The locked assembler derives `+atomics` from atomic instructions or shared
memory, and `+bulk-memory` from actual bulk operations. It also emits
`+bulk-memory-opt` for copy/fill and rejects contradictory explicit disabled
features. An unrelated byte equal to `0xfe` does not enable atomics.

## SDK execution contract

The optional manifest fields `atomics` and `sharedMemory` default to false;
shared memory implies atomics, while `threads` stays false. A qualified atomic
bundle contains exactly one canonical GNU provider,
`/sysroot/lib/wasm32-wasi/libatomic.a`. The SDK selects it only for an explicit
`atomics: true` request. Ordinary requests keep their existing scalar/SIMD
behavior. An ordinary atomic executable can use WASI stdin/stdout and private
memory, but that does not establish shared execution.

`sharedMemory: { entry, initialPages, maximumPages }` chooses a freestanding
executable with equal initial and maximum page counts. It may import only
`env.memory`. The entry uses `i32` arguments and one `i32` result; C++ entries
need `extern "C"`. The SDK rejects nonempty constructors, TLS, external static
link inputs and unsupported imports. Shared source units receive consistent
flags, without the single-thread macro or `-fno-threadsafe-statics` used by the
ordinary WASI profile. Pure libc memory routines can satisfy GNU libatomic's
dependencies; this does not make the general GNU C++ runtime thread-safe.

`runGccSharedArtifact` creates fresh fixed memory and disjoint aligned Worker
stacks, verifies the linker initialization contract, and releases guest entries
only after all Workers are ready. Browser cross-origin isolation, shared Wasm
memory and module Workers are required. Host coordination does not replace the
guest's atomic operations. Success returns copied memory and values. Any abort,
trap, timeout or invalid reply terminates the cohort and permanently discards
its memory; browser termination may be delayed, so rejection does not imply
immediate CPU quiescence. The ordinary WASI runner rejects shared artifacts.

## Native reproduction and package admission

Use the source preparation, native/Wasm-host compiler, patched assembler, WASI
runtime and GNU C++ runtime steps in [README.md](README.md). Keep their inputs
unchanged throughout qualification. The following paths must be new output
directories; this example runs from the producer repository root.

```sh
python3 producer/gcc-wasi/test-atomics-native.py \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --output "$GCC_WASI_WORK_DIR/atomics-driver"
python3 producer/gcc-wasi/test-atomics-shared-native.py \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --output "$GCC_WASI_WORK_DIR/atomics-shared"

export GCC_LIBATOMIC_WORK_DIR="$GCC_WASI_WORK_DIR/libatomic-current"
python3 producer/gcc-wasi/build-libatomic.py \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_SYSROOT" --output "$GCC_LIBATOMIC_WORK_DIR"
node producer/gcc-wasi/test-libatomic.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_SYSROOT" --libatomic "$GCC_LIBATOMIC_WORK_DIR" \
  --output "$GCC_WASI_WORK_DIR/libatomic-qualification"

export GCC_ATOMICS_QUALIFICATION="$GCC_WASI_WORK_DIR/atomics-qualification.json"
node --input-type=module <<'JS'
import fs from 'node:fs/promises';
import path from 'node:path';
import { identity } from './producer/gcc-wasi/libatomic-qualification.mjs';
import { writeNativeAtomicsQualification } from './producer/gcc-wasi/atomics-qualification.mjs';
const work = path.resolve(process.env.GCC_WASI_WORK_DIR);
const nativeBytes = await fs.readFile(path.join(work, 'native-build.json'));
const native = JSON.parse(nativeBytes);
await writeNativeAtomicsQualification(process.env.GCC_ATOMICS_QUALIFICATION, {
  driver: path.join(work, 'atomics-driver/qualification.json'),
  shared: path.join(work, 'atomics-shared/qualification.json')
}, {
  work, sdk: path.resolve(process.env.WASI_SDK_PATH), gccSource: native.gccSource,
  sourceLockSha256: native.sourceLockSha256, nativeBuild: identity(nativeBytes)
});
JS
```

Add `--libatomic "$GCC_LIBATOMIC_WORK_DIR"`,
`--libatomic-qualification "$GCC_WASI_WORK_DIR/libatomic-qualification/qualification.json"`
and `--atomics-qualification "$GCC_ATOMICS_QUALIFICATION"` to the complete
packaging command in README.md. The current source lock requires all three and
the native linker. Packaging independently reopens the native driver/shared
proofs, rebuilds GNU libatomic, reruns its serial/shared programs, and binds
source, compiler, archive and licenses before advertising either capability.
The original package manifest remains `unverified` until the separate actual
browser compiler and SDK qualification is completed.

## Verification boundaries

The native driver matrix includes 36 cases and six optimization-policy queries.
The shared matrix contains 16 width/language/optimization combinations and four
optimizer override controls. Two actual Workers check high-bit ticket windows,
CAS failures, real interleaving, ordinary-memory publication and sequentially
consistent litmus outcomes. The GNU runtime adds 28 serial and 16 shared cases,
including sized/generic 16-byte contention, hash wrap, all-lock ranges and
overlapping critical sections. These are bounded executions, not an exhaustive
proof of every possible schedule.

Stored original WAT must reproduce its exact relocatable object. A fresh replay
may reorder only complete import declarations; all other WAT bytes are fixed,
and freshly linked programs must match their original bytes. Each fresh shared
memory snapshot is independently checked because valid schedules may differ.
Final browser tests must compile the same source through the newly built
Wasm-host GCC and execute the returned SDK artifacts; native-built programs
alone cannot qualify the browser compiler.
