# GCC WASI embedded DWARF

The initial debug profile is embedded DWARF32/DWARF4 at `-O0`. In the WASI SDK,
select `debug: true` with a verified bundle advertising `capabilities.debug`.
Omitting `optimization` then selects `0`; explicitly requesting another
optimization level fails before any tool runs. Omitting `debug`, or setting it
to `false`, preserves the ordinary compilation arguments and default `-O2`.

The compiler flags are `-g -gdwarf-4 -gno-variable-location-views`. Assembly,
relocatable object, and executable outputs retain standard embedded debug
information. Original user sources and headers are passed to GCC unchanged.
This option adds no executable ABI bit, separate debug artifact, or debugger UI.
Existing RTTI, SIMD, and single-counter coverage options remain independent;
their combinations require actual program qualification.

## Information and location model

GCC's ordinary `dwarf2out` and `dwarf2asm` code generates compilation units,
source directories/files, line tables, function ranges, types, and variable
locations. The target serializer carries those bytes through annotated WAT.
The assembler checks typed custom-section slots, code anchors, ownership,
integer widths, and standard Wasm relocations. It does not reconstruct DWARF
from function names or interpret source code.

Locations refer to the actual emitted Wasm parameter/local declarations.
Indices use `DW_OP_WASM_location`; they are not native register numbers or
arithmetic on GCC pseudo-register identifiers. Two-i64 integer/binary128 values
use two real locations with `DW_OP_piece`. A single v128 declaration remains
one Wasm local.

Addressed stack objects use `DW_OP_fbreg` relative to a real initialized frame
local. The frame-base location list starts after its prologue initialization
and ends at the function's exclusive end. It does not read the mutable global
stack pointer. Optimized register locations outside this first profile remain
unavailable rather than being assigned guessed values.

Split DWARF, DWARF64, other DWARF versions, variable-location views, alternate
debug formats, native CFA unwinding, and a general DWARF expression evaluator
are outside this profile. The native target reports unsupported debug requests
explicitly. The SDK exposes the bounded boolean option above.

## Reproduction and packaging

Build the current locked native GCC and WABT, import the pinned WASI runtime,
and build and qualify the same-source GNU C++ and libgcov runtimes first. Use a
fresh output directory and a short private temporary path. The test requires
the pinned LLVM tools from WASI SDK 33, Playwright Chromium, and the WASI shim.

```sh
node producer/gcc-wasi/test-dwarf.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_SYSROOT" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --libgcov "$GCC_LIBGCOV_WORK_DIR" \
  --native-gcov "$GCC_WASI_WORK_DIR/gcc-native/gcc/gcov" \
  --playwright "$PLAYWRIGHT_MODULE" --chromium "$CHROMIUM_EXECUTABLE" \
  --wasi-shim "$WASI_SHIM_DIST" \
  --output "$GCC_WASI_WORK_DIR/dwarf-qualification"
```

The full matrix must pass before packaging with `--dwarf-qualification FILE`.
Selecting `--cases` produces explicitly partial evidence and cannot satisfy
the package gate. Qualification binds the exact source, tool, runtime, header,
and recipe bytes; the gate reopens raw objects, programs, and paused-frame
snapshots and reruns official LLVM consumers. Default/`-g0`, optimized-location,
stripping, duplicate source-basename, wide-value, local-index-boundary, and
unsupported-format controls are separate from successful debug examples.

Node trap stacks and Chromium CDP snapshots provide actual runtime PCs.
Official LLVM lookup/symbolization identifies source functions and lines;
retained indexed locals and linear memory provide the values to compare with
the original fixtures. The bounded fixture inspector is not a replacement
compiler, interpreter, or general-purpose debugger.

For the pinned LLVM symbolizer, name/export symbol precedence can select the
wrong function name even when DWARF source lookup is correct. Qualification
uses official `llvm-objcopy` to remove `name` and `EXPORT` only from an analysis
copy. It verifies byte-identical CODE/debug payloads and executes the original
module. Original-module `llvm-dwarfdump --lookup` remains an independent check.

Packaging still produces an unverified manifest. Native evidence alone does
not qualify the Wasm-hosted compiler: the actual compiler/assembler bundle must
also pass its Chromium Worker and public SDK checks before debug requests are
enabled on a verified manifest.

## Measured qualification

The [native and Wasm-hosted qualification report](../../docs/gcc-wasi-dwarf-20261103.md)
records exact sources, tool/runtime bytes, real source and variable checks,
release/compatibility controls and package measurements. It also documents the
private status-only manifest bootstrap, Node loader adapter, unchanged fixture
header mirrors and the observed pre-existing Lean CI instability.
