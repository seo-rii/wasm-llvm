# Anonymous bitfields and the Basic C ABI

Patch `0012-anonymous-bitfield-abi.patch` addresses
[issue #93](https://github.com/seo-rii/wasm-llvm/issues/93). The preceding
eleven-patch compiler lays out these records correctly but classifies both as
indirect aggregates:

```c
struct Before { unsigned int :3; signed int value:7; };
struct After  { signed int value:7; unsigned int :3; };
```

Pinned Clang instead passes and returns their four-byte storage as `i32`.
An unnamed bitfield occupies storage without contributing an ABI value. A
record containing one named scalar can therefore qualify as a singleton even
when that scalar's bitfield starts at a nonzero bit offset.

The classifier now ignores unnamed bitfields using `DECL_BIT_FIELD_TYPE`.
GCC layout can clear `DECL_BIT_FIELD` for mode-sized fields, so that flag alone
does not identify every unnamed bitfield. A named bitfield retains its declared
storage type. Its byte offset, bit offset and width must fit inside that storage
unit. Existing checks still require matching record/scalar size, permitted
alignment and exactly one scalar value. Ordinary fields must still start at
offset zero. Nested single-element arrays and records use the same rules.

Calls carry the record's raw storage, including the named field's original bit
position. The patch does not change record layout, shift the named value to bit
zero, or treat packed or over-aligned records as universally direct.

An anonymous-only record has an empty ABI even when its storage size is nonzero.
The old dummy `SImode` return location could conflict with its actual `QImode`
or `TImode` storage and trigger `emit_move_insn` assertions. Only `BLKmode` now
needs a dummy mode. ABI-empty results have no hard Wasm return local; their
internal storage remains in ordinary pseudos. This also preserves existing
aligned empty C++ behavior without adding generic GCC return-expansion changes.

## Qualification contract

[`anonymous-bitfield-fixtures.mjs`](anonymous-bitfield-fixtures.mjs) contains
20 profiles at `-O0` and `-O2`. Every fixture runs in all four caller/provider
directions: GCC/GCC, GCC/Clang, Clang/GCC and Clang/Clang, for 160 executions.
The suite includes:

- Unnamed fields before and after a named field; short, int and long-long
  declared storage types; and mode-sized unnamed fields.
- Packed records both smaller than and equal in size to their scalar storage,
  over-alignment, two named fields and zero-width allocation boundaries.
- Single-element array and record wrappers.
- Anonymous-only QI, HI, DI and aligned TI storage.
- Direct calls, volatile function pointers, callbacks, arguments and returns.

Programs verify `sizeof`, alignment, named values and named bit positions using
real stdin/stdout. They never compare uninitialized padding or unnamed bits.
Clang expectations are checked against actual object function types. Both
caller imports and provider definitions must match the expected signatures;
strict linking, final program types and execution are checked separately.

The original 136-run baseline produced 82 passes and 54 failures: 32 strict
mixed-link signature failures, 16 GCC/GCC signature failures and six
anonymous-only compiler assertions. The additional 24 HI/DI/TI controls
produced 18 passes and six pre-existing TI assertions. GCC/GCC programs that
failed the signature gate were also executed independently: their correct
output did not establish cross-compiler ABI compatibility.

Existing scalar, SIMD, vector, binary128, int128, empty-record and bitfield
matrices remain separate regression suites. A changed compiler requires a
fresh matching GNU runtime and a native compile/link/execute qualification
before building the Wasm-host compiler from the same source identity.

## Completed qualification

The 2026-10-30 qualification passed **1,769 native matrix executions**: all
160 anonymous-bitfield executions and 1,609 existing regressions. The 13 native
smoke programs and two freshly rebuilt GNU C++ runtime programs also passed,
for 1,784 executions including those prerequisites.

The same-source Wasm-host compiler passed **579 actual Chromium Worker
programs and 579 independent Node WASI executions** across 13 suites. This
preserves the previous 539-program regression corpus and adds the 40 original
anonymous-bitfield source fixtures. Chromium 156.0.8078.4 and Node 24.22.1 used
the frozen wasm-idle SDK commit `9b0b50f23a116fd99bdb7b423bb6e75327ae2959`.

| Worker suite | Chromium / Node WASI |
| --- | ---: |
| Anonymous bitfields | 40 / 40 |
| Empty records | 28 / 28 |
| Singleton bitfields | 8 / 8 |
| Core C/C++ and I/O | 17 / 17 |
| Scalar ABI | 25 / 25 |
| Atomic external-call ABI | 8 / 8 |
| Basic SIMD | 25 / 25 |
| Extended SIMD | 62 / 62 |
| Vector ABI, including disabled controls | 180 / 180 |
| Binary128 long double | 42 / 42 |
| Int128 | 42 / 42 |
| Wide builtins and bitfields | 52 / 52 |
| Floating extensions | 50 / 50 |
| **Total** | **579 / 579** |

Final inspection reopened all programs, 349 saved WAT files and 349 relocatable
objects, and passed 360 function-signature checks and 87 SIMD artifact checks.
All 506 frozen input files remained unchanged. The runtime was imported again
from the pinned SDK archive using the current runtime lock; all 211 sysroot
files and the linker/provenance bytes matched the completed native proofs.

The [completed validation record](../../docs/gcc-wasi-anonymous-bitfield-20261030.json)
binds compiler, runtime, package and Worker identities, individual suite receipts,
loading measurements, and completed private logs. It also preserves the
resolved runtime-receipt and Chromium temporary-path setup attempts. The
manifest retains packaging's `unverified` marker; the separate Worker receipts
attest to the completed browser qualification. No qualification job is pending.

## Reproduction

Follow [the producer setup](README.md#reproduction), using a new isolated work
directory and the pinned SDK and tools. After building the native compiler:

```sh
node producer/gcc-wasi/wide-integer-test.mjs \
  --suite producer/gcc-wasi/anonymous-bitfield-fixtures.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/anonymous-bitfield-qualification"
```

Packaging a compiler with patch `0012` additionally requires
`--anonymous-bitfield-qualification` pointing to that directory's `report.json`.
The gate requires the entire current fixture matrix. It binds source, tool,
header and runtime identities, reopens every object and program, and compares
actual function signatures to the recorded proof and fixture expectations.
A successful JSON status alone cannot satisfy the gate. The receipt is included
as `native-anonymous-bitfield-qualification.json` in the bundle provenance.

Then run the same source fixtures through the actual Wasm-host GCC in the
wasm-idle Chromium Worker, and independently execute the resulting programs in
Node WASI. Native and Worker results, program hashes and exact input/output
belong in the completed validation report; packaging alone does not qualify a
browser compiler.

The ABI reference is the pinned
[Basic C ABI](https://github.com/WebAssembly/tool-conventions/blob/25aceba5adba8f3f7cdbadd8e8705784aebcad6a/BasicCABI.md#function-arguments-and-return-values).
The independent implementation reference is pinned Clang's
[single-element classification](https://github.com/llvm/llvm-project/blob/4434dabb69916856b824f68a64b029c67175e532/clang/lib/CodeGen/ABIInfoImpl.cpp)
and [WebAssembly lowering](https://github.com/llvm/llvm-project/blob/4434dabb69916856b824f68a64b029c67175e532/clang/lib/CodeGen/Targets/WebAssembly.cpp).
