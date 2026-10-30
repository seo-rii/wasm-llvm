# Strong function and data aliases

Patch `0017-symbol-aliases.patch` adds GCC's declaration-aware alias output hook.
The pinned WABT patch implements the corresponding `@sym.alias` annotations.
Two function names share one Wasm function index; two data names share one data
segment, offset and size. Each name retains its own linking symbol, binding and
visibility. No extra function body or copied data storage implements an alias.

```c
int target(int n) { return n + 1; }
extern int alias(int) __attribute__((alias("target")));
int storage = 7;
extern int storage_alias __attribute__((alias("storage")));
```

The target must be defined in the same translation unit. The qualified cases
cover C/C++ at O0/O2, forward declarations and chains, initialized/BSS/const/array/
aggregate data, explicit default/hidden visibility, local symbols, initialized
function/data pointer tables, custom assembler names, and C++ namespace/overload
mangling. Separate caller/provider units observe addresses through volatile
pointers and exercise direct/indirect calls and writes through aliases. The
function ABI controls include i64, float and aggregate arguments/results.

Weak aliases are explicitly rejected by this patch. Optional weak references,
weakref target emission, COMDAT groups and symbol versioning remain outside this
strong-alias contract. This does not expand the existing exceptions, RTTI, TLS,
threading or dynamic-linking profiles. Qualified mixed GCC/Clang cases do not
establish general C++ ABI or runtime interchangeability.

## Object and runtime behavior

The assembler resolves forward chains, rejects cycles, missing/imported targets,
kind mismatches and duplicate alias names, and preserves the selected alias
symbol in code, element and data relocations. Its binary reader/writer round trip
retains multiple names for a function without replacing the primary symbol.
Data offsets, alignment, symbol flags and alias-specific export flags survive
the same round trip. GCC's internal constant-pool alias hook also handles shared
suffixes through bounded data offsets; this is not a public arbitrary-expression
alias syntax.

The GNU runtime recipe now compiles the original `std::type_info::__equal` alias
instead of replacing it with a forwarding function. Qualification extracts the
actual `tinfo.o` member from the rebuilt `libsupc++.a`, verifies that `__equal`
and `operator==` name the same function, and checks both address equality and
comparison results at runtime. This uses `std::type_info` directly with RTTI
disabled and does not claim RTTI support.

## Native qualification

After building the locked native compiler, assembler and fresh GNU runtime,
run the alias gate using new output directories:

```sh
node producer/gcc-wasi/test-symbol-alias.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/symbol-alias-qualification"

python3 producer/gcc-wasi/test-wabt-symbol-alias.py \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --reference "$GCC_WASI_WORK_DIR/symbol-alias-qualification/programs/report.json" \
  --output "$GCC_WASI_WORK_DIR/symbol-alias-assembler-qualification"
```

The native gate requires:

- 26 original source fixtures in all four GCC/Clang caller/provider directions,
  plus two GNU-only runtime controls: 106 actual program executions.
- 24 GCC and 16 Clang rejected compilations. Clang 22 permits the eight
  function/data kind-mismatch declarations, so those are explicitly GCC-only
  negative controls. Syntax-only compilation is insufficient for these checks.
- 16 successful single-provider links and 32 duplicate/undefined-symbol
  rejections across function/data, C/C++, O0/O2 and both compilers. Every link
  uses `--fatal-warnings`.
- Actual linking-v2 symbol and relocation inspection, source/tool/runtime hashes,
  unchanged-input checks, and the original GNU archive alias identity.

The separate assembler script exercises original and round-tripped objects,
alias-selected relocations, strict-link failures and malformed annotations.
Its optional reference report adds each real two-unit provider object to the
round-trip and execution matrix. It also preserves the pinned SIMD target-feature
behavior inherited from `wabt-0001-simd-target-features.patch`.

Packaging requires `--symbol-alias-qualification` alongside every preceding
qualification and a freshly qualified GNU runtime. It binds all compiler
directions to the current source, tools, headers and libraries, then reopens the
objects, programs and archive member. Both alias receipts are included in bundle
provenance. Native results are a prerequisite for building the compiler's Wasm
host; actual Chromium Worker qualification is a separate required stage.

The browser matrix adds the same 28 alias programs to the existing suites. Its
additional checks compile the original providers, inspect their aliases, compare
native/Wasm-host assembler output, reject invalid alias declarations and perform
duplicate/undefined links using the packaged linker. Each successful program
executes in both Chromium Worker and Node WASI. Completed execution counts and
artifact hashes are recorded separately from this reproduction contract.
