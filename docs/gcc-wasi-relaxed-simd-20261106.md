# GCC/WASI explicit relaxed SIMD qualification

The final native feature matrix, driver checks, all 31 native regression steps,
Wasm-host compiler build, packaging and 856 real Chromium compiler cases pass.
The SDK, legacy x86 GCC 13/16 and unsupported-engine checks also pass. This is a
local qualification of the recorded private candidate; no bundle was published.

The implementation adds the 20 standard WebAssembly relaxed SIMD operations to
the actual GCC frontend/RTL backend. It uses a separate public
`<wasm_relaxed_simd.h>` and requires both `-msimd128` and `-mrelaxed-simd`.
The original 169-name SIMD128 header is unchanged. Ordinary vector operations
do not select relaxed operations implicitly. FP16 and BF16 are outside this
profile. See the [implementation and reproduction contract](../producer/gcc-wasi/RELAXED-SIMD.md).

## Bound inputs

| Input | Identity |
| --- | --- |
| GCC author port | `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| Locked GCC patch count | 22 |
| Relaxed SIMD patch SHA-256 | `d979c4dcfd16aa93562912080e9b990f82af868ce408c2b92023f15155bf4e17` |
| Combined GCC source diff SHA-256 | `77e636195f745fa52534da5dc58e7df578c4baa98232fe96a8569c201c531466` |
| `sources.lock.json` SHA-256 | `85c6b69ab9aa44f79237a67bac22cd19cf9289201c0e9f9a8ff1a575a4e71b57` |
| WABT source | `651c9ffbce3d0525d2d1324fab79160e5fcf8173` plus three locked patches |
| WASI SDK / Emscripten | 33.0 / 6.0.0, pinned by the producer |

The completed `bundle-v4` retains its original `unverified` manifest. The private
candidate changes only that status for execution testing; no payload changes.

| Packaged artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Original manifest | 27,677 | `1ace65087a357073bffb6a7bca7067b10ef80777031ad0892d9507ecdf32f0c0` |
| Private candidate manifest | 27,675 | `46d355914d69f4f0d2348db80baa8bc7d3ec446462f7da996e23e63da8d8771e` |
| `cc1.wasm` | 15,751,278 | `17d60ba7936ce48ab444d801ee3ebb0f4552f89b5c98ac939e9e3068c43c9853` |
| `cc1plus.wasm` | 17,410,554 | `073327a7196731e33b5eae378acee809bafcb2eaf237c572366be7ba208a74f8` |
| `sysroot.tar` | 26,163,200 | `0e9e93b172f15a458d10ae8bf16ddf69ac2470957da451885ef0a255dff6b19f` |

The final native and Wasm-host builds, both assembler builds, 13 baseline C/C++ executions,
92 relaxed SIMD/control executions, 324 negative compilations and 28 real
driver checks pass. Their source, tool and input identities remain bound to
the final patch set above.

The inherited SIMD128 header gate also passes its 680 cases, four default
controls and 296 diagnostics with unchanged inputs. This checks the original
169 public APIs after extending the builtin registry. The new GNU runtime passes
five positive programs and its three existing unsupported-feature checks.
All 31 native regression steps pass, including the 25 inherited suites, rebuilt
GNU runtime and libgcov, coverage and DWARF checks. The runner verifies that its
19,800 recorded source, tool, runtime and harness inputs remain unchanged.

All results must cover these final inputs. The source-independent WASI SDK
runtime and Emscripten arithmetic libraries are reused with recorded identities;
compiler-dependent GNU runtime archives and qualification receipts are rebuilt.

The first native feature run passed 92 executions and 324 diagnostics. Review
then reproduced a native driver omission: `xgcc -mrelaxed-simd` did not forward
WABT's enabling option. The final patch corrects `ASM_SPEC`, and a real driver
matrix verifies effective option ordering, object instructions, target features
and the invalid relaxed-without-SIMD dependency. The earlier reports and inputs
remain preserved; they are not acceptance evidence for the final source.

## Native and browser methodology

The feature matrix has 80 enabled programs (20 operations in C/C++ at `-O0` and
`-O2`), eight explicit scalar/SIMD128 controls and four default-profile controls.
It exercises actual stdin/stdout and retains WAT, relocatable objects and linked
Wasm. Another 324 real negative compilations cover disabled profiles, invalid
builtin argument types and the missing SIMD128 dependency.

The output oracle implements the fixed host projections in the
[pinned relaxed numeric specification](https://github.com/WebAssembly/relaxed-simd/blob/c3f9359af2cd607cc46b0a3274f90ea52543a2f2/document/core/exec/numerics.rst).
Node and Chromium outputs are checked independently against whole-program
alternatives. The tests preserve repeated/lane consistency and inspect canonical
NaN payloads before normalization. They cover representative conversion bounds,
signed zero, infinities, fused/unfused rounding and overflow, subnormals, mask
selection, Q15 overflow and signed/seven-bit dot products. Noncanonical/signaling
NaN inputs and exhaustive ULP/mask enumeration are outside this matrix.

The latest oracle was independently checked by 80 real Clang C/C++ compilations,
direct pinned LLD links and Node executions. This establishes an independent
fixture check; it is not GCC qualification. An additional regression covers
finite multiplication overflow followed by an opposite-sign infinite addend,
where fused and unfused results differ.

Packaging reopens source, tool, header, runtime and artifact identities, repeats
the native compilations/assembly/linking, compares produced artifacts, reruns the
programs and repeats the negative diagnostics. Header and full GCC license files
must agree across source, native installation, browser resources and packaged
sysroot. A private browser test manifest changes only `qualification.status`;
the original unverified manifest and every payload remain preserved.
Packaging also requires the separate 28-case driver receipt and repeats it with
the current `xgcc`, assembler, default/overlay specs and installed headers. Both
the original receipt and the successful replay are retained in provenance.
The completed package run verifies 19,945 unchanged inputs and preserves all
111 original bundle files while creating the private status-only candidate.
It also verifies the coverage path with `TMPDIR` unset: the package caller now
passes the actual native-build receipt path required for temporary reanalysis.

GCC can vary the order of complete top-level import declarations between
invocations. A 15-pair replay reproduced seven such changes; all 15 linked
programs were byte-identical. The gate allows only this declaration permutation,
preserving each declaration's complete bytes and multiplicity and every
non-import byte. It also requires byte-identical assembly/link reproduction of
the retained original artifacts and a byte-identical freshly linked program.
Changed instructions, signatures, names, comments, missing/duplicate imports and
unsupported declaration shapes are rejected. The final native receipt binds
this gate and repeats all 92 executions and 324 diagnostics.

Two additional direct frontend smoke tests load the newly built Wasm-host
`cc1`/`cc1plus` modules, compile real C swizzle and C++ multiply-add boundary
programs, assemble/link them and execute them on Node. Both pass; this is an
early frontend check, not Chromium Worker qualification.

## Completed Chromium qualification

The final browser job compiles every fixture with the actual Wasm-host GCC
Worker, assembles and links with the packaged tools, then executes the resulting
program on Node and Chromium. It does not substitute native-compiled programs.
Every saved WAT/object/program is bound to its fixture and toolchain identities.

| Group | Cases | Result |
| --- | ---: | --- |
| Relaxed SIMD and explicit/default controls | 92 | Passed |
| Existing SIMD128 public header | 680 | Passed |
| Basic C/C++ and GNU runtime | 17 | Passed |
| Wide scalar, vector ABI and GNU integration | 56 | Passed |
| DWARF with scalar, SIMD128 and relaxed SIMD | 8 | Passed |
| Omitted feature requests and GNU defaults | 3 | Passed |
| Total | 856 | Passed |

The 82 enabled relaxed cases include two DWARF combinations. All other 774
cases are checked for absence of relaxed instructions. The 92-case feature
matrix additionally verifies each exact operation body in both object and
linked program, all required target features, and rejection by the validator
when relaxed SIMD is disabled. LLVM's pinned demangler binds the linked C++
function name to the complete original object symbol. Both host outputs must
independently belong to the specified allowed result set.

The job's 1,534 recorded inputs, SDK source/distributions, original bundle,
candidate and tool dependency libraries remain unchanged. Its wrapper and all
six groups exit zero. The eight debug cases qualify ordinary DWARF output;
they do not add the separately packaged interactive debugger runtime.

Local evidence is retained under `out/issue72`: `native-relaxed-v5`,
`package-v4-status.json`, `bundle-v4`, `browser-regression-v3` and the final
qualification summary. The complete native regression reports are retained in
`out/regression-native-v2`. Failed and superseded runs are preserved separately.

## Consumer checks completed

The SDK requires explicit `simd: true` and `relaxedSimd: true`, a verified capable
bundle and a separate probe of all 20 engine instructions. It independently
decodes output instructions, binds static input receipts to their selected
profile and reinspects bytes before execution. Old manifests and omitted
requests keep their existing compiler arguments and receipt shapes.

The focused GCC suite passes 196 tests, with TypeScript/build/public-import
checks. Producer package/fixture/inspection/qualification tests pass 46 cases;
the source-preparation tests pass two cases. The stdout alternatives helper has
six passing tests, and the package-budget suite has 36.

A fresh production install of the packed Core/GCC SDK contains four packages,
188 files and 2,743,076 bytes. This is 8,901 bytes above the previous measured
install. Only the GCC allowance changes by 8 KiB, to 2.5 MiB + 120 KiB, leaving
1,244 bytes of headroom. File/package count limits and the aggregate allowance
are unchanged; an aggregate install is not claimed as measured.

The published GCC 16.2 Actions bundle was downloaded with its GitHub archive
digest and all nine manifest asset hashes verified. On the current frozen SDK,
four real Chromium compiler cases and two native ELF stdin/stdout programs pass,
including AVX2/FMA and Worker cancellation. Its manifest SHA-256 is
`3170bee5a1a10f8474eab5d5bdeb6802ddb4c34a624804d6d51fbf8c650af86e`.
The original GCC 13.3 bundle was recovered from an existing local asset cache.
Its manifest matches the previous qualification exactly, and all nine assets
(97,420,243 bytes) pass their recorded size/hash checks. The same four real
Chromium cases, two native ELF stdin/stdout programs, AVX2/FMA and cancellation
checks pass on the frozen SDK. Its manifest SHA-256 is
`4de4c401cabad291caa0eb20ec435bdda336597c7ee25954d95323012b8a0867`.
Both legacy x86 compiler profiles are therefore covered by fresh execution.

Actual unsupported-engine checks use the official checksum-verified Node
18.20.8 binary in an isolated directory. Baseline SIMD and the actual GCC
baseline program validate; relaxed SIMD and the actual relaxed program do not.
The frozen SDK planner, inspector and standalone execution path reject them
with a clear unsupported-engine diagnostic before any compiler asset fetch.
The final unchanged package candidate and native-program receipts are used;
786 input hashes remain unchanged. The same baseline and relaxed programs run
successfully on Node 24.22.1 with permitted stdout. This is an engine-boundary test, not an expansion of the SDK's
supported Node versions or a compiler acceptance test. Installed Chromium 156
supports relaxed SIMD; its obsolete disabling flag did not disable the feature.
