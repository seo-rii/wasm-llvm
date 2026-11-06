# Explicit relaxed SIMD

Patch `0022-relaxed-simd.patch` adds the 20 standard WebAssembly relaxed SIMD
instructions through the real GCC target builtins and dedicated RTL `UNSPEC`
patterns. Both `-msimd128` and `-mrelaxed-simd` must be selected. The compiler
default and `-mno-relaxed-simd` keep them disabled; selecting relaxed SIMD without
SIMD128 is an error. Ordinary vector arithmetic and optimization do not select
these relaxed operations implicitly.

The native GCC driver forwards the effective `-mrelaxed-simd` selection to
WABT as `--enable-relaxed-simd`, including when opposing options appear in the
same invocation. `test-simd-relaxed-driver.py` checks this actual driver path
separately from the direct frontend and SDK paths.

The separate `<wasm_relaxed_simd.h>` includes the existing `<wasm_simd128.h>` and
provides the corresponding 20 intrinsic names and types from the pinned LLVM 22
header. The existing 169-name SIMD128 header remains unchanged. Enabled builds
define `__wasm_relaxed_simd__`. FP16 and BF16 extensions are outside this profile.

| Operations | Instruction count |
| --- | ---: |
| Byte swizzle | 1 |
| Signed/unsigned float-to-integer truncation, including zeroed high lanes | 4 |
| Float/double multiply-add and negative multiply-add | 4 |
| Byte/halfword/word/doubleword lane selection | 4 |
| Float/double minimum and maximum | 4 |
| Signed Q15 rounded multiplication | 1 |
| Signed byte/seven-bit dot product and dot-product accumulation | 2 |

## Consumer contract

The SDK requires `simd: true` and `relaxedSimd: true`, a verified bundle with both
capabilities, and a separate engine feature probe. It passes the two compiler
options and adds `--enable-relaxed-simd` to the pinned WABT assembler. Request
omission and old manifests keep the existing scalar/SIMD128 behavior.

The patched assembler records actual `simd128` and `relaxed-simd` target features.
Consumer inspection independently decodes the instructions; custom metadata is
not sufficient. Static link receipts bind the relaxed profile, and direct guest
execution also requires the corresponding manifest and artifact opt-in. A
scalar or SIMD128-only request must reject relaxed instructions even when the
browser happens to support them.

## Results and qualification

Relaxed instructions can have several legal results. Qualification uses explicit
allowed output alternatives for representative boundary values, canonical NaNs, out-of-range conversions,
rounding, mask selection and integer arithmetic. Native Node and Chromium results
are checked independently against those alternatives instead of requiring the
two engines to choose the same legal result. Existing deterministic fixtures keep
their exact stdout checks. Noncanonical and signaling NaN inputs, exhaustive
adjacent-ULP values and every mask pattern are outside this test matrix.

The matrix covers each public operation in C and C++ at `-O0` and `-O2`: 80
enabled executions, eight explicit scalar/SIMD128 controls, four default-profile
controls and 324 disabled/type/invalid-option diagnostics, with actual
stdin/stdout. Generated
WAT, relocatable objects and linked programs are retained and inspected for the
required operations. Each proof binds its sources, compiler, assembler, linker,
headers, runtime, fixture definitions and actual program bytes.

```sh
node producer/gcc-wasi/test-simd-relaxed.mjs \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" --work "$GCC_WASI_WORK_DIR" \
  --sdk "$WASI_SDK_PATH" --sysroot "$GCC_WASI_WORK_DIR/runtime-current/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-relaxed-qualification"
python3 producer/gcc-wasi/test-simd-relaxed-driver.py \
  --work "$GCC_WASI_WORK_DIR" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-current/sysroot" \
  --output "$GCC_WASI_WORK_DIR/simd-relaxed-driver-qualification"
```

Packaging the new compiler requires `--simd-relaxed-qualification` and
`--simd-relaxed-driver-qualification` in addition to every inherited qualification.
The latter binds the actual GCC driver's option forwarding and precedence,
including 20 emitted objects and eight invalid-dependency rejections.
The packager reopens the evidence and verifies
that the header is identical in the source, native installation, browser resources
and packaged sysroot. It retains the full GCC licenses and Runtime Library
Exception. It repeats native compilation and execution. Only the order of
complete top-level GCC import declarations may vary; all other WAT bytes and
the freshly linked program must match. The retained WAT/object/program chain is
also reproduced byte for byte. Successful native qualification does not establish browser compiler
acceptance or change the packaged `qualification.status` from `unverified`.

After native qualification, build the Wasm-host GCC from the same source identity
and execute the same suite through the consumer's actual compiler Worker:

```sh
node "$SDK_ROOT/scripts/verify-gcc-wasi.mjs" \
  --manifest "$PRIVATE_QUALIFICATION_MANIFEST" \
  --suite "$PRODUCER_ROOT/producer/gcc-wasi/simd-relaxed-fixtures.mjs" \
  --save-intermediates --output "$RELAXED_SIMD_WORKER_QUALIFICATION"
```

The original bundle remains unverified while a private qualification manifest
is used for testing. Record their exact identities and payload equivalence.
These commands specify the required checks; completed execution counts and
artifact identities belong in a separate qualification report.
