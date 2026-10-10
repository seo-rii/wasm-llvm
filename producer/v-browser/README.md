# V browser producer

This producer builds the real V 0.5.2 compiler for WASI Preview 1 and packages what a browser host
needs to compile and run V programs with an existing Clang/LLD host:

- `v.zip`: the V compiler, built with WASI SDK 33 from the upstream
  [`vlang/vc`](https://github.com/vlang/vc/tree/7eb8c54a3843e5107d5af06d7a8c3e928f322475) bootstrap
  file `v.c`. That file is V's own C translation of
  [`vlang/v@45ae01d`](https://github.com/vlang/v/commit/45ae01d23168b6372f734eeb38a77360bbcf184a);
  the pinned release tag [`0.5.2`](https://github.com/vlang/v/tree/7647ce1c6fad63b5578bc07883139906de74b2f8)
  adds only the changelog on top of it.
- `vroot.tar.zip`: `v/vlib` (the modules listed in `manifest.json`, without tests or examples),
  `v/thirdparty/stdatomic`, and V's `LICENSE`. The compiler finds them with `VEXE=/v/v`.
- `c-sysroot.tar.zip`: the complete wasi-libc C headers and the libraries V programs link from
  WASI SDK 33 (`wasm32-wasi`, byte-identical to the Clang producer's libc), the WASI emulation
  archives, compiler-rt builtins, and the V compatibility headers (`include/v-wasi`) and archive
  (`lib/wasm32-wasi/libvwasi.a`).

Downloads are pinned in `manifest.json`: `v.c` by URL, size and SHA-256, and the V source tree by
commit (shallow single-commit fetch, rejected if dirty). No V source is patched.

```bash
pnpm install --frozen-lockfile
WASI_SDK_PATH=/opt/wasi-sdk-33.0-x86_64-linux pnpm build:v
pnpm verify:v-artifacts
pnpm prepare:v-release
```

`WASM_LLVM_V_BUILD_DIR` overrides the work directory (`out/v-browser-work`),
`WASM_LLVM_V_ARTIFACT_DIR` the checked-in artifact directory (`artifacts/v-browser`), and
`WASM_LLVM_V_RELEASE_DIR` the release directory (`out/v-browser`). Build trees are deleted after
packaging unless `WASM_LLVM_V_KEEP_BUILD=1`. The release directory adds `runtime-manifest.v1.json`
and `runtime-build.json` for a consumer such as wasm-idle; nothing is published through npm.

## Compiler build notes

- The compiler is compiled at `-Os`. Clang 22 `-O2` miscompiles V 0.5.2's checker for wasm32 (for
  example `n := &Node{...}` is then rejected as `mismatched types &Node and Node`); `-O1` and
  `-Os` builds accept it.
- V's builtin `vmemcpy`/`vmemset`/`vmemcmp` treat any address at or below `0xFFFF` as invalid and
  silently skip the operation. wasm-ld places the stack first and data at low addresses by default,
  so both the compiler and V programs are linked with `--no-stack-first --global-base=65536`.
- WASI Preview 1 has no processes, terminals, permission bits or advisory locks. The force-included
  `v_wasi_compat.h` and `v-wasi-compat.c` provide those POSIX entry points: process, pipe and
  descriptor-duplication calls fail with `ENOSYS`; `chmod`/`fchmod` succeed for existing paths
  (wasi-libc's always fail, which breaks V's `os.cp` used for `-o`); `mkstemp` creates a unique file
  with `O_EXCL`; semaphores keep POSIX counting semantics and report `EDEADLK` instead of blocking
  forever in a single-threaded process. These are host shims, not language emulation.

## Acceptance

`scripts/smoke.mjs` runs during the build and its result is embedded in `toolchain.json`. In Node's
WASI host it runs the packaged compiler in the packaged V root on `fixtures/program.v` and
`fixtures/invalid.v`, requires the V diagnostic `main.v:3:1: error: invalid expression`, compiles
the generated C against the packaged C sysroot with the pinned WASI SDK, links with the consumer
flags, and runs the program with UTF-8 stdin, checking its exact stdout and EOF handling.
Verification checks the receipt hashes, archive structure, the accepted compiler hash and
`WebAssembly.compile` of the compiler.

The V compiler and vlib are MIT licensed (see the packaged `v/LICENSE`); wasi-libc and the WASI SDK
libraries keep their upstream licenses.
