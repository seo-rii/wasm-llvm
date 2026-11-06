# GCC/WASI thread-local storage qualification

The final source26 native compiler, same-source Wasm-host compiler, GNU TLS
runtime, packaging, SDK checks and 966 actual Chromium compiler cases pass.
GCC 13/16 compatibility and independent execution of retained artifacts also
pass. This records local work for [wasm-llvm issue 68](https://github.com/seo-rii/wasm-llvm/issues/68);
no bundle has been published and no remote issue has been closed.

The final evidence index is `out/issue68/final-qualification.json`.
Its SHA-256 is `6eb66fa2e8af61e6eb05b55a37ce9c9e6e5e24e7427afa054971b2ae20a675df`.
The [producer contract](../producer/gcc-wasi/README.md#tls-profile-and-reproduction)
contains the build and reproduction commands. The companion `wasm-idle` GCC
README documents the public `tls` and shared-memory request fields.

## Bound implementation

| Input | Identity |
| --- | --- |
| GCC author port | `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| GCC patches | 26 |
| TLS backend patch 0025 | `b8e71c0d7db82712e4359a83c0736e8b60d59065ef5e51fc265ad79eb1e1d8a9` |
| GNU TLS runtime patch 0026 | `4075e51f49c586c50804d3fdf2463445cff981361807f0b3e87a81cdf7f69c0e` |
| Combined GCC source diff | `c089e713cd5b5fac2829a3c03db0ed71ab5311e0170ed4c1f24a1e141a3b4911` |
| Source lock | `ad0932520709d5ad56bafbbb9817adab7511a71c385a9405ea989f55af84225f` |
| Native compiler receipt | `966d4dada0c37998de5ec8a4f402444d69e1cb1e12261f65e851c24e4ec5a7c5` |
| Wasm-host compiler receipt | `217e42d519b8abe09664960b4fb5ca6af7c4b66fd385d83498ae54f4b53a6ce3` |
| WABT | `651c9ffbce3d0525d2d1324fab79160e5fcf8173` plus five locked patches |
| SDK source/dist aggregate | `f19a717d08dd1b49995f3c0c288d5df2e3449a17f33c129d12d9faa31299ca0c` |

TLS is explicit (`tls: true`, native `-mtls`) and uses static local-exec
relocations. C `_Thread_local` and C++ `thread_local` cover initialization,
multiple translation units, one-only/weak identity, distinct Worker state and
real GNU destructor registration. The allocation-backed GNU list supports
nested registration and drains in LIFO order.

The private command profile uses the pinned single-thread libc rebuilt with
real TLS, including its binary128 formatter/scanner. An opt-in `__errno.h`
declaration matches that libc. Shared TLS uses its qualified threads libc,
real allocator and GNU cleanup/new/delete support, without adding the full
shared GNU libstdc++ archive. Its fixed memory reserves separate TLS images,
stacks and guards below the allocator heap. The SDK validates linked bounds
and initialization before starting Workers.

Nine private runtime archives and the TLS errno header are integrity-bound.
All 214 original runtime payloads, including 211 packaged sysroot payloads,
remain byte-identical. TLS providers never enter the default runtime-library
list. The existing ordinary headers and non-TLS request plans are preserved.

## Completed checks

| Check | Coverage | Result |
| --- | --- | --- |
| Native TLS backend | 40 driver cases and 8 shared cases | Pass |
| GNU TLS runtime | 24 ordinary and 8 shared programs; exit, allocation, errno and destructor behavior | Pass |
| WABT TLS metadata | 19 fixtures and 18 real linker programs | Pass |
| Existing assembler atomics metadata | 174 native and 174 Chromium cases | Pass |
| Inherited native regression | 33 steps covering 26 inherited suites | Pass |
| Actual SDK plans on native tools | 40 programs, 52 translation units, plus 40 independent reruns | Pass |
| Chromium inherited regression | 856 cases: basic, relaxed SIMD, headers, integration, debug and defaults | Pass |
| Chromium atomics | 70 cases, lifecycle and engine controls | Pass |
| Chromium TLS | 40 cases: 16 shared and 24 ordinary; independent Node execution of all 40 | Pass |
| SDK | 403 frozen files and 366 tests; build and package boundaries | Pass |
| x86 GCC 13.3/16.2 | 8 Chromium compiles, 4 native stdin/stdout programs, cancellation and artifact reruns | Pass |
| Fresh production install | 2,814,741 bytes, 194 files, 4 packages | Pass |

The shared GNU O0/O2 cases execute 4,096 allocator iterations and 516 exact
LIFO destructors per Worker. Cancellation and peer traps discard the entire
cohort; a fresh cohort subsequently completes normal cleanup. Node 18 with
Wasm threads disabled executes the actual ordinary zero-FE TLS artifact and
rejects the shared artifact and request before compiler asset fetching.
Expected abort cases prove actual browser traps; exact pre-trap stdout is
verified independently with Node because the browser rejection API does not
return buffered stdout.

The installed-package cap stays at 2,814,976 bytes / 194 files / 4 packages,
leaving 235 bytes. A fresh install after SDK freezing and full before/after
403-file maps bind that measurement to the tested SDK.

## Package and retained failures

| Manifest | Bytes | SHA-256 |
| --- | ---: | --- |
| Original, unverified | 42,521 | `100a14aea6711056ed4559f91ee374c32ee8f66e71fe38051a4dacc9f1c81a06` |
| Private execution candidate | 42,519 | `be133d999d351e279e5bb2739e166cf3c3089a82db3b61ef58d8813c402ce79e` |

Packaging reopens the native feature/runtime gates and preserves all 94,037
recorded inputs. Its 180 original bundle files remain unchanged. The candidate
changes only `qualification.status` for local execution testing. All eight
compiler/sysroot assets are byte-identical to those used by the final native
production-plan preflight.

The first actual TLS browser run exposed a production-plan mismatch: shared
C++ omitted `-fuse-cxa-atexit`, and `-ffreestanding` suppressed the GNU standard
function declarations used by the runtime fixtures. Two failing regressions
preceded the scoped SDK fix. The fixed TLS-shared profile retains `-fno-builtin`,
uses hosted declarations, and enables GNU destructor registration. Default,
ordinary TLS and non-TLS shared plans remain identical. The final native
preflight uses the actual SDK planner arguments with only filesystem path
translation, and the final browser matrices were rerun on that SDK.

Older failures, the interrupted obsolete-SDK regression and its unchanged
input ledger are retained separately from final acceptance. Targeted errno
and flag diagnostics retain their observed SDK-v2 source snapshot; current
acceptance uses SDK-v3. Historical GCC13 download provenance is retained while
current compiler assets and all fresh execution inputs are independently
reopened.

This profile does not enable pthreads, `std::thread`, exceptions, dynamic TLS,
PIC/PIE, or TLS with embedded debug information. Ordinary debug remains
qualified. Normal return and `exit` drain TLS destructors; abrupt termination,
traps and cancellation do not promise cleanup.
