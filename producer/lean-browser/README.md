# Lean 4 browser producer

This producer builds the upstream Lean 4 frontend and IR interpreter itself as a wasm32
Emscripten module and compiles the `Init` library with that module. Consumers run programs with
`lean --run` semantics: the file is elaborated by the real Lean frontend and `main` is executed by
the real IR interpreter, with natively compiled `Init`/`Std`/`Lean` code linked into the module.

Pins (see `manifest.json`):

- Lean 4.34.1, `leanprover/lean4@5045d0056413266e57c625dcd7c365b10e377c52` (Apache-2.0)
- official `lean-4.34.1-linux.tar.zst` release (size and SHA-256 pinned) as the bootstrap compiler
- libuv 1.48.0 (`e9f29cb9…`, MIT), fetched by the upstream Lean CMake for Emscripten builds
- Emscripten 6.0.0, `emscripten-core/emsdk@d223ae73c6998296e3ab27cf81dc2c2c9fd383de`

## Build and verify

Prerequisites: Node 20+, Git, CMake, Make, Python 3, curl, zstd, and about 5 GB of free disk.
Every stage uses at most three jobs (`WASM_LLVM_LEAN_JOBS`, 1-3). `WASM_LLVM_LEAN_WORK_DIR`
overrides `out/lean-browser-work`; `EMSDK` may point to an existing Emscripten 6.0.0 SDK.

```sh
pnpm build:lean                 # fetch emsdk runtime cgen objects link oleans
pnpm package:lean               # pack, run the Node acceptance, write artifacts/lean-browser
pnpm verify:lean-artifacts
pnpm smoke:lean
```

Stages (`scripts/build.sh <stage...>`):

1. `fetch` checks out the pinned source, applies `patches/0001-lean-browser-emscripten.patch`,
   downloads the release bootstrap, and checks its SHA-256, version, and githash.
2. `emsdk` installs the pinned SDK. `runtime` configures the upstream Emscripten CMake build
   (`STAGE=1`, `USE_GMP=OFF`, `USE_MIMALLOC=OFF`) and builds the C++ runtime, kernel, shell and libuv.
3. `cgen` emits C for every `Init`, `Std`, and `Lean` module shipped in the release with the
   bootstrap compiler. `objects` compiles that C with `emcc -O2 -fwasm-exceptions -pthread`.
4. `link` generates a sorted symbol table for the IR interpreter (`scripts/gen-symtab.py`; a
   statically linked Emscripten module has no `dlsym`) and links `lean.mjs`/`lean.wasm` with no
   undefined symbols.
5. `oleans` compiles all 649 `Init` modules with the wasm32 Lean under Node. `.olean` files are
   pointer-size specific, so the 64-bit release files cannot be reused. This takes about two hours
   at three jobs.

## Patch

The patch only touches the C++ runtime/shell; Lean sources are unchanged:

- `IO.appPath` returns the fixed virtual prefix `/lean/bin/lean`, so the library is found at
  `/lean/lib/lean` in the Emscripten file system.
- The IR interpreter resolves native symbols from the generated static table instead of `dlsym`.
- C++ definitions whose arities differ from their Lean `@[extern]` declarations are aligned
  (Wasm traps on signature mismatches that native ABIs tolerate).
- Stubs for five libuv TCP/UDP externs missing from the upstream libuv-less build, matching the
  existing "build with libuv" assertions; they are reachable only from `Std.Internal` networking.
- `lean --run` exit codes unbox `UInt32` correctly on 32-bit targets (upstream used scalar
  unboxing, so successful programs exited with pointer-derived codes).
- The upstream `-flto` Emscripten flag is dropped so the runtime archives link with separately
  compiled objects.

## Release

`artifacts/lean-browser` contains:

| File | Contents |
| --- | --- |
| `lean.mjs` | Emscripten ES module factory `createLean` (pthreads, `FS`, `callMain`) |
| `lean.wasm.gz` | gzip of the 113 MB `lean.wasm` |
| `lean-init.index.json` | path/offset table of the concatenated `Init` library and per-chunk digests |
| `lean-init-NN.pack.gz` | independent gzip chunks of 48 MiB library slices (each below 24 MB) |
| `LICENSE`, `LICENSE.libuv` | Lean (Apache-2.0) and libuv (MIT) licenses |
| `producer-receipt.json` | manifest, patch and recipe hashes, every asset's size/SHA-256 (and decoded size/SHA-256), and the acceptance results |

The library contains `.olean`, `.olean.server`, `.olean.private`, `.ir` and `.ir.sig` for every
`Init` module; all parts are read when a non-`module` file imports `Init`. `Std` and `Lean` are not
shipped, so programs may only import `Init` (the implicit default).

Packaging runs `scripts/smoke.mjs`, which unpacks the release into Emscripten MEMFS exactly as a
browser consumer does and runs `fixtures/Main.lean` (UTF-8 stdin to stdout) and
`fixtures/Invalid.lean` (elaboration error, exit code 1). The receipt records both results.

## Consumer contract

Create a fresh module instance per run with `noInitialRun: true`, the decoded `wasmBinary`, and,
in a browser, `mainScriptUrlOrBlob` pointing at the `lean.mjs` URL so pthread Workers load the same
module. The page must be cross-origin isolated (SharedArrayBuffer). Before `callMain`:

1. create `/lean/bin`, and write every index entry to `/lean/lib/lean/<path>`;
2. write the program (for example `/work/Main.lean`), then call
   `callMain(['-j1', '--run', '/work/Main.lean', ...args])` with an absolute path.

The pool holds four pthreads; `-j1` keeps the task manager within it. Importing `Init` grows linear
memory to about 370 MiB, and a run of a small program takes 2-3 seconds in Node. Elaboration
messages are printed to stdout as `<file>:<line>:<column>: <severity>: <message>`.
