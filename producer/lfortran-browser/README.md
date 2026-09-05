# LFortran browser producer

This producer builds the actual upstream LFortran frontend and LLVM backend for
an Emscripten host. It is a candidate for extending the consumer's existing
f2c-based Fortran support. It does not register a language in `wasm-idle`.
LFortran is upstream alpha software; complete Fortran 2018 parsing does not imply
complete compilation of that standard.

The [2026-09-05 acceptance report](audits/2026-09-05-llvm-evaluator.md) records
a built compiler passing real LLVM compilation, standard input, module execution
and invalid-source diagnostics in both Node and Chromium Workers.

`sources.lock.json` pins the upstream source archive, Emscripten SDK source,
LLVM 22.1.8 Emscripten archive, SDK compiler and Node binaries, and the native parser generators by immutable
URLs, package builds, sizes and SHA-256 hashes. The source is 97 commits after
the upstream `v0.65.0` tag. Its archive version is recorded explicitly, so a
build never inherits the enclosing `wasm-llvm` checkout's Git version.

The LLVM package follows the [official JupyterLite build](https://docs.lfortran.org/en/jupyterlite/).
The pinned upstream [build recipe](https://github.com/lfortran/lfortran/blob/ab867a23029b0c1b1c3131b5a0e2363709be37f0/wasm-build1.sh)
and [LLVM evaluator](https://github.com/lfortran/lfortran/blob/ab867a23029b0c1b1c3131b5a0e2363709be37f0/src/libasr/codegen/evaluator.cpp)
define the compiler path used here.
It requires Emscripten 4; this producer locks SDK 4.0.9. A WASI LLVM archive,
an unrelated LLVM version, or the upstream custom `get_wasm()` backend is not a
replacement. The custom backend does not implement Fortran `READ` at this source
revision. No source-language subset or native compilation fallback is used.

## Build

The current recipe runs on Linux x86_64. It needs Node 20+, Python 3, a native
C/C++ compiler with the GCC 12 runtime, CMake, Ninja, m4, patch, curl, tar, and zstd.
It installs all downloaded inputs below `out/lfortran-browser`. The receipt
records compiler, CMake and parser generator versions. The system libc and
remaining host tools are build prerequisites, so this is not a hermetic
operating system image.

```sh
pnpm prepare:lfortran
pnpm build:lfortran --jobs 2
pnpm package:lfortran
pnpm validate:lfortran out/lfortran-browser/artifacts
pnpm verify:lfortran
```

After Node validation, run the same inputs in fresh Chromium Workers:

```sh
pnpm validate:lfortran-browser out/lfortran-browser/artifacts
```

This additional check needs the repository's `playwright-core` development
dependency and a Chromium installation. `--chromium /path/to/chromium` selects
an existing executable. It writes a separate `browser-acceptance-<id>.json`
beside the artifacts directory, binding the artifact hashes, source pin,
producer inputs, browser version and validation harness hashes to the results.
`--receipt <new-file>` selects that receipt's path; existing files are not
overwritten.

Builds are long-running. Start them in the background with stdout and stderr
redirected to a unique mode-0600 file under a mode-0700 `~/logs`, retain the PID
and exit status, and inspect bounded excerpts only after the process exits.
Use one or two jobs. The recipe downloads the prebuilt LLVM library; it does
not rebuild LLVM itself. `--out` can select another task directory beneath this
checkout's `out/`.

Preparation checks every cached archive before use and rejects modified cached
compiler sources by comparing a digest of the whole source tree. Native LFortran generates
the runtime `.mod` files. The Emscripten build then includes those modules at
`/lib/` and links the upstream Fortran evaluator and LLVM/LLD implementation.
The small C++ command entry point takes a source path and calls that evaluator.
It uses the evaluator's interactive compilation mode so program units get a
callable entry point and actually execute in the current Emscripten instance.
The source patch supplies the archive version, invokes Python 3 explicitly and
adds this command's CMake target. It does not change Fortran semantics or the
upstream evaluator.

The output closure is `lfortran.js`, `lfortran.wasm`, `lfortran.data`, and
`producer-receipt.json`. The receipt binds source, patches, build inputs, tool
versions, the compiled source tree digest, sizes and hashes. Packaging fails after any producer input drift.
`verify` requires successful real input validation, while `package` can create
an unvalidated local handoff for that validation step. Unvalidated artifacts
must not activate consumer support or be published as working releases.

## Consumer contract

The generated Emscripten module exports a factory named `createLFortran` and
the `FS` and `callMain` entry points. A consumer loads the three artifacts by
explicit URLs after checking the producer receipt, creates a fresh instance,
mounts the source, supplies stdin/stdout/stderr using Emscripten's normal host
hooks, and calls `callMain(['/program.f90'])`. Compiler diagnostics go to stderr;
invalid source returns a nonzero status. A source file can contain modules and
a program as in the module fixture.

Upstream LLVM compiles the program to a PIC object, links a dynamic Emscripten
side module through LLD, and loads it with `dlopen`. This is not a standalone
WASI program. The compiler and generated program share the Emscripten host
runtime. Use a new Worker and module instance for every run: upstream side
modules live for the process lifetime. Worker ownership, asynchronous input,
timeouts, termination, filesystem policy and UI belong to `wasm-idle`.

The Node validator supplies real input to a fresh module process, checks two
different input arrays, executes a module procedure, and verifies an upstream
error for invalid source. It also records the LLVM object and linked side
module produced by successful evaluations. Its receipt keeps
`browserAcceptance: false` to describe the scope of Node validation. Chromium
verification writes its own receipt for compilation and execution in Workers;
`wasm-idle` integration and consumer acceptance remain separate. Verification
requires all seven cases, their source and stdin hashes, their expected results,
and the current validator hash; a `passed` flag alone is insufficient.

No JupyterLite site, xeus UI, application Worker runtime, npm runtime API,
or static-host deployment is part of this producer.

## Focused checks

```sh
node --test producer/lfortran-browser/test/*.test.mjs
pnpm check
```

These checks validate locks, receipt integrity and the producer boundary. They
do not build LFortran or claim that a compiler artifact has passed validation.

The source patch also restores statement replacement flags after nested ASR
transforms. Without this upstream pass correction, formatted PRINT at the end
of an IF or DO body can remove the enclosing statement silently. The real
compiler gates include nested IF/DO output, accumulated loop state, and both
EOF and non-EOF IOSTAT branches.
