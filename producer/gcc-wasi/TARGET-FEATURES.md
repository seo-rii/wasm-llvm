# SIMD target feature metadata

The locked WABT fork now emits `+simd128` when it actually writes a SIMD opcode
or a `v128` type. It emits `+relaxed-simd` as well for the relaxed SIMD opcodes in
this pinned revision. Enabling an assembler/compiler option alone does not add
these declarations. GCC's existing scalar and GNU-vector code generation is
unchanged; this patch does not add relaxed SIMD code generation to GCC.

`patches/wabt-0001-simd-target-features.patch` wraps the binary writer's opcode
and type emission methods. It never searches raw output bytes: `0xfd` in an
integer/floating-point immediate, a data segment, or another custom section
cannot enable SIMD metadata. A `v128` local, parameter, result, or global still
requires SIMD even without a SIMD instruction in its function body.

Explicit input `target_features` declarations are preserved, identical entries
are coalesced, and conflicting `+`/`-` declarations fail assembly. An actual SIMD
use also conflicts with an explicit prohibition. Invalid counts, prefixes,
UTF-8 names, truncated fields, and trailing bytes are rejected. The output has
at most one feature section. `producers` is emitted after linking/relocation
sections, and `target_features` follows it, as required by the LLVM object reader
and [WebAssembly tool conventions](https://github.com/WebAssembly/tool-conventions/blob/main/Linking.md#target-features-section).
Automatic inference is limited to SIMD; the patch preserves other explicitly
supplied feature declarations.

Metadata is not a replacement for instruction decoding or engine validation.
The SDK continues decoding actual instructions/types and validating executable
Wasm. Its regressions for data and integer/floating-point immediates containing
`0xfd` remain unchanged.

## Source and packaging checks

`sources.lock.json` pins the WABT commit, ordered patch hash, complete patched
source diff, and PicoSHA2 gitlink. `prepare-source.py --component wabt` accepts
only that source state, including clean, pinned submodule inputs. Its default
GCC invocation and GCC receipt shape are unchanged.

`build-wabt.sh` applies/verifies the locked source and records source identity,
recipe hashes, and output hashes for both native and Emscripten builds. It
rechecks its inputs before writing each successful receipt. `package.mjs`
requires the exact WABT source/recipes and actual assembler bytes, and includes
the assembler patch and recipes in package provenance. Existing GCC, runtime,
and qualification gates remain enforced.

A WABT-only qualification may reuse an unchanged GCC compiler, linker, and
sysroot. The 2026-10-30 browser candidate was an explicit copy of the qualified
C8 bundle with its assembler assets/hashes and assembler receipt updated. It
was **not** a fresh `packageWasi` output. The old compiler build receipts were
retained as historical inputs and were not rewritten to claim the new complete
source lock. A distributable full bundle must still pass the ordinary package
gates with current receipts and qualification evidence.

## Qualification on 2026-10-30

The [machine-readable summary](../../docs/gcc-wasi-target-features-20261030.json)
records source/tool/artifact identities and complete receipt hashes.

| Check | Result |
| --- | --- |
| Actual native WABT assembly | 31 WAT profiles × module/object = 62 cases |
| Actual Chromium assembler Worker | Same 62 cases; successful bytes identical to native output |
| Positive WAT profiles | 18, including scalar raw-`0xfd`, `v128` types, SIMD, relaxed SIMD, and existing metadata |
| Rejected WAT profiles | 13 malformed/conflicting metadata profiles, in both output modes |
| Actual native GCC → WABT → LLD → Node WASI | 6 programs at `-O0` and `-O2` |
| Actual Chromium GCC/assembler/LLD Workers | 6 programs, 18 assembly/object/executable captures |
| Chromium WASI and independent Node WASI | All 6 browser-produced programs passed on both hosts |
| Source/package/metadata inspector tests | 25 passed |
| Unchanged SDK WASI/decoder tests | 34 passed |
| Existing indirect table relocation regression | Native and Wasm-host objects identical; linked result 42 |

The GCC profiles print `253 253\n` for scalar code (both with SIMD disabled and
with SIMD enabled) and `42 42 42 42\n` for vector addition. Scalar objects and
linked programs have no `+simd128`; vector objects and linked programs do.
The SDK's independent decoder agrees. Native `wasm-validate --disable-simd`
accepts scalar programs and rejects vector programs. LLD rejects an actual SIMD
object when the allowed feature set excludes SIMD or another object explicitly
prohibits it. Chromium was `156.0.8078.4`; Node was `24.22.1`.

The pinned native WASI SDK 33 LLD 22.1.0 rejects relocatable `v128` global
initializers with `invalid opcode in init_expr: 253`. This is an explicit
expected linker failure in the WAT regression; both assembler hosts and engines
accept the standalone module. It does not affect the tested GCC programs,
which use the backend's existing linear-memory globals.

## Reproduction

Build the two assembler hosts in a new work directory. The script fetches the
locked source if it is absent; do not point it at another task's source tree.

```sh
export GCC_WASI_WORK_DIR=/path/to/new-wabt-work
export GCC_WASI_EMSDK=/path/to/pinned-emsdk-6.0.0
export GCC_WASI_WABT_JOBS=2
bash producer/gcc-wasi/build-wabt.sh all
python3 producer/gcc-wasi/prepare-source.py --component wabt \
  --source "$GCC_WASI_WORK_DIR/wabt-source"

node --test producer/gcc-wasi/prepare-source.test.mjs \
  producer/gcc-wasi/package.test.mjs \
  producer/gcc-wasi/inspect-target-features.test.mjs
```

The native compiler and its receipt must match the locked GCC patch set; the
runtime directory contains `sysroot/` from the existing qualified build.

```sh
node producer/gcc-wasi/test-target-features.mjs \
  --compiler /path/to/native-gcc/gcc \
  --compiler-receipt /path/to/native-build.json \
  --runtime /path/to/runtime \
  --work "$GCC_WASI_WORK_DIR" --sdk /path/to/wasi-sdk-33 \
  --output /path/to/new-native-qualification

GCC_WASI_PLAYWRIGHT_PROJECT=/path/to/wasm-idle \
GCC_WASI_CHROMIUM=/path/to/playwright-chromium \
node producer/gcc-wasi/test-wabt-browser.mjs \
  --native-qualification /path/to/new-native-qualification/qualification.json \
  --output /path/to/new-wabt-worker-qualification.json

GCC_WASI_WASM_LD=/path/to/wasi-sdk-33/bin/wasm-ld \
node producer/gcc-wasi/test-wabt.mjs
```

For assembler-only SDK qualification, copy a matching GCC bundle to a new
candidate directory, replace `as.mjs` and `as.wasm` with the newly built files,
and update `assets.asJs`/`assets.asWasm` byte counts and SHA-256 hashes in
`gcc-toolchain.v2.json`. Copy the new assembler `provenance.json` over
`provenance/assembler-build.json` and update that provenance entry's identity.
Keep `qualification.status` as `unverified`, preserve the original compiler
receipts, and record the base manifest plus unchanged compiler/linker/sysroot
asset identities separately. The SDK harness below verifies actual asset
hashes, the matching native/browser GCC source identity, and the new assembler
receipt against the current lock and build recipes.

```sh
node producer/gcc-wasi/test-target-features-worker.mjs \
  --sdk-root /path/to/wasm-idle-with-built-core-and-gcc-packages \
  --bundle /path/to/assembler-only-candidate \
  --native-qualification /path/to/new-native-qualification/qualification.json \
  --work "$GCC_WASI_WORK_DIR" \
  --output /path/to/new-sdk-worker-qualification
```

This dedicated SDK harness distinguishes a compiler flag that permits SIMD from
actual SIMD use. It keeps the compiler option, object metadata, native object
disassembly, linked metadata, SDK decoder, engine validation, and both WASI
execution results as separate checks. All receipts require unchanged inputs;
failed runs remain failed evidence and are not substituted for successful runs.
