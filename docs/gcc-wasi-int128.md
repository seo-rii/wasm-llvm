# GCC WebAssembly int128 qualification — 2026-10-27

The ninth backend patch adds real GCC signed/unsigned `__int128` to the separate GCC 17 WebAssembly output
compiler. Candidate 5 passes **1,232 native cases**, including GCC/Clang ABI controls, **401 actual Chromium
Worker programs plus the same 401 independent Node WASI executions**, 87 SIMD artifact checks and
**40 existing x86 regression cases**. The [machine-readable evidence record](gcc-wasi-int128.json)
accompanies this report; earlier binary128/SIMD reports describe their historical bundles.

## Completed implementation and fixed inputs

The native path is C/C++ → GCC `cc1`/`cc1plus` → GCC RTL WebAssembly backend → annotated WAT → patched WABT
relocatable Wasm object → external `wasm-ld` plus WASI runtime → actual Node22 WASI execution. The same
patched GCC source builds the `wasm32-emscripten` compiler host; its output target remains `wasm32-wasi`, WASI
Preview 1. Chromium Worker compiles and executes the complete 401-program corpus with this exact rebuild.
Clang supplies independent reference objects, and Emscripten builds the compiler host; neither substitutes
for GCC compilation of submitted programs.

The [June GCC discussion](https://gcc.gnu.org/pipermail/gcc/2026-June/248353.html) approves a development
direction, not a released implementation. This remains an unmerged experimental author port. Keeping its GCC
17 output bundle separate avoids backporting it into, or changing the behavior of, the existing x86 GCC
13.3/16 bundles. GCC compiler licensing is GPL-3.0-or-later; runtime exceptions apply only where eligible.
Exact patches, notices and dependency source records ship with the bundle; corresponding source remains
required for distribution.

| Component | Exact version or commit |
| --- | --- |
| GCC 17.0.0 experimental source | `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| Author WebAssembly backend | `8f90eb001a5b25ef1e6285c8dc9f9bc13e1a8acd` |
| GCC upstream base | `33ac889aa27d9917e6e7d07c282015b7c48e0440` |
| Annotated-WAT WABT 1.0.37 | `651c9ffbce3d0525d2d1324fab79160e5fcf8173` |
| WASI SDK 33.0 | `c10c0507deb3e5aad506f1f9f32084e49a21834b` |
| Native LLD/Clang/compiler-rt 22.1.0 | `4434dabb69916856b824f68a64b029c67175e532` |
| WASI libc/libm/CRT | `161b3195fc2558d2b1ba3eb9ffae3b2b47407623` |
| Browser LLD 22.1.8 | `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1` |
| Emscripten 6.0.0 / emsdk | `afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3` / `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` |
| GNU libstdc++ | Same GCC source and all nine patches; rebuilt with candidate 5 |
| Basic C ABI convention | [tool-conventions `25aceba5adba8f3f7cdbadd8e8705784aebcad6a`](https://github.com/WebAssembly/tool-conventions/blob/25aceba5adba8f3f7cdbadd8e8705784aebcad6a/BasicCABI.md) |
| Execution runtime | Node `22.23.3`; Chromium `156.0.8078.4` via Playwright |

The [source lock](../producer/gcc-wasi/sources.lock.json) contains all nine patch identities. Its SHA256 is
`879073c7952d77031669d5c307f64e27fc742174322afa4a207a41c7d7c90773`; the exact GCC source diff is
`e918e7d81f26197b73accfe65315aba9b094537f40aec9fa36fa84ef785b30b4`. Patch `0009-int128.patch` is
`981a5355da764da03a12a754fadf301cef29145c40429fcd410d88c078b9e61e`. Both host build receipts and the fresh GNU
runtime bind that source, tool bytes and unchanged inputs. Native `cc1`/`cc1plus` reside under
`out/gcc-wasi-int128-20261027/work/gcc-native/gcc`; browser modules are under `work/browser-compiler`. The
native compiler SHA256 values are respectively
`d617fe1d447f8aab23755bf7d1dcd068283fb392c0a05fad39220bd5f0fcbde9` and
`c329056e6b2da979a7aafb357ab89520717f4cef8a1b9937edf6cee221753ed3`.

## ABI, functionality and retained limits

Public int128 uses 16-byte TImode size/alignment and little-endian low/high i64 storage. Named parameters,
including eligible singleton wrappers, are two i64 values; scalar/singleton results use a leading hidden i32
result pointer. Varargs use the naturally aligned 16-byte caller buffer. Generic GCC double-word optabs and
existing compiler-rt implement operations; runtime shift counts use C `int`/SImode, and word complements use
the existing XOR operation. No new runtime stub, source translator or WebAssembly i128 instruction is used.
SF/DF views of TI/TF containers preserve bits through ordinary SI/DI pseudos.

Coverage includes signed/unsigned arithmetic, carry/borrow, wraparound unsigned multiplication,
division/remainder, bitwise operations/comparisons, variable shifts through 127, float/double/binary128
conversions, globals, packed storage, allocation, loops, direct/indirect calls, callbacks, varargs/`va_copy`,
mixed SIMD, multiple C/C++ units, headers, static lifetime and basic GNU STL. `ONLINE_JUDGE` is passed as a
real `-DONLINE_JUDGE=1` option. References account for wasm32 32-bit `long`/pointers rather than assuming the
x86-64 data model.

Int128 needs no SIMD opt-in. Existing explicit `simd: true` selects qualified SIMD128 operations and direct
`v128` vector ABI; x86 AVX2/FMA intrinsics and target pragmas remain x86 features. Exceptions, RTTI,
threads/TLS/atomics, shared memory, dynamic linking, relaxed SIMD and GNU `__float128` remain unsupported.
Complete `_Float128`/complex arithmetic, all integer builtins (notably missing `__clrsbti2`), wide
bitfields/atomics and complete C/C++ conformance are unqualified. Signed overflow, division by zero,
minimum/-1 and invalid shift counts are excluded.

One separately confirmed existing ABI gap remains for exactly `struct alignas(16) Empty {};`: GCC
passes/returns it indirectly, while pinned Clang omits it from signatures. GCC callers/callees agree. Both
pre-int128 and candidate-5 O0/O2 compile/type probes show the same mismatch; GNU C zero-size aligned controls
agree. `TARGET_EMPTY_RECORD_P` defaults false in this backend. Fixing that C++ case requires a separate ABI
change and runtime requalification. Arbitrary external binary objects are outside the SDK input contract.

The optional v2 manifest `capabilities.int128` defaults false when absent and records native qualification. It
adds no per-request flag or runtime archive; the existing explicit Wasm output target API and x86 API stay
compatible. Producer manifests retain `qualification.status: "unverified"`; actual browser evidence is
separate. Package gates reject incomplete/stale recipes or artifacts.

## Actual results and defects corrected

| Candidate-5 native suite | Passed/total |
| --- | ---: |
| Core libc/libm/C/C++/I/O | 13/13 |
| Existing scalar ABI | 200/200 |
| Basic SIMD | 25/25 |
| Extended SIMD | 62/62 |
| Vector ABI | 684/684 |
| Atomic external-call ABI, test-only providers | 8/8 |
| Binary128 regression | 124/124 |
| Complete int128 matrix | 116/116 |
| Total primary cases | **1,232/1,232** |

ABI matrices include GCC/GCC, GCC/Clang, Clang/GCC and Clang/Clang controls. Additionally, 62 Clang reference
programs and 12 actual SF/DF storage-boundary programs pass, including negative zero, NaN payloads and
neighboring field bytes. Fresh GNU runtime checks pass two execution cases and three required unsupported API
failures. Producer tests pass 20 Node cases (including 14 package cases) and eight Python cases. All seven SDK
production package scenarios pass at SDK commit `47f488a6717eb6aa9c1d4eb3bedb8d6806366d33`, with 5,336 source
files unchanged. The authoritative final install counts are **2,625,695 bytes** for the GCC scenario
(budget 2,628,608) and **42,412,945 bytes** for the public-package aggregate (budget 42,418,176). The int128
SDK change adds 414 installed bytes without increasing its package budget. These install sizes are separate
from the compiler assets downloaded by the browser.

Candidate 3 passed 104/112 selected int128 runs but silently failed eight: a 16-byte constant serializer read
past an eight-byte host buffer. Explicit bounded zero/sign extension fixes that real data defect. Candidate 4
then passed 112/112 int128 runs, but the existing scalar ABI suite exposed six failures (194/200): aligned
double aggregates now used TI containers with unrecognized DF subregister moves. Candidate 5 legalizes
floating pair views without changing bit patterns; all 979 prior-feature cases, core 13 and selected int128
112 pass, followed by the full 116 int128 and 124 binary128 cases above. Original failing sources,
diagnostics, WAT, objects, programs and compiler snapshots are retained.

Objects contain actual Wasm linking metadata; archived sources and I/O match. Existing-regression inspection
reopens 1,871 objects and 979 programs: one unshared memory, `_start: () -> ()`, and only
`wasi_snapshot_preview1` function imports (`fd_read`, `fd_write`, `fd_seek`, `fd_close`, `fd_fdstat_get`,
`proc_exit`). Int128/binary128 gates additionally reopen exact helper/callback signatures, imports/exports and
runtime identities. The package rehashes every asset and provenance file rather than accepting a report status
alone.

| Final rebuild checks | Result |
| --- | --- |
| Chromium Worker + independent Node WASI, 42 int128 + 42 binary128 + 317 regressions | **401/401 each** |
| Saved SIMD artifact/opcode checks | **87/87** |
| x86 GCC 13.3/16.2 regression matrices | **20/20 each; 40/40 total** |
| Actual initial browser response bodies, including SDK Worker modules | **29,567,465 bytes** |

The final Worker postcheck reopens 171 saved WAT and 171 objects, verifies every profile and exact I/O,
and confirms all 510 snapshotted inputs unchanged. Its durable summary is
`evidence/worker-final5-summary.json` (16,968 bytes, SHA256
`41bc6a26b686f40cc55440b268b5762252bf844e6e9db8a6f091a1f5ce2267a6`), with eight
verified output archives totaling 35,551,619 bytes. All associated processes finish with exit 0.
The corpus includes 243 explicitly enabled SIMD programs and 158 scalar programs (108 explicitly disabled,
50 default); actual artifacts match those profiles, and every frontend flag is checked. Six separate
requests for exceptions, RTTI, threads, dynamic linking, x86 CPU selection and x86 target pragmas are
rejected with diagnostics; these checks do not classify supported SIMD128 as unavailable.
The x86 checks preserve libm, multiple C/C++ units/STL, AVX2/FMA and pragma paths. Each compiler's run
reopens 18 saved artifacts and executes six ELF programs with exact stdin/stdout; all source inputs remain
unchanged. GCC 13's 18 artifacts also remain byte-identical to its older baseline. Both x86 process and
archive receipts record exit 0; artifacts are retained in `evidence/x86-gcc13-final47.tar.gz` and
`evidence/x86-gcc16-final47.tar.gz`. The final `control/x86-final-summary.json` is 6,871 bytes, SHA256
`d10138b5978082ae1a1e563b09d5e3297bb9f3a05e00fb511773febddd9b0aff`; it confirms 12 ELF executions,
36 saved artifacts, 487 unchanged inputs, 126 reopened archive members and no remaining owned processes.

## Reproduction, loading and retained artifacts

Follow [native-first setup/build/package commands](../producer/gcc-wasi/README.md#reproduction) and [the
complete int128 contract](../producer/gcc-wasi/INT128.md). Set `GCC_WASI_WORK_DIR` to a fresh build tree,
`WASI_SDK_PATH` to the pinned SDK and `GCC_LIBSTDCXX_WORK_DIR` to its freshly rebuilt GNU runtime; output
directories must be new. The completed run used `work/runtime` as an alias to the preserved C runtime;
the fresh README setup names that directory `runtime-c`, as below.

```sh
node producer/gcc-wasi/test-int128.mjs --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/int128-qualification"
# Package with --int128-qualification .../report.json plus all existing native proofs.
# From matching wasm-idle, using the resulting bundle:
node scripts/verify-gcc-wasi.mjs --manifest /absolute/path/to/bundle/gcc-toolchain.v2.json \
  --suite /absolute/path/to/wasm-llvm/producer/gcc-wasi/int128-fixtures.mjs \
  --save-intermediates --output out/gcc-wasi-int128-browser
```

The verified manifest is 13,017 bytes, SHA256
`fb58c6a8bb2b1f3d367fe7c8c30a5625905558f19693a929e5f3331f31f1d913`. All initial
manifest/compiler/assembler/linker/sysroot assets total **75,415,983 bytes raw, 24,055,995 gzip (level 9),
20,271,743 Brotli (quality 6)**. This includes `cc1.mjs/.wasm`, `cc1plus.mjs/.wasm`, `as.mjs/.wasm`,
`ld.wasm`, `sysroot.tar` and the manifest. The actual Chromium initialization measures 5,511,470 further raw
SDK bytes, for 80,927,453 combined raw bytes and **29,567,465 actual response-body bytes across 150 initial
server transfers**, excluding HTTP headers. Bundle assets use gzip level 9; the isolated qualification
server serves Vite-transformed SDK modules without content encoding. A production build's SDK transfer
requires its own measurement. Full figures are retained in `evidence/worker-final5-loading.json`.
The full bundle is durably preserved at
`out/gcc-wasi-int128-20261027/evidence/bundle-candidate5.tar.gz` (37,177,761 bytes,
SHA256 `9dc273dd0e33cf78c05325cea0432613ab22984a42b236623d635fddaca4927f`). Its adjacent
`.tar.gz.json` receipt records reopening and verifying all 71 files. The raw
`/dev/shm/gti-bundle-candidate5-20261027` copy is retained but is not the sole copy.
Restore with `tar -xzf ARCHIVE -C /path/to/fresh-parent`; this creates the
`gti-bundle-candidate5-20261027` subdirectory, including assets and provenance.

Evidence lives under `out/gcc-wasi-int128-20261027/{control,evidence,artifacts}`. Native program archives were
reopened and hash-verified; raw `/dev/shm` inputs remain until their consumers finish. Some verified archive
symlinks point into `/data/gcc-wasi-task-archives-20261027`; caches and shared-memory paths can expire.
Private `0600` logs under `/home/seorii/logs/` record completed native compiler, browser compiler, GNU
runtime, native suites and packaging final exit **0**; their exact paths/status receipts are recorded in JSON.
The browser's optional `all-gcc` bootstrap records exit 2 (`gcov-tool`/missing host `ftw`); both required
frontends are separately linked successfully, not inferred from that bootstrap.

## Changed files and review locations

Producer implementation commit `32517849a9a0f335c639172ac9fcad260776a828` changes
`producer/gcc-wasi/{patches/0009-int128.patch,sources.lock.json,int128-fixtures.mjs,test-int128.mjs,package.mjs,package.test.mjs}`;
documentation adds `INT128.md`, updates `README.md`/`LONG-DOUBLE.md`, and adds this report/JSON. SDK changes
add manifest int128 metadata/default validation and regressions while preserving target selection and source
compilation APIs.

- Producer worktree: `/home/seorii/dev/hancomac/.worktrees/wasm-llvm-gcc-wasi-20261026`, [PR57](https://github.com/seo-rii/wasm-llvm/pull/57).
- SDK worktree: `/home/seorii/dev/hancomac/.worktrees/wasm-idle-gcc-wasi-20261026`, [PR328](https://github.com/seo-rii/wasm-idle/pull/328).

Primary checkouts and unrelated repositories are preserved. Local `RISK_REGISTER.md` BUG-004 records the
aligned-empty ABI evidence and is excluded from commits.
