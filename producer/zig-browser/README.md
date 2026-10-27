# Zig 0.17.0 WASI producer

Build the real Zig 0.17.0 compiler as a WASI Preview 1 core module, using the
self-hosted Wasm backend. Source archives and the native bootstrap are pinned by
SHA-256 in `sources.lock.json`. The port is copied from
[`seo-rii/zigc-wasm` at `1588893`](https://github.com/seo-rii/zigc-wasm/tree/158889336da7fd3ff1070fc68da29a42235ee3a9).
Its original license is preserved in `LICENSE.zigc-wasm`.

## Build and qualify

Requirements: Python 3.10+, Git, Node.js 24, and several GB of memory and disk.
The build script downloads a Linux x86_64/aarch64 native compiler automatically;
other platforms can pass `--zig /path/to/zig-0.17.0`.

```bash
pnpm build:zig
pnpm package:zig
pnpm verify:zig-artifacts
pnpm test:zig-producer
```

`build:zig` writes intermediates and a raw bundle to `out/zig-browser`.
`--work-dir` and `--output` select other build paths. `package:zig` accepts
`--bundle` and `--output`, writes a deterministic full-library archive, extracts
that archive, and runs the actual compiler smoke suite before issuing a successful
receipt. `verify:zig-artifacts --smoke` also executes the checked-in package.

The smoke suite covers standard-library imports, u128 runtime helpers, relocatable
and stripped MVP object linking, diagnostics, formatting, streaming stdout, nested
filesystem access, and WASI rights inheritance. The paired `wasm-idle` integration
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
`ZIG_GLOBAL_CACHE_DIR` unset so Zig selects those preopened handles. Serialize
invocations sharing caches. Stream descriptors must return WASI `SPIPE` for
unsupported positional I/O so Zig can fall back to streaming.

```bash
node producer/zig-browser/scripts/run-wasi.mjs \
  out/zig-browser/bundle/zig.wasm out/zig-browser/bundle/lib \
  build-exe main.zig -target wasm32-wasi -fno-llvm -fno-lld -O fast \
  -femit-bin=main.wasm
```

Supported commands are `build-exe`, `build-obj`, `ast-check`, `fmt`, `targets`,
`version`, `env`, and `help`. LLVM/Clang/LLD, C/C++ input, native machine-code output,
static archives, `zig build`, `run`, `test`, and incremental compilation are excluded.
The compiler and emitted WASI programs use Preview 1; this producer does not emit
a Preview 2 component.
