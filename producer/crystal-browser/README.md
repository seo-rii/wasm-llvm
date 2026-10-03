# Crystal compiler host portability probe

This producer pins the official Crystal **1.21.0** source and Linux x86_64 bootstrap compiler.
It cross-compiles a real standard-input program to a WASI relocatable object, checks a syntax
diagnostic, and attempts to cross-compile the upstream Crystal compiler itself. Browser compiler
and browser stdin/stdout readiness remain false.

The fixture preserves the original one-line integer-sum behavior. When input has a second line it
echoes that line before the sum, allowing a consumer to prove UTF-8 bytes crossed a transport
boundary. For example, UTF-8 input `1 2\nabc한xyz\n` (where `한` crosses an eight-byte boundary)
must eventually produce `abc한xyz\n3\n` once a browser compiler host is available.

## Run the probe

Requires Linux x86_64, Node 20+, Git, tar, and a native `llvm-config` supported by Crystal.
Preparation downloads the bootstrap into a task-owned directory, checks its exact size and
SHA-256 before extraction, and verifies the source revisions. The compiler's Markdown dependency
is pinned to the commit behind `markd` v0.5.0 from the upstream shard lock.

```sh
pnpm probe:crystal-browser -- prepare
pnpm probe:crystal-browser -- probe --llvm-config /path/to/llvm-config
# Optional isolated output location:
pnpm probe:crystal-browser -- probe --work-root /path/to/work --llvm-config /path/to/llvm-config
```

`--cross-compile --target wasm32-unknown-wasi -Dwithout_mt` selects the upstream single-threaded
WASI path. The compiler-host probe also uses upstream's direct-build acknowledgement and options
to omit the interpreter and optional XML/OpenSSL/zlib dependencies. No source code is patched.
The native `llvm-config` supplies configuration during cross-compilation; its libraries are not
linked into a browser compiler by this command.

The current pinned compiler-host probe exits **1** because `Crystal::System::Process.prepare_args`
is unavailable for WASI. The standard-input target produces a valid Wasm object, and the invalid
source returns a parser diagnostic. See [the recorded validation](portability-audit.md).

Each run uses a new `probe-*` directory with a mode-0600 `receipt.json`. The version-2 receipt binds
the producing Git commit and probe script hash, source revisions, manifest/bootstrap/tool hashes,
both fixture hashes, exact compiler commands, exit status, diagnostics, and object hashes. The
producer directory must be committed and clean before a probe. Compiler steps have a three-minute
timeout. A successful object
must pass WebAssembly validation and contain a version-2 `linking` section. A target object or
syntax diagnostic cannot set the browser readiness gates.

The recipe stops before native target linking and execution, compiler-host linking, browser
execution, packaging, or consumer registration. Completing the host port requires working
process/linker and filesystem contracts plus a compatible Wasm-hosted LLVM runtime. A consumer
Worker, user input API, and language registration belong to `wasm-idle`.

Run longer prepare/probe commands in the background with stdout and stderr redirected from the
start to a unique mode-0600 file under `~/logs` (mode 0700). Preserve the PID and final exit status;
inspect bounded output after completion.

## Focused checks

```sh
node --test producer/crystal-browser/test/*.test.mjs test/crystal-browser-producer.test.mjs test/producer-repository.test.mjs
pnpm check
```

These checks run without downloading a compiler. The `probe` command performs the real upstream
compilation and records a failed host gate as a nonzero result.
