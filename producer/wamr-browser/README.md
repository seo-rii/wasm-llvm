# WAMR browser debug target

This producer builds a browser-only WAMR classic interpreter with its existing
WebAssembly GDB remote stub. It is the target process used only for LLDB debug
sessions; normal wasm-idle execution continues to use the browser's native
`WebAssembly` engine.

The browser patch keeps WAMR's RSP parser and Wasm-specific packets intact. It
replaces only the socket boundary with two generation-scoped
`SharedArrayBuffer` byte rings supplied by `@wasm-idle/llvm-core`. Program
stdout/stderr remain separate from the RSP byte stream.

The stdin JS library preserves short reads across multiple WASI iovecs. The
consumer installs a blocking whole-read stdin device; one `readv` gathers at
most 64 KiB with one device read, then scatters the available bytes into the
requested vectors. Filling the first vector therefore does not block on the
next vector or require EOF. File reads, positional reads, and single-vector
reads retain the pinned Emscripten implementation.

WAMR performs RSP I/O on its source-debug control pthread. Emscripten does not
copy arbitrary incoming `Module` properties into pthread realms, so the
`pthread-transport-v1` bridge passes cloneable ring descriptors to every
preloaded worker before that worker can run a thread. Blocking imports execute
on the control pthread itself; they are never synchronously proxied to the
application worker. See `contracts/pthread-transport-v1.md`.

## Pinned scope

- WAMR `WAMR-2.4.5` at the exact commit in `sources.lock.json`
- classic interpreter only
- WASI libc enabled
- source debugger enabled
- read, write, and combined read/write linear-memory watchpoints
- JIT, fast JIT, AOT, wasm threads, and multi-module disabled
- one debug target session per worker

Watchpoint matching uses the complete 1/2/4/8-byte interpreter memory access
range. A scalar access that begins before a watched byte still stops when the
two ranges overlap, and the RSP stop reply reports the first overlapping byte.
Failed breakpoint and watchpoint operations use the canonical `E01` RSP error
packet.

The build requires the exact emsdk commit for Emscripten 6.0.0 and uses a
strict, preloaded pthread pool, so the deployed application must be
cross-origin isolated. `callMain()` runs directly in wasm-idle's dedicated
target Worker. This avoids `PROXY_TO_PTHREAD` returning before the real WAMR
main lifetime is complete, so `onExit` and `onAbort` describe the actual
target lifetime.

The portable WAMR host ABI uses `invokeNative_general` to dispatch native/WASI
functions through signatures containing up to twenty arguments. The browser
build therefore enables Emscripten's function-pointer-cast emulation and raises
Binaryen's `max-func-params` pass bound to 21. Without both settings, the target
connects and stops successfully but traps with `function signature mismatch`
as soon as RSP `continue` enters guest WASI code.

Emscripten's cast emulation also cannot preserve the native return-register
residue that WAMR's `void invokeNative` dispatcher relies on. The browser patch
gives that dispatcher and its general-target declaration an explicit `uint32`
return under `__EMSCRIPTEN__`, so wasm32-wasi imports returning i32 errno values
reach wasi-libc while native WAMR builds retain the upstream `void` dispatcher.
Void imports remain valid because their callers discard the value; the
supported browser-native return classes are i32 and void. This is a
deliberately narrow wasm32-wasi ABI contract: custom native imports with i64 or
floating-point native returns are not supported by this producer.

WAMR flattens each WASI `I` parameter into low/high `uint32` words. A second
Emscripten-only patch reconstructs those words and calls the nine libc-wasi
imports through their exact WebAssembly function-pointer types:

| libc-wasi call                 | signature        | flattened argc |
| ------------------------------ | ---------------- | -------------- |
| `clock_time_get`               | `(iI*)i`         | 5              |
| `fd_pread`                     | `(i*iI*)i`       | 7              |
| `fd_seek`                      | `(iIi*)i`        | 6              |
| `fd_fdstat_set_rights`         | `(iII)i`         | 6              |
| `fd_advise`                    | `(iIIi)i`        | 7              |
| `path_open`                    | `(ii*~iIIi*)i`   | 12             |
| `fd_readdir`                   | `(i*~I*)i`       | 7              |
| `fd_filestat_set_size`         | `(iI)i`          | 4              |
| `path_filestat_set_times`      | `(ii*~IIi)i`     | 10             |

The typed path is guarded inside the i32 result branch. Unknown signatures
continue through WAMR's existing general dispatcher, and non-Emscripten builds
compile the original branch unchanged.

Guest linear memories use WAMR's allocation-with-usage path, backed by the
Emscripten host's `malloc`/`realloc`/`free`. The native Linux default reserves
and protects memory with `mmap`/`mprotect`/`mremap`; those host VM operations
are not a valid backing strategy inside a browser Wasm module.

## Commands

```sh
node scripts/prepare.mjs --source /path/to/wasm-micro-runtime
node scripts/build.mjs \
  --source /path/to/wasm-micro-runtime \
  --build /path/to/build \
  --emsdk /path/to/emsdk
node scripts/package.mjs --build /path/to/build --output ./artifacts
node scripts/verify.mjs --artifacts ./artifacts
node scripts/verify-reproducibility.mjs \
  /path/to/clean-artifacts-a \
  /path/to/clean-artifacts-b
```

`prepare.mjs` refuses an unpinned checkout and applies the ordered patch set,
checking each patch with `git apply --check` first. A temporary Git index
classifies the complete dependent set as clean or already applied, so repeating
the prepare command is idempotent without partially reversing source files.
`build.mjs` independently verifies both WAMR and emsdk Git revisions, checks
the installed `emcc` version, and invokes
`emcmake` from that pinned checkout. Packaging preserves and hashes the
Emscripten ES-module pthread sidecar as `wamr-debug.worker.mjs`.
`verify.mjs` requires the exact four-file runtime asset set in the receipt and
checks all asset hashes, the sidecar/transport markers, the runtime-facing
uncompressed Wasm asset, its reproducible gzip copy, Wasm validity, and the
raw and compressed asset-size budgets. Missing, duplicate, and unexpected
receipt paths are rejected before any runtime asset is read.
The product gate caps `wamr-debug.wasm` at 1 MiB raw and 512 KiB as a
deterministic level-9 gzip. The current pinned product is 278,958 bytes raw and
100,560 bytes compressed, leaving explicit headroom without allowing accidental
multi-megabyte growth.
Before publishing a rebuilt interpreter, build it in two distinct clean
directories and run `verify-reproducibility.mjs` on their packages. The
comparison first applies the full standalone verifier to both directories,
rejects comparing a directory with itself, and then requires identical
producer provenance plus raw and deterministic-gzip metadata for every runtime
asset.
The generated module also exports Emscripten's canonical `HEAPU8` view. The
target worker samples only the current backing buffer length so it can report
linear-memory growth without exposing guest bytes; callers must not retain an
older view across memory growth.
The host module starts at 64 MiB and can grow to 2 GiB. Guest linear memories,
the interpreter, WASI state, and the two strict pthread stacks share that host
allocation, so product validation must include actual guest execution rather
than treating the small runtime binary size as a memory bound. The 64 MiB value
is release-qualified for the pinned product fixtures; larger guest memories
grow the module on demand.
The package receipt's provenance hashes the raw `sources.lock.json`, producer
manifest, ordered patch digest set, and ordered overlay digest set.
`verify.mjs` recomputes all four values, and the Clang release assembler carries
them into `RuntimeManifestV2` so a consumer can bind runtime bytes to the exact
WAMR producer inputs.

Pull requests and `main` pushes run the WAMR and LLDB producer contract suites
together in the `LLDB browser producer contracts` workflow. This lightweight
gate validates the pinned source and patch hashes, browser transport contracts,
pthread sidecar, and package receipt without requiring a full Emscripten
rebuild. The weekly schedule and `build_product=true` manual dispatch also
clone the exact WAMR revision into two distinct roots, reuse the LLDB producer's
pinned Emscripten SDK, build and package both browser interpreters, run the
standalone and clean-build reproducibility verifiers, and upload the primary
package beside the LLDB package. Product-binary Chromium acceptance remains in
the consuming `wasm-idle` repository.

The prepare step also installs a forced-include compatibility header. It keeps
Emscripten's host-side `<wasi/api.h>` declarations from colliding with WAMR's
guest WASI ABI declarations while preserving the preview1 errno values used by
Emscripten's POSIX headers.

For Emscripten 6.0.0, the pthread entry is WAMR's generated, versioned main ES
module (`iwasm.js-2.4.5`), while `iwasm.js` is a symlink and the Wasm payload is
`iwasm.js-2.4.wasm`. The packaged sidecar is a dedicated copy of that module;
the runtime passes its URL as `mainScriptUrlOrBlob`, and the main loader also
contains the sidecar name as a fallback.

The pinned source patch targets WAMR's Linux/POSIX product-mini host because
WAMR 2.4.5 does not ship a browser platform. The exact pinned checkout now
completes its Emscripten 6.0.0 product build, packaging, hash verification, and
strict pthread startup smoke in a cross-origin-isolated Chromium Worker. The
real interpreter also remains stopped before debugger input and answers the
shared-ring RSP request `$qSupported#37` with
`+$qXfer:libraries:read+;PacketSize=1000;#65`. This proves the browser factory,
pthread bootstrap, CLI, and byte-stream transport; full `qWasm*`/DWARF
acceptance still depends on the paired LLDB artifact.

The typed-dispatch acceptance guest called all nine functions above. Native
WAMR, browser no-debug-info, and browser `-g` runs all exited 0; the debugger
run ended with RSP `$W00`. Every call returned errno 0, `fd_pread` observed
`byte=w`, `fd_seek` reported offset 1, and `fd_readdir` produced 123 bytes. The
integrated file/env/argv fixture also exited 0 with:

```text
cwd=/
mode=debug
argc=2
argv0=/workspace/program.wasm
argv1=guest-arg
sentinel=workspace-file-ok
stdout=ok
```

This producer deliberately does not promise optimized-code debugging,
wasm64, guest wasm threads, expression evaluation, or native/AOT execution.
