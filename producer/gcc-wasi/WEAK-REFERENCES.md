# Weak references and weak definitions

Patch `0018-weak-references.patch` makes external weakref references use the
target's public linking name, type and weak binding. An absent optional function
or data definition has a null address; a provided definition resolves normally.
Ordinary weak declarations and weak definitions are covered by the same native
qualification. A strong definition overrides a weak definition in either object
order, and any direct strong reference to a target makes that target required.
Here `source18` means the experimental GCC 17 source with all 18 locked local
patches; it is not a GCC major-version number.

```c
extern int optional(int) __attribute__((weak));
static int local_function(int) __attribute__((weakref("target_function")));
static int local_data __attribute__((weakref("target_data")));

int use_optional(void) {
  int result = optional ? optional(3) : -1;
  if (local_function) result += local_function(3);
  if (&local_data) result += local_data;
  return result;
}
```

The completed source18 result is **native-qualified-browser-pending**. The
[evidence record](../../docs/gcc-wasi-weakrefs-20261030.json) identifies the exact
compiler source, assembler, fresh GNU runtime, commands and retained results.
Native success does not establish execution of the compiler inside a browser.

## Binding and object contract

The backend collects typed imports under the final target assembler name. It
merges weak and strong uses independently of the declaration used to supply the
type, so a strong use wins in either encounter order. GCC's generic weakref
processing supplies undeclared external targets; the backend emits a public
import without changing the frontend's local weakref declaration. Explicit
assembler names take the same target-resolution path as ordinary names.

The object inspector checks linking-v2 symbol names, function/data kinds,
weak/global binding, definition status, visibility and actual function types.
Each used target needs its actual function-table or data-address relocation;
direct-call cases also need a call relocation. Initialized pointer relocations
and local pointer relocations are checked separately. Unused weakrefs must emit
neither target symbols nor target relocations. No import named after an external
weakref's local declaration is accepted. C++ overloads retain separate `i32` and
`f64` signatures, and explicit assembler labels remain exact.

Clang's defined WASI symbols are hidden by default in these fixtures. GCC's are
default visibility. The qualification records this difference independently of
weak/global binding and uses unchanged source text for both compiler families.

When a weakref's target is defined and locally bound in the same translation
unit, GCC's generic `optimize_weakref` can replace the weakref with a local alias.
The eight GCC C/C++ O0/O2 definition-before/definition-after fixtures therefore
require `ref_f` and `ref_d` to be local, defined aliases sharing the target's
function index or exact data segment/offset/size. A forwarding function or
separate storage cannot pass. The real relocation names remain `ref_f`/`ref_d`
in the receipt. Clang references the defined target directly. This exception
does not permit local alias symbols for external optional targets.

Preserved 17-patch GCC, current 18-patch GCC and Clang controls execute the same
eight forms: 24 strict links and WASI runs all produce `1 1 14 23`. Both GCC
builds keep each local alias on its target's body or storage. Eight separate
host-GCC executions confirm
the generic local-alias behavior; native ELF C++ local names can differ from
their Wasm names. These controls are additional evidence, not extra cases in
the 528-case qualification.

## Native qualification and reproduction

Build the locked source18 native compiler, patched WABT, imported WASI runtime
and a fresh GNU libstdc++ with that same compiler, as described in
[README.md](README.md). Keep those inputs fixed and choose a new output directory:

```sh
node --test producer/gcc-wasi/weakref-fixtures.test.mjs \
  producer/gcc-wasi/weakref-inspect.test.mjs \
  producer/gcc-wasi/weakref-qualification.test.mjs

node producer/gcc-wasi/test-weakrefs.mjs \
  --work "$GCC_WASI_WORK_DIR" --sdk "$WASI_SDK_PATH" \
  --compiler "$GCC_WASI_WORK_DIR/gcc-native/gcc" \
  --source "$GCC_WASI_WORK_DIR/gcc" \
  --sysroot "$GCC_WASI_WORK_DIR/runtime-c/sysroot" \
  --gcc-cxx-sysroot "$GCC_LIBSTDCXX_WORK_DIR/sysroot" \
  --output "$GCC_WASI_WORK_DIR/weakref-qualification"
```

The portable matrix contains 118 GCC and 114 Clang translation units. It covers
C/C++, O0/O2, initialized pointers, local addresses, direct calls, absent and
present providers, multiple translation units, both strong/weak encounter orders,
both strong-override link orders, assembler labels and C++ mangling/overloads.
The GNU cases use real vector/string/I/O operations with fresh source18
libstdc++; optional providers come from both GCC and Clang.

| Suite | Translation units | Cases | WASI executions | Link rejections |
| --- | ---: | ---: | ---: | ---: |
| Ordinary weak/weakref and definition overrides | 80 | 240 | 224 | 16 |
| GNU runtime | 12 | 12 | 12 | 0 |
| Declaration/definition boundaries | 88 | 156 | 140 | 16 |
| Named address and direct-call sites | 52 | 120 | 104 | 16 |
| Total | 232 | 528 | 480 | 48 |

Every link uses `--fatal-warnings`. All 480 successful programs execute with
their exact stdin/stdout contract in Node WASI. The 48 negative cases require
40 missing-strong and eight duplicate-strong linker failures, the expected
function/data diagnostics and no output executable. A compiler or unrelated
linker failure cannot satisfy a negative case. The core/GNU profiles use the
compiler's default SIMD setting; boundary/named-site profiles explicitly pass
`-mno-simd128`. The exact profile and include order are part of the receipt.

The harness checks current source/patch identities and hashes compilers,
assembler, linker, Node, recipes, headers, archives, original sources, WAT,
objects and executables. It checks all 2,469 recorded inputs/artifacts again
after execution. Source18 GNU build and qualification receipts must match the
native compiler; a previous compiler's GNU runtime is rejected.

The first run remains under `out/issue81-qualification/native-v1`. Its inspector
incorrectly forbade the eight valid same-unit GCC local aliases, and URI-escaped
`%3A` output directory names caused the remaining links to fail in wasm-ld.
An otherwise identical link with a safe output path succeeded. The corrected
inspector only admits the exact defined-target local aliases described above,
and filesystem names now use a checked, collision-free alphabet. Source18,
WABT and GNU runtime inputs were unchanged. The complete rerun in `native-v2`
passes all 232 units and 528 cases; the failed attempt is not counted as proof.

All 23 inherited native suites also pass with unchanged inputs and the same
case/diagnostic ID sets as the completed 17-patch baseline. These include the
existing smoke, SIMD, ABI and wide-scalar suites, 106 strong-alias executions,
239 assembler checks, and the target-feature regression. The combined final
receipt contains 24 passed steps, including this weakref qualification. Its
suite-specific counts remain separate because an assembler check is not a
program execution.

## Packaging and browser boundary

Packaging source18 additionally requires:

```sh
--weakref-qualification "$GCC_WASI_WORK_DIR/weakref-qualification/qualification.json"
```

Supply it with all preceding gates, `--native-linker` and the freshly qualified
`--libstdcxx` runtime in the [complete package command](README.md). The gate
checks every fixture and ordered object list, exact compile/include/link
arguments, original source hashes, fixed WASI runner body and runtime stdin/
stdout. It reopens the actual object metadata, signatures and programs, checks
current headers/archives and rejects incomplete, changed or stale proofs.
The actual package-gate preflight accepted the final result after reopening all
2,469 recorded files; packaging and browser execution remain separate stages.

`weakref-worker-fixtures.mjs` defines 148 GCC-only executable cases for the
public SDK. Browser compilation, mixed-object raw linker controls, metadata
inspection and actual Chromium Worker/Node execution remain a separate pending
qualification. Native mixed GCC/Clang success does not replace that stage.

Weak alias definitions (`weak` combined with `alias`) remain rejected. COMDAT,
symbol versioning, shared/dynamic linking, TLS, threads, exceptions and RTTI are
outside this contract. Qualified mixed objects do not establish a general C++
ABI or runtime compatibility guarantee.
