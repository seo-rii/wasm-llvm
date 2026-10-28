# GCC empty C/C++ record ABI

Patch `0010-empty-record-abi.patch` fixes the existing GCC/Clang mismatch for
trivial C++ records such as `struct alignas(16) Empty {};`. Object storage is
still 16 bytes; the Basic C ABI omits the empty value from Wasm call signatures:

| Declaration | Wasm signature |
| --- | --- |
| `Empty make_empty(void)` | `() -> ()` |
| `int take_empty(Empty, int)` | `(i32) -> i32` |

`TARGET_EMPTY_RECORD_P` marks the record during layout so generic GCC argument
and result expansion agree with the backend. The generic register-parameter
path must also stop before copying a nonexistent incoming empty value. Without
that second change O0 could read an undeclared argument even when the Wasm
signature had correctly omitted it. No user source is rewritten.

The hook preserves ordinary nonzero-size members, arrays and unions of empty
C++ classes, and nontrivial copy/destructor controls. ABI-ignored empty bases,
`[[no_unique_address]]` members, padding, unnamed bitfields and zero-size fields
are treated according to the selected convention. Empty padding is never read
by the tests; object size/alignment and constructor/destructor effects remain
observable and checked.

The [shared fixtures](empty-abi-fixtures.mjs) contain 14 profiles at O0/O2:
28 browser programs and **112 native runs** across all four compiler directions.
Each profile has two translation units, direct and function-pointer calls,
cross-compiler callbacks, real stdin/stdout and `-DONLINE_JUDGE=23`. The native
harness checks six function signatures per program, 672 total, along with
Wasm linking metadata, imports/exports and one unshared linear memory. The
browser artifacts independently check the provider's imported function types.
See the [completion report](../../docs/gcc-wasi-completion-20261027.md) for the
actual compiler identity and final results.

```sh
node producer/gcc-wasi/test-empty-abi.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --output "$GCC_WASI_WORK_DIR/empty-abi-qualification"
```

Build both compiler hosts and the GNU runtime from the same exact locked source.
Requalify the earlier scalar/vector/binary128/int128 paths after this ABI change.
Packaging requires the current complete proof through
`--empty-abi-qualification .../report.json`; an older compiler's result cannot
qualify the new bundle. From the matching SDK checkout run the real Chromium
harness with `--suite /absolute/path/to/empty-abi-fixtures.mjs` and
`--save-intermediates`. Native mixed-compiler tests do not add external object
inputs to the SDK, and this focused profile does not assert complete ABI
conformance for every C++ class shape.
