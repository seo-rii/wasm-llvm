# Odin browser compiler investigation

This producer pins the complete upstream Odin compiler and proves its **native compiler → WASI
object → external LLD → execution** path. It also runs a real Emscripten syntax probe on the
upstream compiler entrypoint. **The browser-hosted Odin compiler is not built or ready.**
No language runtime, browser registration, upload, or deployable compiler bundle is included.

The compiler host and program target are different:

| Check | Compiler runs on | Produced program / result |
| --- | --- | --- |
| Native baseline | Linux x64, official Odin binary | `wasi_wasm32` object, linked WASI Preview 1 command, checked stdin/stdout/stderr/exit |
| Host portability probe | Native Emscripten cross-compiler | Syntax-checks upstream Odin `src/main.cpp` for `wasm32-unknown-emscripten`; records concrete errors |
| Browser acceptance | Not implemented | Still required before `wasm-idle` can expose Odin |

`manifest.json` pins monthly release `dev-2026-09` to commit
`a2fb372b76e81ef31fbbc8a2cf2b4fdf5ac6c924`, the official bootstrap archive and executable hashes,
and the Emscripten SDK source revision. The official native binary reports LLVM **20.1.8**.
The host probe uses LLVM **22.1.8 headers** distributed under C3's `llvm_22.1.10` release tag;
that tag is not the header version. The probe does not link this distribution's LLVM libraries.

## Prepare and validate inputs

Requires Node 20+, Git, tar, and a Linux x64 host for the pinned native baseline. Downloads and
generated files go under the explicitly supplied work directory. Preparation verifies bytes before
extracting or executing the official binary. Existing mismatched inputs fail without replacement.

```sh
pnpm prepare:odin -- --work out/odin-browser
pnpm verify:odin-source -- --source out/odin-browser/source
```

Source verification rejects a wrong commit, modified files, untracked and ignored files, symlinks,
and source changes hidden by Git's `assume-unchanged` or `skip-worktree` flags. Every tracked file
is hashed against the pinned Git tree. The baseline sets `ODIN_ROOT` to this verified checkout,
so the official native executable uses the pinned `base` and `core` libraries.

## Execute the native WASI baseline

Supply a native `wasm-ld` from LLVM 17–22. The receipt records its exact version and binary hash;
the completed baseline used Swift's LLD 21.0.0. Keep the `wasm-ld` command name when passing a
symlink: LLD uses its invocation name to select the Wasm linker.

```sh
pnpm probe:odin-native -- \
  --source out/odin-browser/source \
  --native-root out/odin-browser/native/odin-linux-amd64-nightly+2026-09-01 \
  --wasm-ld /path/to/bin/wasm-ld \
  --output out/odin-browser/baseline
pnpm verify:odin-baseline -- --output out/odin-browser/baseline
```

The output directory must be new. Compilation uses the actual upstream compiler's
`-target:wasi_wasm32 -build-mode:obj` mode. Linking follows upstream's stack-first, 1 MiB stack,
and undefined-import flags; the resulting artifact must contain only the fixture's allowed WASI
Preview 1 imports and must export `_start` and `memory`.

The two-file fixture covers package compilation, a generic procedure, a struct, dynamic arrays,
`defer`, standard-library buffered input, and formatted output. Four executions verify normal stdin,
EOF without a trailing newline, empty EOF, and stderr with exit 2 on invalid input. A separate
invalid program must fail compilation with a diagnostic naming `missing_symbol` and no object.

`native-baseline-receipt.json` binds the producer scripts, fixtures, source revision, native tools,
commands, object and Wasm hashes, imports/exports, actual outputs, and diagnostic evidence.
`verify:odin-baseline` detects changed source/tool/artifact bytes and rejects a receipt claiming
browser readiness. Receipts are local build evidence, not signed attestations or browser acceptance.

## Reproduce the compiler-host blocker

Use the emsdk commit pinned in `manifest.json`, with SDK **6.0.0** installed and activated.
The LLVM header archive URL, size, digest, and `usr/include` path are pinned in the same manifest.
Validate the archive digest before extracting it. The probe checks the generated LLVM header
digest and Emscripten version before compiling. It puts Emscripten's generated cache in its own
output directory, leaving a shared SDK/header installation untouched.

```sh
pnpm probe:odin-host -- \
  --source out/odin-browser/source \
  --emsdk /path/to/emsdk \
  --llvm-include /path/to/llvm/usr/include \
  --output out/odin-browser/host-probe
```

At the pinned revision this command exits **1**, and `host-probe-receipt.json` records `blocked`:
`gb.h` rejects the Emscripten operating system and WebAssembly CPU, then includes the unavailable
`sys/sendfile.h`. This is a compiler-host failure before LLVM code generation. It does not imply
that Odin's WASI output target is broken. A future successful syntax check will still record
`browserCompilerReady: false`; it cannot establish linking or execution readiness.

A real host port must implement the required platform behavior, then build and link the complete
compiler with a compatible LLVM host library. Compiler threading, filesystem operations, and
subprocess-based linking need particular attention. The resulting compiler must compile these
fixtures inside a browser Worker, with external linker and VFS support owned by `wasm-idle`.
See the [recorded experiment](audits/2026-09-05-native-wasi-and-host-probe.md).

## Focused verification

Offline checks require no compiler downloads:

```sh
node --test producer/odin-browser/test/*.test.mjs test/producer-repository.test.mjs
```

To include real upstream compilation, execution, and receipt tamper tests after preparation:

```sh
ODIN_TEST_WORK="$PWD/out/odin-browser" \
ODIN_TEST_WASM_LD=/path/to/bin/wasm-ld \
node --test producer/odin-browser/test/*.test.mjs
```

Run longer preparation/probe commands in the background with stdout and stderr redirected from
the start to a unique mode-0600 file under `~/logs` (mode 0700). Preserve the PID and exit status;
inspect bounded output only after the process exits.
