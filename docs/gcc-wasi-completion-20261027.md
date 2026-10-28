# GCC WASI existing-work completion — 2026-10-27/28

The final eleven-patch compiler passes **1,622 native cases**, **539 actual Chromium Worker programs plus the same 539 independent Node WASI executions**, and **40 existing x86 regressions**. Both GCC compiler hosts, the freshly rebuilt GNU runtime and all final source/artifact checks pass. The six existing-work issues below are implemented and qualified within their explicit profiles.

This finishes existing ABI defects, build-profile cleanup and qualification gaps: [#65](https://github.com/seo-rii/wasm-llvm/issues/65), [#84](https://github.com/seo-rii/wasm-llvm/issues/84), [#88](https://github.com/seo-rii/wasm-llvm/issues/88), [#89](https://github.com/seo-rii/wasm-llvm/issues/89), [#90](https://github.com/seo-rii/wasm-llvm/issues/90) and [#91](https://github.com/seo-rii/wasm-llvm/issues/91). Threads, exceptions and the other new backend projects remain separate. The accompanying [machine-readable record](gcc-wasi-completion-20261027.json) binds exact inputs and artifacts; earlier reports remain historical evidence of their original bundles.

## Actual compilation path and fixed source

Both native and Wasm compiler hosts use GCC C/C++ frontends and the GCC RTL WebAssembly backend:

```text
C/C++ source → GCC cc1/cc1plus → annotated WAT → pinned WABT relocatable Wasm
            → external LLVM wasm-ld + WASI CRT/libc/libm/compiler-rt/libstdc++
            → WASI Preview 1 execution
```

Emscripten builds the compiler host; that host is `wasm32-emscripten`. The output target is independently `wasm32-wasi`. Clang compiles reference objects only in the native comparison matrices. There is no source translator or fallback compilation of submitted GCC programs.

The experimental GCC 17 output compiler remains separate from the existing x86 GCC 13.3/16.2 bundles. This avoids backporting the port's GCC core changes into their established intrinsic, pragma and runtime behavior. The [June GCC discussion](https://gcc.gnu.org/pipermail/gcc/2026-June/248353.html) approved a development direction; it did not release this target. Licensing and corresponding-source requirements remain those described in [the producer](../producer/gcc-wasi/README.md#distribution-and-provenance): GPL compiler, eligible GCC runtime exceptions and the exact dependency notices/patches supplied with artifacts.

| Component | Exact pinned source |
| --- | --- |
| GCC / GNU libstdc++ 17.0.0 experimental | `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| Author WebAssembly backend | `8f90eb001a5b25ef1e6285c8dc9f9bc13e1a8acd` |
| GCC upstream base | `33ac889aa27d9917e6e7d07c282015b7c48e0440` |
| Local compiler patches | `0001`–`0011`, exact SHA256 values in [sources.lock.json](../producer/gcc-wasi/sources.lock.json) |
| Annotated WABT 1.0.37 | `651c9ffbce3d0525d2d1324fab79160e5fcf8173` |
| WASI SDK 33.0 | `c10c0507deb3e5aad506f1f9f32084e49a21834b`; archive `0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce` |
| Native Clang/LLD/compiler-rt 22.1.0 | `4434dabb69916856b824f68a64b029c67175e532` |
| WASI libc/libm/CRT | `161b3195fc2558d2b1ba3eb9ffae3b2b47407623` |
| WASI-host browser LLD 22.1.8 | `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1` |
| Emscripten 6.0.0 / emsdk | `afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3` / `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` |
| Host GMP / MPFR / MPC | 6.3.0 / 4.2.1 / 1.3.1, authenticated GNU archives already locked by the x86 producer |
| Compiler-host zlib | 1.3.2, source SHA512 `16fea4df307a68cf0035858abe2fd550250618a97590e202037acd18a666f57afc10f8836cbbd472d54a0e76539d0e558cb26f059d53de52ff90634bbf4f47d4`, fixed by pinned Emscripten `tools/ports/zlib.py` |
| Basic C ABI convention | [tool-conventions `25aceba5adba8f3f7cdbadd8e8705784aebcad6a`](https://github.com/WebAssembly/tool-conventions/blob/25aceba5adba8f3f7cdbadd8e8705784aebcad6a/BasicCABI.md) |
| Program runtime / actual browser | Node 22.23.3 / Chromium 156.0.8078.4 via Playwright `chromium` |

The eleven-patch lock SHA256 is `bd6b091c9c78af395229538a6be4db156d5e04c52bc20a33c8a37f896fd65372`. The exact compiler source diff is `2534d4408b05cf3221755edf38026e6fc57c5519b5c7eb6d59009a76fa88c73c`. Native build receipt SHA256 is `134f07c9a07405b8108d286dab74563db2ed3c021c04357fac63a8ff6f9724cf`; `cc1` is `e28199b4d70364bd645326d930cc4a3fc73c12337c4d04a38c6df5db2c7c5f9a` and `cc1plus` is `d9f206193baed46ee70987ba8d4c883794ce6c4140e0459b952664fc7cf86f15`.

## Repairs and boundaries

- **Empty C++ record ABI (#65).** Patch `0010` marks ABI-empty records during layout and prevents generic O0 register-parameter setup from reading an absent incoming value. `alignas(16)` empty objects keep their storage but disappear from Wasm value signatures. Nontrivial copies/destructors and ordinary nonzero-size member/array/union controls retain their required behavior. [Scope and reproduction](../producer/gcc-wasi/EMPTY-ABI.md).
- **Named bitfield layout and calls (#91).** Patch `0011` applies the declared storage type's alignment and storage-unit rules. Singleton classification uses `DECL_BIT_FIELD_TYPE` instead of the narrowed value type. This repairs both silent nested-record corruption and mixed scalar return signature failures; packed narrow fields remain indirect when their size is smaller than the declared storage type. [Wide integer scope](../producer/gcc-wasi/WIDE-INTEGER.md).
- **Binary128 floating extensions (#88/#89).** The selected C `_Float128` and GNU complex long-double paths now have 50 shared browser fixtures and 124 native runs. An actual GNU `std::abs(3+4i)` precision failure exposed false-negative Autoconf math probes and a reduced-precision fallback `sqrtl`. Typed GCC/WABT/strict-LLD probes select the real available functions. All 67 names, 46 required replacements, pinned source files and actual headers are bound by package verification. [Exact profile and exclusions](../producer/gcc-wasi/FP-EXTENSIONS.md).
- **Wide integer builtins (#90).** Variable/constant cases distinguish actual word expansion from emitted helper calls. `__builtin_clrsbg(__int128)` produces two `i64.clz` operations at O0/O2 and no `__clrsbti2` import. Existing `__ashlti3`, `__bswapdi2` and `__multi3` resolve from the pinned runtime. No helper stub or substitute integer implementation was added.
- **Wasm-host build profile (#84).** GCC's supported `--disable-gcov` selects the explicit `browser-frontends` profile. `gcov`, `gcov-dump` and `gcov-tool` are excluded; `all-gcc` must succeed before final frontend links. A failed build aborts packaging. The cache path fix resolves Emscripten's generated relative sources against the physical cache directory, without overriding function/type detection. The build also passes the native driver's qualified specs to its target checks, clearing the draft driver's unsupported `-stdlib=libc++` injection. Host-tool exclusion does not implement target profiling.

`_Float128` is qualified as a C extension; GNU `__float128` remains a separate unsupported spelling. The pinned Clang rejects `_Float128`, so its explicitly separate reference header uses its real binary128 `long double`; GCC always compiles the original `_Float128` source. Complex tests use identical subject/reference source. The matrix excludes signaling-NaN flags, all rounding modes, every complex branch cut and general transcendental accuracy claims.

| Feature | Current scope |
| --- | --- |
| C/C++, libc/libm, stdin/stdout, allocation, globals, function pointers, multiple translation units/headers, static lifetime, basic GNU STL | Qualified selected matrices below |
| Binary128 `long double`, C `_Float128`, GNU complex long double, signed/unsigned int128 and selected wide builtins/bitfields | Explicit profiles above; scalar use needs no SIMD |
| Wasm SIMD128 | Existing opt-in GNU vectors and qualified operations/ABI preserved; x86 AVX2/FMA and target pragmas remain x86-only |
| Exceptions, RTTI, TLS, threads, synchronization atomics, shared memory, dynamic linking | Unsupported |
| Relaxed SIMD, `wasm_simd128.h`, unqualified conversions/saturation/per-lane shifts/permutations | Separate backend issues; not supplied by x86 intrinsic support |
| GNU timezone database, C++26 debugger functions, prebuilt `std` modules | Unsupported; required negative diagnostics remain |
| Arbitrary external object/archive SDK inputs or output file/preopen API | Separate SDK issues |
| Every C/C++ ABI shape / complete language conformance | Not claimed; unnamed/named bitfield singleton follow-up [#93](https://github.com/seo-rii/wasm-llvm/issues/93) remains unqualified |

## Native and existing SDK results

| Current C8 native suite | Passed/total |
| --- | ---: |
| Core libc/libm/C/C++/I/O | 13/13 |
| Existing scalar ABI | 200/200 |
| Basic SIMD | 25/25 |
| Extended SIMD | 62/62 |
| Vector ABI | 684/684 |
| Test-only atomic external-call ABI providers | 8/8 |
| Empty record ABI | 112/112 |
| Wide builtins | 50/50 |
| Wide bitfields | 72/72 |
| Additional short/long-long/packed singleton bitfields | 32/32 |
| `_Float128` / complex long-double extensions | 124/124 |
| Public int128 | 116/116 |
| Binary128 long double | 124/124 |
| **Primary total** | **1,622/1,622** |

All complete matrices include O0/O2 and their specified GCC/GCC, GCC/Clang, Clang/GCC and Clang/Clang directions. An additional 62 actual Clang programs pass. The final native prerequisite verifier independently reopens all 630 floating/integer/empty/bitfield programs, sources, objects, runtime archives and headers. Existing-regression inspection reopens 979 programs and 1,871 objects; focused new ABI inspection reopens 216 programs and 392 objects with 912 exported signature checks. Programs use one unshared memory, `_start: () -> ()` and only WASI Preview 1 function imports. The atomic providers are test fixtures, not a distributed atomic runtime.

Fresh GNU libstdc++ is compiled by the same C8 GCC; its two runtime executions and three required unsupported-API diagnostics pass. Math probes measure 58 available functions and nine undeclared legacy aliases; all 46 required math-stub replacements are available. The FP/TI/TF 364-run corpus and full GNU source/build/sysroot/probe artifacts are archived and independently copied to persistent storage.

The SDK is based on latest-main merge `53c4de6f`, followed by final `f2d3a8b79fe41efa95de851e253a85b6c0b9b200`. GCC/core source and tests are unchanged by the final budget-only commit. Their 72 passing unit cases, build, type checks and package boundary results are connected by exact source identities; 36 package tests and all seven real production install/import/type-check scenarios run against the final source. Node 24.22.1, npm 11.19.1 and pnpm 12.9.1 were used. The GCC install remains **2,625,695 bytes**. The combined public packages install is **42,443,361 bytes**, 3,366 files and 66 packages; the measured GCC/Zig composition exceeded the merged cap by 609 bytes, so only that byte cap increased by 1KiB to 42,443,776.

Actual merged-SDK x86 Chromium regressions pass **40/40**: GCC 13.3 and GCC 16.2 each 20/20. All 36 generated assembly/object/executable artifacts match the earlier SDK byte for byte, including all 18 GCC 13 artifacts. Twelve distinct native ELF programs run with correct stdin/stdout and are independently re-executed during audit. Producer repository contracts pass, along with 25 Node and eight Python tests.

## Actual final Wasm-host and Chromium results

The Wasm host's normal `all-gcc` build and both standalone ES6 frontend links exit **0**. Host tools `gcov`, `gcov-dump` and `gcov-tool` and their main objects are absent. Native/browser source identities match; host declarations are detected correctly without override answers. The final driver specs match the already-qualified native build. Fresh configuration/object compilation is preserved; the final specs fix reuses matching objects and reruns the real build checks and links.

| Actual Chromium Worker group | Chromium / Node WASI |
| --- | ---: |
| Empty record ABI | 28/28 each |
| `_Float128` / complex extensions | 50/50 each |
| Wide builtins and bitfields | 52/52 each |
| Additional singleton bitfields | 8/8 each |
| Int128 regression | 42/42 each |
| Binary128 long-double regression | 42/42 each |
| Existing core/SIMD/scalar/vector/atomic-ABI regressions | 317/317 each |
| **Total** | **539/539 each** |

All requested translation units compile through the actual Wasm-host GCC. The finalizer reopens all 539 programs, 309 saved main-TU WAT files, 309 objects, 200 imported ABI signatures and 87 SIMD artifact checks. Each executable has one unshared memory with a two-page initial minimum, `_start: () -> ()`, and only WASI Preview 1 function imports. The 556 fixed input files and all six complete native prerequisite matrices (630 programs) remain unchanged.

Twelve complete Worker archives total **44,588,317 bytes**; all **1,193 members** are independently reopened and verified. The source snapshot SHA256 is `100f32325bd0fc7a2cabecdf4a89c115299f03c0a7e0630a0e1c949f192260fa`. Final Worker summary SHA256 is `f99b619a4e28cf4ebc44a875dc64778c17b188df989216f2076fe6d4f2d7971c`. All task browser profiles and build/test processes are closed; no result is pending.



## Bundle and measured initial loading

All eight tool/sysroot payloads and the manifest are included; compressed figures use gzip level 9 and Brotli quality 6. SDK Worker modules are measured separately by the real browser harness.

| Asset | Raw bytes | Gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: |
| `cc1.mjs` | 133,499 | 31,635 | 29,793 |
| `cc1.wasm` | 15,590,758 | 5,520,166 | 4,757,249 |
| `cc1plus.mjs` | 139,030 | 32,900 | 30,993 |
| `cc1plus.wasm` | 17,251,474 | 6,221,048 | 5,374,614 |
| `as.mjs` | 61,491 | 17,414 | 16,658 |
| `as.wasm` | 597,157 | 203,208 | 171,026 |
| `ld.wasm` | 16,171,013 | 6,417,339 | 5,594,500 |
| `sysroot.tar` | 25,443,840 | 5,599,693 | 4,291,427 |
| `gcc-toolchain.v2.json` | 15,225 | 4,794 | 4,568 |
| **Toolchain total** | **75,403,487** | **24,048,197** | **20,270,828** |

The actual suites measured **5,511,470–5,511,490 additional SDK module bytes** from the isolated Vite qualification server. Combined uncompressed bodies are **80,914,957–80,914,977 bytes**. Actual initial response bodies total **29,559,667–29,559,687 bytes**: the gzip toolchain plus those uncompressed SDK modules. The small range reflects per-suite module paths; the machine record retains every measured graph. This measures the qualified browser delivery setup, excluding HTTP headers; it is separate from the npm install sizes and a prospective production bundler’s output.


## Reproduction and retained evidence

Use the exact versions and full commands in [producer reproduction](../producer/gcc-wasi/README.md#reproduction), [empty ABI](../producer/gcc-wasi/EMPTY-ABI.md), [floating extensions](../producer/gcc-wasi/FP-EXTENSIONS.md) and [wide integers](../producer/gcc-wasi/WIDE-INTEGER.md). Build native GCC and complete actual compile/assemble/link/execute qualification before the Wasm host. Rebuild GNU libraries with the same source/patches; old runtime receipts cannot qualify a new compiler.

```sh
node --test producer/gcc-wasi/*.test.mjs
python3 -B producer/gcc-wasi/prepare-runtime.test.py -v
python3 producer/gcc-wasi/prepare-source.py --source "$GCC_WASI_WORK_DIR/gcc"
# After building the matching bundle, run from the matching wasm-idle checkout:
node scripts/verify-gcc-wasi.mjs \
  --manifest /absolute/path/to/bundle/gcc-toolchain.v2.json \
  --suite /absolute/path/to/wasm-llvm/producer/gcc-wasi/fp-extension-fixtures.mjs \
  --save-intermediates --output out/gcc-wasi-fp-extension-browser
```

The full final run uses preserved `out/gcc-wasi-completion-20261027/control/worker-*` controls to execute every listed fixture group, rather than just the floating example. Native tests and packaging use the identical Node 22 executable. The SDK explicitly selects `createGccWorker({ target: 'wasm32-wasi', manifestUrl, manifestSha256 })`; old x86 entry points and manifests retain their own target behavior. The manifest remains `qualification.status: "unverified"`: native packaging does not rewrite it into browser qualification. Actual browser evidence is recorded separately here.

All lengthy jobs start with private `0600` logs under `/home/seorii/logs`, fixed input snapshots and final status files. Inspect logs only after exit; no process is handed off as an unfinished background task. Existing failed C5/C6/C7 programs and both failed C8 host attempts are preserved. Release checking disables GCC internal selftests; build exit zero does not assert that optional internal test bodies ran. The actual compile/link/run matrices above are independent of that build setting. The C7 scalar ABI failure was 196/200 before declared-type classification; GNU FP was 123/124 before typed math detection. The cold-cache alias probe fails at linking generated Emscripten library sources, while the same physical cache path compiles, links and runs with correct actual host declarations.

A host restart cleared earlier TMPFS caches. Persistent archives restored 22,280 current files/links with all hashes checked; no original checkout/data was deleted. The final bundle archive is `evidence/bundle-final8.tar.gz`, 41,944,270 bytes, SHA256 `dda49ceadd5d7cfe81828292c19c844efdeb8c23ad48a8565345705b632d9eed`; its manifest SHA256 is `576ebe8a59ecdda01acaaf71c5f46b8306d3ef75a9d87356728c7fbc9a958d77`. Final compiler resources, GNU source/runtime and bundle/Worker evidence are stored persistently, with complete archive member reopening/hash checks and restoration instructions. The C8 native preflight originally included the browser-host recipe as an extra input; its host-only path fix is separately bound in a new browser snapshot. The original native snapshot remains unchanged, and all actual native compiler sources, native recipe, lock and tool bytes are rechecked.

Worktrees:

- Producer: `/home/seorii/dev/hancomac/.worktrees/wasm-llvm-gcc-wasi-20261026`, PR [wasm-llvm#57](https://github.com/seo-rii/wasm-llvm/pull/57).
- SDK: `/home/seorii/dev/hancomac/.worktrees/wasm-idle-gcc-wasi-20261026`, PR [wasm-idle#328](https://github.com/seo-rii/wasm-idle/pull/328).


Changed implementation files are grouped by purpose:

- Backend lock and patches: `sources.lock.json`, `patches/0010-empty-record-abi.patch`, `patches/0011-bitfield-layout.patch`.
- Real-source qualifications: `empty-abi-fixtures.mjs`, `test-empty-abi.mjs`, `singleton-bitfield-fixtures.mjs`, `wide-integer-*.mjs`, `fp-extension-*.mjs`.
- Runtime/build/package gates: `build-browser.sh`, `build-libstdcxx.sh`, `fp-extension-math-probe.py`, `package.mjs`, `package.test.mjs`.
- Producer scope/reproduction: `README.md`, `INT128.md`, `LONG-DOUBLE.md`, `EMPTY-ABI.md`, `FP-EXTENSIONS.md`, `WIDE-INTEGER.md`, and this report/JSON.
- SDK latest-main conflict resolution: `scripts/verify-package.mjs`, `src/lib/verify-package.test.ts`; GCC API/runtime bytes are unchanged by those final budget edits.

Final private logs/status are indexed in the JSON record. In particular, native build `gcc-wasi-completion-native-candidate8-fixed-inputs-gtsax1yw.log`, host `gcc-wasi-completion-browser-candidate8-final-qv4nw1tz.log`, package `gcc-wasi-completion-package-final8-ep9eufel.log` and Worker finalizer `gcc-wasi-completion-worker-finalize-final8-z98d_qsb.log` under `/home/seorii/logs` all end with exit **0**. Complete raw evidence/control files are under the producer worktree's `out/gcc-wasi-completion-20261027`; local risk/bookkeeping files are not committed.

The original checkouts remain separate. No merge, release asset upload or deployment is included. Remaining work is tracked in the separate feature issues and #93; general ABI, threading, exception and intrinsic coverage must not be inferred from the completed selected matrices.
