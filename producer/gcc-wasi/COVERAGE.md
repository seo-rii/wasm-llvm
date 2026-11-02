# GCC WASI coverage

The initial coverage profile uses GCC's ordinary single-thread arc counters and
its official gcov notes, merging, and serialization. Enable it in the WASI SDK
with `coverage: true`. The SDK checks the bundle's `coverage` capability before
compilation; legacy bundles continue to default to coverage disabled.

The [qualification report](../../docs/gcc-wasi-coverage-20261103.md) and
[artifact identities](../../docs/gcc-wasi-coverage-20261103.json) record the
measured native, Chromium Worker, official analysis and existing-feature checks.
Counter updates use GCC's `single` mode: ordinary non-atomic operations in the
single-threaded WASI runtime.

The supported compiler modes are `-fprofile-arcs -ftest-coverage` and driver
`--coverage`, with single counter updates. The SDK uses both flags and retains
one raw `.gcno` file per translation unit. Notes alone (`-ftest-coverage`) do
not measure execution; arcs alone (`-fprofile-arcs`) lack the notes needed for
analysis. Both modes have separate native metadata controls.

Each compilation uses deterministic auxiliary names: `program.gcno`,
`program.1.gcno`, and so on. Their corresponding data paths are
`/profile/program.gcda`, `/profile/program.1.gcda`, and so on. The SDK preserves
the exact bytes produced by GCC. Compilation and execution remain separate:
provide the executable's required `/profile` preopen when running it, retain
the returned binary profile files, and pair them with that compilation's
notes. To accumulate another run, explicitly supply the previous profile
bytes to a fresh run mount. Preserve each compilation's notes and profiles as
a pair; do not combine files from different compiled objects.

The native driver qualification also keeps `-o program.wat` relative to its
isolated compilation directory. GCC's driver derives an absolute `-dumpdir`
from an absolute output path, which would introduce nested paths into the
embedded profile filename. The SDK calls cc1 directly with its fixed auxiliary
namespace.

The runtime supports an existing flat profile directory and normal process
termination. It does not create directory trees. `GCOV_PREFIX`, `%p`, and
environment-dependent filename expansion are outside this profile. The SDK's
official `libwasi-emulated-getpid.a` supplies a compatibility placeholder;
there is no claim of host or process PID semantics.

## Official runtime

[`build-libgcov.sh`](build-libgcov.sh) invokes
[`build-libgcov.py`](build-libgcov.py) to configure the pinned official libgcc
tree with the real GCC/WABT target tools. It generates `auto-target.h` and
`libgcc_tm.h` with GCC's own configure and make rules. It builds only:

- `libgcov-driver.c` with `-DL_gcov`;
- `libgcov-merge.c` with `-DL_gcov_merge_add`.

The archive contains those two actual objects. `inhibit_libc` is unset, so the
build uses the real writer rather than libgcc's freestanding dummy functions.
TLS, mmap, and POSIX file locking are disabled. The writer uses WASI libc's
stdio, allocation, strings, and environment functions.

The experimental Wasm backend retains static constructors but does not register
static destructor entries. The `__wasi__` block in
[`0020-coverage-profile.patch`](patches/0020-coverage-profile.patch) therefore
registers official `__gcov_exit` through libc `atexit` when the first gcov object
is initialized. It registers once per image, before later user `atexit` and
C++ destructor callbacks. The compiler's instrumentation, counter layout,
merging, and file format remain GCC code. Fixtures exercise normal return,
user `atexit`, C++ global destruction, and multiple translation units without
adding manual gcov calls to their source.

The optional runtime ships `libgcov.a` and the exact SDK getpid archive pinned
in [`runtime.lock.json`](runtime.lock.json). Coverage requests link these
before libc. Ordinary requests keep their existing link inputs. Manual gcov
APIs are not an advertised capability.

## Build and native qualification

Prepare the current locked source/native compiler, imported runtime, pinned
native WABT, and qualified GNU C++ runtime first. All build and qualification
outputs must use fresh paths; earlier evidence is never overwritten.

```sh
export GCC_LIBGCOV_WORK_DIR="$GCC_WASI_WORK_DIR/libgcov-current"
export GCC_WASI_SYSROOT="$GCC_WASI_WORK_DIR/runtime-current/sysroot"
bash producer/gcc-wasi/build-libgcov.sh

node producer/gcc-wasi/test-coverage.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_SYSROOT" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --libgcov "$GCC_LIBGCOV_WORK_DIR" \
  --native-gcov "$GCC_WASI_WORK_DIR/gcc-native/gcc/gcov" \
  --output "$GCC_WASI_WORK_DIR/coverage-qualification"
```

The native fixture contract contains 36 original C/C++ translation units and
28 cases at O0/O2: 16 coverage cases and 12 ordinary controls. Its 32 native
executions include 20 instrumented runs; repeated core runs verify GCC's real
profile merging with doubled counts. Eight separate notes/arcs controls and
120 target-specific unsupported-option diagnostics complete the matrix.

Qualification records exact source, compiler, runtime, header, object, notes,
profile, and tool identities alongside full compile/link/run arguments and
stdin/stdout/stderr. Wasm metadata inspection checks counter storage,
relocations, runtime import signatures, and priority-100 constructors; pinned
WABT disassembly checks actual `i64.load`, `i64.add`, and `i64.store` updates.
Every run's profiles and preexisting profiles are copied to immutable evidence
paths before analysis or later execution can change them.

The official pinned `gcov-dump` accepts every raw notes/profile pair, and the
official pinned `gcov --json-format --branch-probabilities --branch-counts`
produces the analysis JSON. The tool reports GCC 17.0.0, JSON format 2, and
version word `B70 ` with a trailing space. Function and branch counts are
checked against independently specified expected results, including loop
counts and callbacks at exit. No custom parser reads the private binary gcov
format. The browser qualification must repeat compilation and execution in an
actual Chromium Worker and analyze the recovered raw bytes with that same
pinned tool before a bundle is qualified.

PGO generation/use, value profiling, atomic or prefer-atomic updates, profile
info sections, condition/path coverage, function instrumentation, and advanced
profile transformation options produce explicit target errors. Coverage does
not enable threads, exception handling, fork/exec, dynamic linking, or abrupt
termination profile recovery.
