# GCC WebAssembly qualification — 2026-10-26

This is the historical initial profile. The [2026-10-27 backend review](gcc-wasi-backend-review.md)
records subsequent SIMD, ABI and SDK corrections and their separate qualification.

The implemented path compiles original C/C++ through real GCC frontends and its
RTL WebAssembly backend, assembles GCC's annotated WAT with the pinned WABT fork,
and links WASI Preview 1 programs with external LLVM `wasm-ld`. It works with a
native GCC host and with the same GCC source built as Emscripten Wasm inside a
Chromium Worker. Clang does not compile user programs in this path.

This is a qualified experimental profile, not a released upstream GCC target or
complete WASI C ABI implementation. GCC 13.3 and its x86 producer remain separate.
The [source assessment](gcc-wasi-research.md) explains the author port, maintenance,
licensing and decision to use a separate GCC 17 instead of backporting to GCC 13.

## Recorded results

| Check | Result |
| --- | --- |
| Native GCC → WAT → Wasm object → WASI execution | 13/13 |
| Native GCC at `-O2`, independent Node and Chromium execution | 13/13 |
| GNU libstdc++ native build/install | Exit 0 |
| GNU STL/multiple units/static initialization and iostream | 2/2 native GCC/WASI |
| Actual Wasm-host GCC compilation and Chromium Worker execution | 17/17 |
| Independent Node WASI execution of those browser-produced programs | 17/17 |
| SDK unsupported options and actual x86 target pragma | 7/7 rejected |
| Actual native GCC exceptions/RTTI/x86 target-pragma/attribute diagnostics | 4/4 |
| GNU timezone database/debugger/std module unavailable interfaces | 3/3 rejected |
| Host GCC reference programs | 17/17 |
| Clang/WASI reference programs, Node and Chromium | 16/16 |
| Existing real browser GCC 13.3 x86 regression | 20/20 |
| SDK TypeScript build/check, package boundary | Passed |
| SDK unit tests | 42/42 |
| Producer packaging/source patch checks | 4/4 |
| Original LLVM provenance regression checks | 8/8 |
| Artifact/Worker host contract checks using synthetic Wasm | 4/4 |

The intentionally GCC-only macro identity fixture is excluded from the Clang
comparison. Reference and synthetic tests are not counted as GCC code-generation
qualification. Chromium was `153.0.8010.12`, Node `24.1.0`. The tested SDK source
commit is `wasm-idle@5ba0064b`; subsequent qualification documentation does not
change its runtime bytes.

The 17 actual browser cases cover C input/output; integer, float and double
arithmetic; branches/loops; calls/function pointers; globals/structures;
allocation; libm; 64-bit constants/varargs at `-O0` and `-O2`; shared libc errno;
multiple C units/headers; real `-DONLINE_JUDGE`; wasm32 layout; C++ templates;
global/local static construction and destruction; typedef-void direct/indirect
calls; and GNU vector/string/algorithm plus iostream at both `-O0` and the API's
default `-O2`. Multiple C++ units share GNU string values and static initialization.

Every program's expected stdout and zero exit status were checked in both hosts.
Relocatable objects contain `linking` and relocation metadata. Final programs
import only `wasi_snapshot_preview1` functions, export `memory` and `_start`, and
use unshared wasm32 memory. These fixtures start with two 64-KiB pages. The
wasm32 size/alignment expectations are separate from Linux x86-64 expectations.

[The machine-readable summary](gcc-wasi-validation.json) records full source pins,
asset/artifact hashes, fixture identities, imports/exports/memory, output,
unsupported diagnostics, and hashes of the full local qualification receipts.
Full WAT/object/program files and stage argv remain in the local output directories;
generated compiler binaries are not committed or published by these PRs.

## Exact bundle and dependencies

The final local bundle is `out/gcc-wasi-final-bundle/` in the producer worktree.
Its `gcc-toolchain.v2.json` is 8,179 bytes, SHA-256:

```text
d1eb6cfde2ae54de253171b1bcbbc1abb75c605434fa74a23fd25fe02872443a
```

The manifest stays `qualification.status: unverified`: packaging does not certify
a compiler. The separate successful browser receipt identifies that exact digest.

| Component | Pin |
| --- | --- |
| GCC frontend/backend and GNU libstdc++ | `17.0.0`, `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| Backend implementation | `8f90eb001a5b25ef1e6285c8dc9f9bc13e1a8acd` |
| GCC local corrections | Locked typedef-void and host-width formatting patches |
| WABT assembler | `1.0.37`, `651c9ffbce3d0525d2d1324fab79160e5fcf8173` |
| Native linker/builtins | WASI SDK 33 / LLVM 22.1.0, `4434dabb69916856b824f68a64b029c67175e532` |
| WASI libc/libm/CRT | `161b3195fc2558d2b1ba3eb9ffae3b2b47407623` |
| Browser WASI-host linker | LLD 22.1.8, `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1` |
| Emscripten compiler host | 6.0.0, `afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3` |
| Browser Preview 1 adapter | `@bjorn3/browser_wasi_shim` 0.4.2 |

All archive and patch hashes are in the producer locks and summary. The reused
LLD archive is bound to its original producer manifest from repository revision
`7974451468cb09e271f068fd4d6a1af285b22acd`, not the later edited manifest.
GNU runtime build, native execution receipt, packaged archives, errno header and
compiler identities are checked against each other before packaging.

## Initial loading

The compiler/runtime payloads comprise all eight declared manifest assets plus
the manifest. The final full local measurements are:

| Scope | Bytes |
| --- | ---: |
| Compiler/runtime assets and manifest, raw | 75,233,325 |
| Same assets, gzip level 9 | 23,987,662 |
| Same assets, Brotli quality 6 estimate | 20,206,336 |
| Requested SDK/Worker module responses, raw | 5,467,506 |
| All initial content, raw | 80,700,831 |
| Actual initial response bodies | 29,455,168 |

The isolated qualification server actually delivered the bundle with gzip and
Vite SDK modules without compression. The last row is that measured combination,
not a claim about a production site's bundler/CDN. HTTP headers are excluded.
Every declared execution asset was fetched. Per-asset raw/gzip/Brotli sizes are
in the JSON summary and bundle `loading-sizes.json`; provenance/license files
are distribution material rather than initial compiler execution downloads.

## Reproduction

Use the complete pinned native-build, runtime-import, browser-build and GNU
runtime commands in [the producer README](../producer/gcc-wasi/README.md).
Keep those inputs fixed until the builds and their dependent checks finish.
Then, from the matching wasm-idle worktree:

```sh
pnpm --filter @wasm-idle/core build
pnpm --filter @wasm-idle/gcc build
pnpm --filter @wasm-idle/gcc check
pnpm --filter @wasm-idle/gcc test
pnpm --filter @wasm-idle/gcc verify:package-boundary
node scripts/verify-gcc-wasi.mjs \
  --manifest /absolute/path/to/wasm-llvm/out/gcc-wasi-final-bundle/gcc-toolchain.v2.json \
  --save-intermediates --output out/gcc-wasi-browser-new
```

All output directories must be fresh. `scripts/gcc-wasi-README.md` in wasm-idle
documents native/O2 checks, independent reference comparisons, unsupported
diagnostics, Worker cancellation tests and the real x86 regression command.
The original x86 suite plus three libc/libm/multiple-unit cases verifies AVX2,
FMA, target/optimize/push/pop pragmas and GNU C++ behavior with GCC 13.3.

## Remaining technical limits

- Exceptions, RTTI, threads/TLS/atomics, dynamic linking and Wasm SIMD are disabled.
  They are separate from the x86 bundle's AVX2/FMA and target pragma support.
- GNU libstdc++ excludes the timezone database, C++26 debugger functions and
  prebuilt `std` modules. Their real compile/link failures are verified; they
  have no substitute implementations. The SDK accepts C++ source through C++23.
- GCC long double is binary64, while the imported WASI libc ABI uses binary128.
  Long-double library calls/varargs are unsupported. Full support needs backend
  mode/lowering, calling convention and runtime work.
- Singleton aggregate arguments/returns do not match LLVM's Basic C ABI.
  GCC-to-GCC units work; arbitrary external objects are not SDK inputs.
  `--fatal-warnings` catches signature mismatches but cannot catch an argument-only
  layout mismatch with an identical Wasm signature. Backend ABI work remains.
- General atomics, aliases/weakrefs, profiling and debug output need additional
  backend support. The atomic compare-exchange call defect is why the GNU timezone
  implementation is excluded rather than silently accepted.

The producer's local risk register retains these backend issues. Compiler and
runtime sources/notices are pinned for reproducible distribution, but this work
does not merge the experimental port upstream or publish a binary service.
