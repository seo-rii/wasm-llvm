# GCC/WASI atomics qualification

The source24 native compiler, same-source Wasm-host compiler, GNU libatomic,
native contention matrices, patched assembler checks and all 32 native regression
steps, packaging, 70 actual SDK/browser feature cases and all 856 inherited
browser regression cases pass.
This file records local work for [wasm-llvm issue 69](https://github.com/seo-rii/wasm-llvm/issues/69);
no compiler bundle has been published.

The complete local evidence index is `out/issue69/final-qualification.json`.

The implementation and reproduction contract is in
[ATOMICS.md](../producer/gcc-wasi/ATOMICS.md). It adds explicit native 1/2/4/8-byte
atomic operations, the original GNU libatomic for generic/16-byte operations,
and an opt-in SDK shared-entry contract. General pthreads, C++ threads, TLS and
exceptions remain separate work.

## Final source and compiler identities

| Input | SHA-256 / revision |
| --- | --- |
| GCC source commit | `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` |
| Patch 0023, native atomic backend | `7a50977ea5b3e57fbec42c0e3c9991caa3484b10c74ea7785fe2a5ed9a0d7ee1` |
| Patch 0024, GNU libatomic target port | `6afa13f25abb4acb9c044cf69eb3f2152a8c80fdda8dd6fa795d869dd397aac8` |
| Complete GCC24 source diff | `9a0df28c195c217078ff958f95d969902c73b745efc862ea18f58011ecca61da` |
| Source lock | `80264f74b0b1e71da661bb44aff1bc802f559d033cea242e036ecde783358d1f` |
| WABT patch 0004 | `3cd0f2ea128487a63dfd3e8de03ee5e1a85a926e8197036523325dc8f0c0ab43` |
| Complete WABT4 source diff | `3108bd7a2f97cd50ec7ee4787b32a0d8421e52d189d4ff63fd384c2ba16b004b` |
| Native build receipt | `cb8c2a0c7518065554061cf9c887d38079fc325cf45f67b15b6053995fc3fa19` |
| Wasm-host build receipt | `64acc45835f79ed73816c158fe0d03353c2bcf3de63e6ba082931bd5ba24dfc0` |
| Wasm-host `cc1.wasm` | `d223657d967a6d4928225473cce49381f6d474dcfe06259026ef26c16ff1b728` |
| Wasm-host `cc1plus.wasm` | `6d10e47941fc7899eacdeaac4a6d0e87e8871817dfeef81f013dc7bb76ea9bfb` |

The Wasm-host build preserves 3,299 recorded inputs and uses the same GCC source
identity as the native compiler. Its C and C++ compiler payloads contain
15,772,989 and 17,432,241 bytes, respectively. WASI SDK 33 and the pinned
Emscripten host dependencies are source-independent imports; compiler-dependent
GNU runtime archives are rebuilt.

Packaging reopens and reruns the native atomic and GNU runtime gates, preserves
all 21,606 recorded inputs, and leaves its 138 original files unchanged. The
original manifest remains `unverified`. The separate private execution
candidate changes only `qualification.status`; it is not a publication.

| Packaged manifest | Bytes | SHA-256 |
| --- | ---: | --- |
| Original | 34,604 | `4a0489846c59cb80e597282aa25a56913eca2d4808aaa0970f96d8a71be07f3a` |
| Private candidate | 34,602 | `415fbe68c2ab3f25f2dcebcd31ce615315711393dc3ae35e97e15dc0d7ef1937` |

The candidate advertises explicit atomics and shared memory while retaining
`threads: false`. Its runtime list contains the existing compiler builtins and
the one canonical GNU libatomic provider. The package job exits zero; evidence
is in `out/issue69/package-v1-status.json` and `out/issue69/bundle-v1`.

## Completed feature checks

| Check | Cases / observations | Result |
| --- | --- | --- |
| Actual native driver | 36 cases and 6 optimizer queries | Passed |
| Native shared contention | 16 base cases and 4 optimizer override controls | Passed |
| GNU libatomic | 28 serial and 16 shared executions | Passed |
| C/C++ standard atomic headers | 8 native compilations; 4 ordinary and 4 shared SDK executions | Passed |
| Native WABT metadata and encoding | 174 module/object cases | Passed |
| Chromium 156 WABT Worker | 174 cases with native byte parity | Passed |
| Package admission and native gate unit checks | 61 tests | Passed |
| Complete native regression chain | 32 steps, including 26 inherited suites | Passed |
| Package reopens and private candidate | 21,606 unchanged inputs; 138 original files | Passed |
| Frozen SDK | 314 tests, type/build/package checks | Passed |
| Legacy x86 GCC 13.3 / 16.2 | 8 Chromium compilations, 4 native ELF stdin/stdout runs, AVX2/FMA and cancellation | Passed |
| Actual Wasm-host compiler and SDK | 38 shared and 32 ordinary browser executions; 32 Node WASI executions | Passed |
| Inherited actual browser regression | 856 cases, each executed on Chromium and Node | Passed |

The native shared matrix uses two actual Workers for every program. It covers
all four native widths in C and C++ at `-O0`/`-O2`, high-bit ticket windows,
failed-CAS expected updates, all operation families, ordinary-memory publication
and 2,560 sequentially consistent litmus rounds. The oracle requires observed
interleaving, preserves complete ticket witnesses and checks every captured
memory snapshot. Schedules and valid litmus outcomes may differ between runs.

GNU libatomic is built through its real configure and make path. Its 65 objects
provide 97 public symbols; only the ordinary libc memory routines remain
external. Shared cases include sized/generic 16-byte operations on the same
object, a range crossing the lock-hash wrap, a range covering every lock and
overlapping critical sections. Source/object/archive and execution reopens both
pass. A fresh build reproduces 59 object assemblies directly and six after the
existing complete-import-declaration-order normalization; all 44 final programs
reproduce their original bytes and rerun successfully.

The final native gate is `out/issue69/backend/native-qualification-v2.json`,
SHA-256 `da44e6133f5f92f2931c80562ad2010f7d9f28ed7c73d5299da41e6488bb7f5e`.
The final GNU execution gate is `out/issue69/libatomic/execution-v3/qualification.json`,
SHA-256 `4decfbc51eed3846d65ff5677b570f8a258953de6125437450b70c166df9c55b`.
Package admission must actually reopen both with the caller's current source,
native build, SDK and runtime context before advertising atomics/shared memory.

## Corrections retained in the final implementation

Actual driver tests cover enabled/default/disabled option ordering and assembler
forwarding. Known misaligned addresses are diagnosed without treating an
unknown runtime pointer as proof of alignment. High-bit narrow CAS values use
consistent extension. GCC's 8-byte machine word in this Wasm target is distinct
from its 4-byte pointer; GNU libatomic's generated configuration preserves that
distinction and uses explicitly 32-bit lock words.

The shared tests exposed ordinary loads moving across atomic synchronization
under IPA-reference analysis. A minimal native GCC reproduction confirmed the
same optimization interaction. The atomics target now disables this analysis
at normal and function-specific option boundaries; the fixture keeps ordinary
memory. The baseline compiler profile remains unchanged.

An empty final `cc1plus` specs section could reach GCC's end-of-buffer parsing
path. Native, GNU C++ and coverage build recipes now clear the original section
with the supported `%rename cc1plus gcc_wasi_original_cc1plus` directive.

Independent SDK review reproduced an overly broad start-function opcode
allowlist: an unguarded `memory.fill` could erase memory on a second
instantiation. The actual linker initializer was not shown to have that bug.
SDK admission now verifies the guarded one-time initializer structure and ranges.
The reset reproduction is rejected, 36 actual native fixture programs are
admitted, and 314 SDK tests pass. The final SDK receipt is
`sdk-validation/sdk-frozen-v2.json` in the consumer worktree, SHA-256
`4eaf4d683ff575931f3311bee679585b067376ceebeccd092adc56c90dddb3a5`.
It binds 395 source/distribution/test/package inputs with aggregate SHA-256
`cc5e9463c0bd921253ceba17ee114c097e83412809173cbe2013f095cc896fbd`.

Earlier source24-v1/v2 builds, intentionally stopped regressions and partial
browser build outputs remain separately preserved. They are not acceptance
evidence for the final source identities above.

The final regression runner completed 30 steps before its DWARF harness rejected
the `/tmp` location: that harness explicitly requires a short private `/data`
directory. The 30 successful reports and their original input closure were
reopened unchanged. DWARF and the unexecuted relaxed SIMD suite then passed in
fresh output directories with that environment corrected. The completed chain
is recorded in `out/issue69/regression-native-final-v1.json`; the failed job is
preserved separately. The final DWARF run uses Chromium 156.

A fresh isolated production install of the packed Core/GCC SDK measures
2,783,253 bytes, 192 files and four packages. The GCC allowance increases by
39 KiB to 2,784,256 bytes and the file allowance becomes 192; the package-count
allowance remains four. The measured install has 1,003 bytes of headroom. The
36 package-budget tests and boundary rejection checks pass. No aggregate
multi-language install is claimed as measured.

## Completed atomic browser qualification

Chromium 156 compiles every new feature fixture through the packaged Wasm-host
GCC, WABT and LLD, then executes the returned SDK artifact. The original 68
fixture requests remain unchanged; two exact retained pragma/attribute source
variants add coverage for function-specific attempts to restore IPA-reference.

| Group | Cases |
| --- | ---: |
| Native-width shared atomics | 16 |
| GNU libatomic shared operations | 16 |
| C/C++ standard-header shared operations | 4 |
| Pragma/attribute override controls | 2 |
| GNU libatomic ordinary WASI programs | 28 |
| C/C++ standard-header ordinary WASI programs | 4 |
| Total | 70 |

All 38 retained shared-memory snapshots pass a separate reopen through their
fixture oracles. All 32 ordinary programs pass exact stdin/stdout checks on
both Chromium and Node. Program, source, request and tool identities are
retained; native-generated programs do not substitute for browser compilation.
The completed job preserves 1,284 inputs and exits zero. Its qualification
SHA-256 is `8e1aa2ed3f568832f0a7a785469b416234fc5e254754302c61d8e835f2827c27`,
and the consumer handoff is `out/issue69/sdk-cohort/handoff-v1.json`.

The actual Node 18 `--no-experimental-wasm-threads` engine runs the baseline
program but rejects the atomic bytes. The SDK planner, inspector and executor
reject that combination before fetching assets. Default Node 18 and Node 24
execute the atomic program successfully. A nonisolated browser creates zero
Workers and fetches zero compiler assets for a shared request.

Cancellation and a peer trap each request exactly one termination per Worker.
Both busy writers stop after about 2.2 seconds in this measured Chromium run;
the SDK promises immediate invalidation and permanent memory discard, not
instant CPU quiescence. A subsequent fresh-memory run succeeds. These lifecycle
controls use actual GCC-generated code and preserve the interrupted cohort's
observations separately from successful program results.

## Completed inherited browser regression

The final candidate passes all 856 inherited cases: 17 basic C/C++ and GNU
runtime cases, 92 relaxed SIMD/control cases, 680 SIMD128 header cases, 56
wide-scalar/vector/GNU integration cases, eight debug cases and three default
option cases. Each compiles through the actual Wasm-host GCC and executes on
both Chromium and Node. Saved output inspection preserves the existing exact
operation, type, ABI, DWARF and output checks, and confirms that atomic
instructions do not appear in any of these requests without atomics enabled.

The job exits zero with all 1,361 wrapper inputs unchanged, including the final
SDK, original package, candidate, fixtures, inspection code and tool dependencies.
Its completed report is `out/issue69/browser-regression-v1/status.json` and the
outer completion receipt is `out/issue69/browser-regression-v1-status.json`.
Together with the 70 new feature cases, this qualifies 926 browser fixture cases
for this exact private candidate. No general thread runtime or new remote
deployment is implied by these results.
