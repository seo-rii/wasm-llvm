# wasm-idle Asset Contract

`wasm-idle` consumes only the finalized asset tree from this repository. The boundary is:

```text
ldc-wasm/dist/wasm-idle/
  runtime-manifest.v1.json
  ...
```

The manifest is versioned and all runtime files must be referenced through an `asset` string inside
the manifest. Asset paths are relative to `dist/wasm-idle/`, must not be absolute paths, and must not
contain `..` path traversal.

Required initial assets:

- `bin/ldc2.wasm`: browser/WASI-hosted LDC compiler executable.
- `etc/ldc2.conf.tar.zst`: compiler configuration directory for bundled imports and target
  libraries.
- `lib/imports.tar.zst`: D import tree required by the compiler.
- `lib/runtime-libs.tar.zst`: target druntime/Phobos libraries plus the WASI libc, startup object,
  compiler-rt builtins, libunwind, and emulated WASI support libraries needed by the final linker.

`wasm-idle` may copy these files into its own runtime distribution, but the build and porting logic
that creates them must stay in `ldc-wasm`.

The generated config is relocatable. The default WASI mount contract is:

- unpack `etc/ldc2.conf.tar.zst` under `/toolchain/etc`;
- unpack `lib/imports.tar.zst` under `/toolchain/imports`;
- unpack `lib/runtime-libs.tar.zst` under `/toolchain`.
