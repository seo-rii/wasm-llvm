# Zig 0.17.0 WASI producer

Build the real Zig 0.17.0 compiler as a WASI Preview 1 core module, using the
self-hosted Wasm backend for normal builds and the pure-Zig LLVM bitcode builder
for source debugging. No LLVM library is linked into the compiler. Source archives
and the native bootstrap are pinned by SHA-256 in `sources.lock.json`. The port is copied from
[`seo-rii/zigc-wasm` at `1588893`](https://github.com/seo-rii/zigc-wasm/tree/158889336da7fd3ff1070fc68da29a42235ee3a9).
Its original license is preserved in `LICENSE.zigc-wasm`. The separately pinned
`patches/llvm-bitcode.patch` enables supported IR-only output and preserves complete
WASI guest source filenames; the base port patch remains unchanged.

## Build and qualify

Requirements: Python 3.10+, Git, Node.js 24, and several GB of memory and disk.
The build script downloads a Linux x86_64/aarch64 native compiler automatically;
other platforms can pass `--zig /path/to/zig-0.17.0`.

```bash
python3 -B producer/zig-browser/scripts/build.py
python3 -B producer/zig-browser/scripts/package.py
python3 -B producer/zig-browser/scripts/package.py --verify
python3 -B -m unittest discover -s producer/zig-browser/test -p 'test_*.py'
```

`build.py` writes intermediates and a raw bundle to `out/zig-browser`.
`--work-dir` and `--output` select other build paths. `package.py` accepts
`--bundle` and `--output`, writes a deterministic full-library archive, extracts
that archive, and runs the actual compiler smoke suite before issuing a successful
receipt. `package.py --verify --smoke` also executes the checked-in package.

The smoke suite covers standard-library imports, u128 runtime helpers, relocatable
and stripped MVP object linking, diagnostics, formatting, streaming stdout, nested
filesystem access, and WASI rights inheritance. IR qualification uses the normal
`-femit-llvm-bc`/`-femit-llvm-ir` API (without verbose developer flags), checks
canonical nested and relative source paths, imported helper functions and local metadata,
and emits the matching `compiler_rt` bitcode. The paired `wasm-idle` integration
additionally checks the real browser Worker and stdin/stdout behavior.

## Consumer artifacts

`artifacts/zig-browser` contains:

- `zig.wasm`: the WASI-hosted compiler.
- `lib.tar.gz`: the complete matching library, with entries under `lib/`, including
  `std/` and `compiler_rt.zig`.
- `LICENSE`: the license distributed with the Zig source release.
- `producer-receipt.json`: source/port/configuration provenance, compressed and
  expanded artifact hashes, and qualification metadata.

Consumers pin an immutable producer Git revision and the receipt hash, then verify
all payloads. No GitHub release or hosting deployment is required to review this
producer. The `wasm-idle` importer preserves its public names `zig_small.wasm` and
`std.tar.gz`; the latter now contains the complete `lib/` tree.

## Runtime contract

Preopen `.` first (fd 3), `/lib` with the extracted library, and a writable `/cache`.
Set `ZIG_LOCAL_CACHE_DIR=.zig-cache/local`; leave `ZIG_LIB_DIR` and
`ZIG_GLOBAL_CACHE_DIR` unset so Zig selects those preopened handles. Serialize invocations sharing caches. Stream descriptors must return WASI `SPIPE` for
unsupported positional I/O so Zig can fall back to streaming.

```bash
node producer/zig-browser/scripts/run-wasi.mjs \
  out/zig-browser/bundle/zig.wasm out/zig-browser/bundle/lib \
  build-exe main.zig -target wasm32-wasi -fno-llvm -fno-lld -O fast \
  -femit-bin=main.wasm
```

For source debugging, emit unoptimized LLVM bitcode while keeping source-level
DWARF metadata. Pass source filenames relative to fd 3, as for normal builds. This
browser profile records `/workspace` as the DWARF directory for relative project
sources, so consumers must use that canonical virtual source root. Standard
library and runtime metadata retain their own `/lib` paths. This avoids IR/source
rewrites and does not add absolute filesystem access to the WASI host.

```bash
node producer/zig-browser/scripts/run-wasi.mjs \
  out/zig-browser/bundle/zig.wasm out/zig-browser/bundle/lib \
  build-exe main.zig -target wasm32-wasi -mcpu=mvp -O debug \
  -fllvm -fno-libllvm -fno-lld -fno-emit-bin -fno-compiler-rt \
  -femit-llvm-bc=output.bc
```

`-femit-llvm-ir=output.ll` is also supported. Without libLLVM these files contain
frontend IR; optimization and machine code generation are delegated to the
consumer's pinned Clang/LLD. Zig already supplies `_start`, so the final link must
omit the C CRT. The consumer links matching `compiler_rt` bitcode and its WASI
libc/libm/builtins closure, and retains DWARF/name sections for LLDB/WAMR. Compile
`/lib/compiler_rt.zig` with `build-obj` and the same flags to emit that runtime.

Supported commands are `build-exe`, `build-obj`, `ast-check`, `fmt`, `targets`,
`version`, `env`, and `help`. LLVM machine code generation, Clang/LLD, C/C++ input,
native machine-code output, static archives, `zig build`, `run`, `test`, and incremental compilation are excluded.
The compiler and emitted WASI programs use Preview 1; this producer does not emit
a Preview 2 component.
