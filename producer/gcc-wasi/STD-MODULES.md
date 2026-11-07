# Optional GNU standard library modules

The `stdModules` component builds GCC's complete original `std.cc.in` and
`std.compat.cc.in`, each concatenated with the original `std-clib.cc.in`.
It first compiles and runs the native GCC/WASI qualification, then produces
separate BMIs with the actual pinned Wasm-host `cc1plus`. It never uses the
upstream Makefile's empty-interface fallback. The ordinary header bundle and its
existing negative `import std` test remain unchanged.

The initial SDK request is `stdModules: true`, C++, explicit `gnu++23`, `O2`,
and executable output. The profile uses private scalar memory, the new GNU
string ABI, and disabled C++ exceptions and RTTI. User definitions, preprocessed
input, external link inputs, other optimization levels, debug/coverage, SIMD,
atomics, TLS, and shared memory are rejected before optional assets load.

GCC's actual target option `-mexception-handling` is distinct from the disabled
C++ language option `-fno-exceptions`. The former admits the original WASI
`<setjmp.h>` declarations included by the complete GNU interface; it does not
implement GCC SJLJ lowering or the missing `setjmp`/`longjmp` runtime. A real
header/import test compiles and then fails with unresolved `setjmp` and
`longjmp`. These APIs remain unsupported. No feature macro is fabricated and no
SDK `#error` is removed. The internal `_WASI_EMULATED_SIGNAL=1` option is paired
with the exact real SDK signal archive; `signal` and `raise` run in qualification.
The module initializers and tested importer objects contain no EH instructions
or `+exception-handling` feature declaration.

The outer bundle host remains `wasm32-emscripten`. GCC's BMI host identity is
exactly `wasm32-unknown-emscripten`; the separate native proof uses
`x86_64-pc-linux-gnu`. GCC also records the target triple
`wasm32-unknown-wasi`, corresponding to the SDK's `wasm32-wasi` target. Native
BMIs are never browser assets. The actual wrong-host test preserves GCC's checks
and records both host identities in its diagnostic.

Four assets sit outside the eagerly loaded `assets` map:

- `std-modules/std.gcm`
- `std-modules/std.compat.gcm`
- `std-modules/libstdc++modules.a`
- `std-modules/libwasi-emulated-signal.a`

The loader binds compiler JS/Wasm, source/ordered patches, sysroot, ABI/profile,
interface, BMI, and archive-member identities. It copies BMIs and an explicit
mapper into each fresh frontend MEMFS, whose `mmap` GCC can use. The initializer
archive follows user objects and precedes GNU libraries. Ordinary optimized
imports may elide calls to GCC's empty initializers in this profile; a separate
test references the actual generated symbols and proves archive omission fails.
Those functions are actual compiler output, not hand-written stubs.

Reproduce using the existing pinned work directory and base bundle:

```sh
node producer/gcc-wasi/build-std-modules.mjs \
  --bundle /absolute/base-bundle --work /absolute/gcc-work \
  --sdk /absolute/wasi-sdk-33.0-x86_64-linux \
  --output /absolute/new-module-qualification

node producer/gcc-wasi/package-std-modules.mjs \
  --bundle /absolute/base-bundle --modules /absolute/new-module-qualification \
  --work /absolute/gcc-work --sdk /absolute/wasi-sdk-33.0-x86_64-linux \
  --output /absolute/new-module-bundle

node --test producer/gcc-wasi/package-std-modules.test.mjs
```

Both commands reserve new directories. Packaging reopens actual artifacts and
frozen inputs, preserves base payloads and license notices, and writes an
unverified manifest. Actual Chromium SDK Worker qualification is still required.
A private qualification candidate records its temporary status fields and hashes
separately; it is not a publication or public verification bypass.
`loading-sizes.json` separates initial payload totals from optional raw/gzip/
Brotli bytes and records the manifest-only initial overhead.
