# GCC/WASI embedded DWARF4 qualification

The experimental GCC 17 source21 profile generates genuine embedded
DWARF32/DWARF4 at `-O0` for `wasm32-wasi`. Source21 denotes twenty-one locked
local patches. The compiler host is separately built as native executables and
Emscripten Wasm modules. The [machine-readable evidence](gcc-wasi-dwarf-20261103.json)
records source, compiler, assembler, runtime, consumer and artifact identities.

| Route | Core programs | Runtime and consumer checks |
| --- | ---: | --- |
| Native GCC | 11 / 15 translation units | 11 normal and 10 trap runs per Node WASI/Chromium host; 18 source frames, 14 frames with 38 named variable locations |
| Chromium public SDK Worker and Node SDK module adapter | 22 | 22 normal public Worker and 22 Node WASI runs; 20 traps per Node WASI/separate Chromium CDP host; 36 source frames, 28 frames with 76 named variable locations |
| Inherited Chromium compiler Worker matrix | 1,734 | 1,734 Chromium and 1,734 same-artifact Node executions; strict object, ABI, opcode, linking and diagnostic controls |

The public debug matrix additionally checks four debug+coverage/SIMD programs,
four assembly outputs, four object outputs, four debug-object link compositions,
sixteen default/false pairs and twenty-eight rejected requests. Both compiler
hosts reach actual Wasm local indices 127, 128, 16383 and 16384. TI/TF values use
two actual i64 locations with `DW_OP_piece`; stack objects use a stable initialized
frame local. C/C++ main ABI cases, duplicate source basenames and static names,
24-byte records, templates, RTTI and constructor/destructor execution are covered.

The 36 public live-frame records include eight with empty variable sets. Only
28 contain checked named values; struct members and frame bases do not inflate
the 76-location count. For example, an original program traps at
`/workspace/right/provider.c:7`, where official source lookup and retained
runtime state agree on `input=23`, `adjusted=34`, `local=57` and the record member
`wide=0x1122334455667788`.

GCC's ordinary DWARF emitter supplies source files, lines, types, ranges and
locations. The pinned WABT transports typed custom-section slots, code anchors
and standard Wasm relocations. Qualification uses official LLVM consumers and
actual runtime PCs, indexed locals and linear memory. The fixture inspector is
bounded to these cases; it supplies no replacement compiler or general debugger.

The pinned LLVM symbolizer can prefer name/export symbols over a correct DWARF
function name. Official `llvm-objcopy` removes only `name` and `EXPORT` from an
analysis copy, whose CODE/debug payloads are checked byte for byte. The original
module is executed, and original-module `llvm-dwarfdump --lookup` independently
checks the source position.

## Public SDK methodology

The actual Chromium path uses the production SDK Worker. Node 24 cannot import
the SDK loader's Blob module URL directly, so the Node qualification adapter
checks the exact verified Blob bytes against the pinned physical module before
importing that same module. The production loader is unchanged. Node adapter
results are recorded separately from the Chromium public Worker route.
Assembly output is independently assembled by native WABT for inspection;
actual SDK object/executable production uses the Wasm-hosted assembler.

All original fixture source and header bytes remain unchanged. The frames
fixtures use quoted `record.h` includes from provider subdirectories. The
public SDK exposes no arbitrary include-flag API, so its adapter supplies exact
same-hash header copies in those directories and records the complete workspace
separately from the original fixture identities.

Packaging emits the immutable original manifest with
`qualification.status: unverified`. To exercise `debug: true`, whose API guard
requires a verified capable bundle, the private test candidate changes only
that status string. The original and candidate hashes, exact changed byte range
and all 106 identical payload identities are retained. Actual new compiler
bytes then pass the full matrix. No manifest was published or promoted.
The original manifest SHA-256 is
`a9fc5b34ff636caea462f2774b004d38a9b3e8870e820e85a2f0bd3ab85845e9`.

## Gates and preservation

The complete native DWARF package gate passes sixteen tests with no skips.
It reopens 1,639 files and reruns official consumers. Rehashed incorrect PCs and
corrupt coverage data fail the actual source/counter checks. The ordinary
producer suite passes 162 tests with four optional integrations skipped;
thirteen rejection cases overlap the separate sixteen-test gate.

The native matrix also contains fourteen release/optimization/strip controls,
twenty-eight debug-format diagnostics and two debug+coverage/SIMD combinations.
Across six release fixtures, 21 of 24 raw pairs are identical and all 24 match
after normalizing only complete import declaration ordering. Earlier repeated
compiles show that the source20 baseline and source21 compiler both produce
three raw import orders; this is not claimed as 24 raw-byte-identical pairs.
All 25 inherited native suites pass with the original fixture identities.
Their audit verifies 19,828 frozen inputs and 27,232 qualified output files.

The inherited Worker inspection verifies 1,504 objects, 1,504 WAT artifacts,
382 object signatures and 979 required-opcode checks. It also passes 592 raw
diagnostics, strict alias/link/assembler controls, 480 weak-reference mixed-object
programs and 88 RTTI mixed-object programs per Chromium/Node host. The final
snapshot reopens 4,022 captured inputs with the original manifest unchanged.
These additional mixed-object checks are separate from the 1,734 main-suite count.

The actual public debug evidence contains 449 top-level command records, including
Git, Node and pinned native/LLVM consumers, plus 98 compiler
result snapshots, 818 declared inputs and 314 artifacts. Independent inspection
reopens 1,133 paths and confirms exact source/workspace and artifact bytes. Both
compiler hosts contribute eighteen source-frame records, fourteen named-value
frames and thirty-eight named locations.

The SDK implementation has a passed 188-test GCC run and isolated type/build
checks. That run precedes replacement of the fixture data with a genuine GCC
object; the subsequent focused 21-test parser run passes on that fixture.
Source/dist binding ties the implementation to
`3bf70596c49cd91067f21eacdb9c30e7ff2edd01`. The 36 package guards also pass. The exact offline
consumer install has four packages, 182 files and 2,723,557 bytes, growing 2,235
bytes in the paired measurement. The reviewed GCC allowance is 2.5 MiB + 101 KiB
with 1,307 bytes of headroom; the aggregate allowance is 40 MiB + 700 KiB.
Aggregate installation size is not measured. Fixture files are not published.

Existing x86 GCC 13.3 and 16.2 payloads remain unchanged: eight public Worker
compile cases, four native ELF runs, twenty-four raw frontend controls and eight
debug-option rejections pass on the current SDK source.

## Bounds and CI status

The SDK profile is explicit `debug: true`, a verified capable bundle and `-O0`.
Omitting optimization selects zero; explicit nonzero optimization is rejected.
Omitted/false debug retains the ordinary request behavior. Optimized register
locations are unavailable. Split/compressed/external DWARF, DWARF64, alternate
debug formats, native CFA unwinding and a general debugger UI are outside this
profile. See [the implementation and reproduction contract](../producer/gcc-wasi/DWARF.md).

The SDK specialized CI family has the pre-existing Lean 4 invalid-program
instability recorded locally as BUG-013. [One observed attempt](https://github.com/seo-rii/wasm-idle/actions/runs/41574115860/job/125713787938)
emits the expected HAdd diagnostic and then `unreachable`/`Aborted()`;
[a second](https://github.com/seo-rii/wasm-idle/actions/runs/41574115860/job/125718211294)
emits the same diagnostic and then a memory-access trap. The
[passing parent](https://github.com/seo-rii/wasm-idle/actions/runs/41470540261/job/125363161052)
uses the identical Lean Wasm. Tested Lean/core/runtime-worker/playground trees,
asset lock and workflow are unchanged; compared runner/Node/Chromium versions
also match. Historical October jobs already show the same pinned-asset failure.

A bounded local raw compiler/Worker probe executes one valid and three invalid
programs with the pinned assets and original memory/argv/library settings. The
valid run exits zero, all three invalid runs produce the proper diagnostic and
exit one, and no trap is observed. This probe substitutes direct loopback Worker
routing for the full SDK/UI and uses fresh cases rather than the CI history;
observers can affect timing. Four normal local runs do not exclude the known
intermittent CI failure or establish a fix. No Lean source change or relaxed
assertion is part of these PRs.

The [final retry of the unchanged SDK job](https://github.com/seo-rii/wasm-idle/actions/runs/41574115860/job/125734699601)
passes on the recorded implementation. BUG-013 remains open; this is a successful
CI retry, with no Lean fix or inferred failure frequency.
