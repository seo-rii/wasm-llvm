# C3 browser compiler producer

This producer builds the upstream C3 compiler itself as an Emscripten module. The compiler accepts
C3 source in its virtual filesystem, emits relocatable WebAssembly objects, reports source
diagnostics, and links bare WebAssembly programs using its embedded LLVM/LLD libraries.

The source pin is C3 0.8.3 (`1d155ee04d3b607261b99aa15ed5eefd6d7db284`), built with the pinned
Emscripten 6.0.0 SDK. The producer imports a size- and SHA-256-verified LLVM-for-C3 Emscripten archive.
Preparation rejects hidden Git index flags and all untracked or ignored C3 source inputs; the SDK
has an explicit exception for its downloaded installation directories and generated configuration.
Although that archive is published under `llvm_22.1.10`, its `LLVMConfig.cmake` reports **22.1.8**.
Both values are recorded in the manifest. The original SDK version used to build those LLVM
libraries is unavailable; this recipe reproduces the C3 build from that binary input and does not
claim to rebuild LLVM or produce byte-identical binaries across machines.

## Build and verify

Prerequisites are Node 20 or later, pnpm, Python 3, Git, CMake, Ninja, Bash, tar with xz support,
and a Chromium installation compatible with the repository's `playwright-core` dependency.
The SDK and all downloaded/build inputs stay under the work directory. C3 compilation uses two
build jobs. Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm prepare:c3
pnpm build:c3
pnpm smoke:c3
pnpm smoke:c3:browser
pnpm package:c3
pnpm verify:c3-artifacts
```

`WASM_LLVM_C3_WORK_DIR` overrides `out/c3-browser-work`; `WASM_LLVM_C3_OUT_DIR` overrides
`out/c3-browser`. Set `C3_CHROMIUM_EXECUTABLE` when Chromium is not in Playwright's browser cache.
The browser smoke serves only the compiler and acceptance harness on an ephemeral loopback port.
It runs the compiler in Chromium module Workers and executes the generated guest in Chromium.

The release contains `c3c.mjs`, `c3c.wasm`, and `producer-receipt.json`. The receipt binds the
manifest, patched source/library tree hashes, build recipe, SDK version, and compiler asset hashes
to separate Node and Chromium acceptance results. Both results also hash their source fixtures,
Worker harness, and acceptance/verification scripts; changing any of them invalidates old results.
Packaging requires both acceptance runs to have
compiled real source, rejected invalid source, linked a guest, and executed arithmetic and UTF-8
input/output; a Wasm header or successful `--version` is insufficient. Verification checks those
receipts and loads the compiler Wasm with `WebAssembly.compile`.

On 2026-09-05 the complete acceptance passed in Node 24.1.0 and Chromium. The compiler module was
39,058,650 bytes; both engines produced the same 280,763-byte guest from `fixtures/program.c3`.
The exact browser version, checksums, and diagnostic are preserved in the generated receipts.
Generated artifacts are ignored by Git and are not deployed by these commands.

## Compiler invocation contract

Create a fresh compiler instance in a fresh Worker for each invocation. The Emscripten factory
exports `FS` and `callMain`, embeds the upstream library directory at `/lib`, and requires
`noInitialRun: true`. Populate `/work/main.c3`, change its working directory to `/work`, then use:

```text
compile-only --target wasm32 --stdlib /lib/std --threads 1 --max-mem 128
  --reloc=none --link-libc=no --no-entry -g0 --ansi=no /work/main.c3
```

Use `compile` with `--linker=builtin -o /work/program.wasm` for the linked guest. C3 uses `.wasm`
for relocatable wasm32 objects too; inspect the `linking` custom section instead of inferring that
an object is executable from its filename. The acceptance harness demonstrates this distinction.

`--max-mem 128` limits each upstream compiler arena, rather than total process memory. The native
defaults request large virtual-memory reservations which exceed this producer's 2 GiB Wasm limit.
The browser build starts with 128 MiB of linear memory and allows growth. The smoke uses a
120-second deadline per invocation and terminates each Worker after its result. Applications need
their own cancellation, memory accounting, and resource policies.

## Verified target and remaining consumer work

The verified program target is `wasm32-unknown-unknown`. `fixtures/program.c3` declares C3's official
`@wasm` exports and external `env.readByte` / `env.writeByte` imports. Its generated program computes
`sum_squares(5) == 55` and echoes `C3 stdin: 안녕\n` byte for byte. This proves source compilation,
linking, and host-provided byte input/output. It does not establish C3 `std::io` stdin support or
WASI compatibility. There is no WASI sysroot in this producer.

Upstream `--target emscripten` normally invokes an external `emcc` executable. Browser subprocesses
are unavailable; the pinned patch makes that boundary fail explicitly with `ENOSYS`. Native
subprocess implementations are retained. Features needing an external compiler, linker, or
executable must be implemented separately before a consumer can expose them.

`scripts/smoke-worker.mjs` is an acceptance fixture. A wasm-idle language registration, production
Worker/FS adapter, terminal/std::io integration, deployment, and source debugging are separate
consumer work. This producer does not advertise support in wasm-idle.

Upstream licensing remains applicable to generated artifacts: see C3's pinned
[`LICENSE`](https://github.com/c3lang/c3c/blob/1d155ee04d3b607261b99aa15ed5eefd6d7db284/LICENSE)
and [`LICENSE_SRC`](https://github.com/c3lang/c3c/blob/1d155ee04d3b607261b99aa15ed5eefd6d7db284/LICENSE_SRC),
[LLVM license](https://llvm.org/LICENSE.txt), and the installed Emscripten `LICENSE`.
