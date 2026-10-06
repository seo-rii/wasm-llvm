# ECL (Common Lisp) browser runtime producer

This producer builds [Embeddable Common-Lisp](https://ecl.common-lisp.dev/) itself as an
Emscripten ES module. The browser module is the upstream ECL runtime: its reader, bytecode
compiler/interpreter, CLOS, condition system, `LOAD`, Boehm GC and bignums are unchanged upstream
code. Nothing is translated or emulated.

The source pin is ECL **26.5.5** (`74780fa2cd2874889793a657d55b557488d3e346`), LGPL-2.1-or-later,
built with the pinned Emscripten **6.0.0** SDK. No upstream patches are applied.

## Recipe

The build follows upstream `INSTALL` ("Cross-compile for the WASM platform"):

1. A native host ECL of the same revision is configured with `--disable-shared` and installed in
   the work directory. ECL's cross build uses it (`ECL_TO_RUN`) to compile the Lisp core to C.
2. The documented cross configuration runs under `emconfigure`:
   `--host=wasm32-unknown-emscripten --with-cross-config=src/util/wasm32-unknown-emscripten.cross_config
   --disable-shared --with-tcp=no --with-cmp=no`. Upstream adds `-O0`, `-sSTACK_SIZE=1048576` and
   `-sBINARYEN_EXTRA_PASSES=--spill-pointers` (needed for the collector to find stack roots).
   The producer adds `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` so ECL's `setjmp`/`longjmp`
   non-local exits use native Wasm exceptions instead of JavaScript `invoke_*` trampolines, and
   `--profiling-funcs` so the spill-pointers pass can find `__stack_pointer` with Emscripten 6.
3. The upstream libraries (`libecl.a`, `libecl-help.a`, `libecl-cdb.a`, `libeclgc.a`,
   `libeclgmp.a`) are relinked with `src/ecl-browser-main.c`, which is the `main` that ECL's own
   `COMPILER::BUILD-PROGRAM` generates for `bin/ecl` (upstream deletes that temporary file after
   linking). The relink only changes the Emscripten packaging: `MODULARIZE`/`EXPORT_ES6`, `FS` and
   `callMain` exports, no initial run, a caller-owned memory (`IMPORTED_MEMORY`, 64 MiB initial,
   growable up to 2 GiB) and a 16 MiB C shadow stack.

```sh
pnpm install --frozen-lockfile
pnpm prepare:ecl          # pins ECL and emsdk; WASM_LLVM_ECL_EMSDK=/path reuses an activated 6.0.0 SDK
pnpm build:ecl            # host + cross build at -j3 (WASM_LLVM_ECL_JOBS<=3); build trees are deleted
pnpm smoke:ecl            # Node acceptance
pnpm smoke:ecl:browser    # Chromium acceptance in module Workers (ECL_CHROMIUM_EXECUTABLE optional)
pnpm package:ecl          # out/ecl-browser and artifacts/ecl-browser
pnpm verify:ecl-artifacts
```

`WASM_LLVM_ECL_WORK_DIR` and `WASM_LLVM_ECL_OUT_DIR` override `out/ecl-browser-work` and
`out/ecl-browser`. `build --keep` retains the host and cross build trees.

The release contains exactly `ecl.mjs`, `ecl.wasm.gz` (the linked `ecl.wasm`, gzip level 9) and
`producer-receipt.json`; the same files are
committed under `artifacts/ecl-browser/` so consumers can fetch them from an immutable
`raw.githubusercontent.com/seo-rii/wasm-llvm/<commit>/artifacts/ecl-browser/` URL. The receipt
binds the manifest, source tree hash, entry-point overlay, Emscripten version, build script and
asset hashes to Node and Chromium acceptance results whose fixtures and scripts are hashed too.
`receipt.assets` pins the logical `ecl.mjs`/`ecl.wasm` bytes that were accepted, and
`receipt.delivery["ecl.wasm.gz"]` pins the compressed delivery bytes; `verify` decompresses the
delivery and checks both.

## Acceptance

`scripts/harness.mjs` drives the module exactly as a consumer should, and both smokes require:

- `fixtures/stdin.lisp`: `READ-LINE` and `READ` from byte stdin, `FORMAT`/`PRINT` to stdout,
  UTF-8 round trip, bignums, and `READ-LINE` returning the EOF value.
- `fixtures/error.lisp`: an unhandled `ERROR` is reported on stderr and exits with status 1.
- `fixtures/gc.lisp`: repeated collections with live data reachable from the Wasm stack, plus CLOS.
- `fixtures/recursion.lisp`: 100-deep recursion succeeds; unbounded recursion is contained as a
  JavaScript `RangeError` (see limitations).

## Consumer contract

Create a fresh module instance per run, ideally in a fresh Worker:

```js
const module = await createEcl({
	noInitialRun: true,
	wasmBinary,                        // verified, decompressed ecl.wasm bytes
	wasmMemory,                        // WebAssembly.Memory({ initial: 1024, maximum: <= 32768 })
	stdin: () => nextByteOrNull(),
	stdout: (byte) => {}, stderr: (byte) => {}
});
module.FS.writeFile('/work/main.lisp', source);
module.FS.chdir('/work');
module.callMain(['--norc', '--eval', loadForm('main.lisp')]);
```

`loadForm` (in `scripts/harness.mjs`) wraps `LOAD` in `HANDLER-BIND` on `SERIOUS-CONDITION`, prints
`;;; Unhandled <type>: <condition>` to `*error-output*`, and always calls `EXT:QUIT`, so ECL never
enters its interactive debugger and never consumes program stdin. `callMain` ends with an
`ExitStatus` exception carrying the status. Replace the Emscripten stdin device `read` operation
if partial reads are required for interactive prompts.

## Limitations

- Only the bytecode compiler is available (`--with-cmp=no`); `COMPILE` and `COMPILE-FILE` produce
  bytecode. Contrib modules (`REQUIRE` of ASDF, sockets, etc.) are not bundled. No threads.
- The upstream `-O0` code uses large engine frames, so the JavaScript engine's native stack is
  exhausted before ECL's own C-stack guard can signal `STACK-OVERFLOW`. The host observes a
  `RangeError` and must discard the instance. Measured limits for a simple non-tail recursive
  function: about 1000 levels on Node's main thread, but only about 150 levels in a Chromium
  module Worker, where V8's baseline (Liftoff) Wasm frames are much larger; with
  `--js-flags=--no-liftoff` the same Worker reaches 400–1000. Higher C optimisation levels made
  frames larger in earlier measurements.
- `ROOM` cannot report Boehm GC usage, as upstream documents.

Generated artifacts remain under ECL's LGPL-2.1-or-later license (with the bundled Boehm GC and
GMP licenses) and Emscripten's runtime license. Upstream sources:
[ECL 26.5.5](https://gitlab.com/embeddable-common-lisp/ecl/-/tree/74780fa2cd2874889793a657d55b557488d3e346).
