# wasm-swift

This folder tracks the Swift runtime work for wasm-idle. It is intentionally not wired into
`supportedLanguages` yet.

Swift support must use a real Swift compiler path. A handwritten Swift parser, transpiler, subset
runtime, or remote compile service is not acceptable for wasm-idle.

## Current upstream path

Swift.org distributes Swift SDKs for WebAssembly that are installed into a native Swift toolchain
and used with `swift build --swift-sdk ...`. That can produce WASI modules, but it does not provide
a browser-hosted `swiftc`/SwiftPM bundle by itself.

The first implementation milestone for wasm-idle is therefore:

1. Build or source a redistributable browser-hosted Swift compiler/SwiftPM runtime bundle.
2. Package it under `static/wasm-swift` with the same compressed asset strategy used by other large
   runtimes.
3. Verify `print(readLine()!)` through the real browser playground path.
4. Only then add `SWIFT` to `supportedLanguages`.

To re-check whether the upstream SwiftWasm release assets have started publishing a usable browser
compiler bundle candidate, run:

```sh
pnpm --dir runtime/swift run discover:upstream -- --allow-no-browser-compiler
```

The command reports SDK artifact bundles separately from browser compiler candidates. SDK
artifactbundles are valid native Swift SDK inputs, but they are not enough to run `swiftc` inside the
browser. Its text output and optional JSON receipt include next actions: when only SDK artifacts are
published, continue with the source build flow instead of packaging the SDK zip as a wasm-idle
browser runtime.
To preserve the exact upstream finding used for a registration decision, write a JSON receipt:

```sh
pnpm --dir runtime/swift run discover:upstream -- --allow-no-browser-compiler --receipt out/swift-upstream-discovery.json
```

For a single status report that covers upstream assets, local browser compiler build outputs, and
the currently synced app bundle readiness gate, run:

```sh
pnpm run doctor:wasm-swift -- --skip-upstream
```

Drop `--skip-upstream` when network access is available and the latest `swiftwasm/swift` release
should be checked as part of the report. The command is expected to fail until the real
browser-hosted `runner-worker.js`, `swiftc.wasm`, `swiftpm.wasm`, and `sdk.tar.gz` bundle exists.
When no browser compiler build outputs exist yet, the doctor next actions first point to
`pnpm --dir runtime/swift run probe:toolchain`, and then to
`pnpm --dir runtime/swift run probe:install` if the native Swift toolchain is missing.
Add `--probe-toolchain` when the doctor report itself should include that native Swift/Wasm SDK
probe, and `--probe-toolchain-run-wasm` when it should also execute the stdin probe through the
native Swift/Wasm runner.
The root shortcuts are:

```sh
pnpm run doctor:wasm-swift:probe
pnpm run doctor:wasm-swift:probe-run
```

Add `--upstream-receipt out/swift-upstream-discovery.json` when the doctor run should also preserve
the exact upstream release classification it used.
Use `--upstream-api-url https://.../releases/<id>` with that receipt when checking a pinned release
or fork instead of the default latest `swiftwasm/swift` release.
Do not combine `--skip-upstream` with `--upstream-api-url` or `--upstream-receipt`; both require
an upstream check.
After a candidate bundle has been packaged and synced, run the candidate doctor before
registration:

```sh
pnpm run doctor:wasm-swift:candidate
```

The candidate doctor uses the same build-plan provenance, upstream baseline receipt, browser
compiler contract, compressed manifest, and browser runtime contract checks as the candidate
readiness path, but intentionally does not require `SWIFT` registration yet. After the registration
change, run `pnpm run doctor:wasm-swift:strict`; the strict doctor adds the same registration checks
as the final readiness path.

When no upstream browser bundle exists, start from a Swift source checkout and validate the direct
build workspace. First write a source bootstrap plan:

```sh
pnpm run bootstrap:wasm-swift-source -- \
  --source-root path/to/swift-source-root \
  --swift-ref main \
  --dependency-scheme main
```

For the SwiftWasm 6.3 release fork used by the current SDK discovery path, pin the SwiftWasm
repository and create the local branch name expected by `update-checkout` before dependency update:

```sh
pnpm run bootstrap:wasm-swift-source -- \
  --source-root /data/wasm-idle-swift/source-root \
  --llvm-source-root /data/wasm-idle-swift/browser-compiler-source/llvm-project \
  --swift-repository https://github.com/swiftwasm/swift.git \
  --swift-ref swift-wasm-6.3-RELEASE \
  --swift-local-branch release/6.3 \
  --dependency-scheme release/6.3 \
  --swift-clone-depth 1 \
  --swift-clone-filter blob:none \
  --receipt /data/wasm-idle-swift/source-bootstrap-receipt.json \
  --execute
```

Pass `--execute` only when you intentionally want to run the large `git clone` and
`swift/utils/update-checkout --clone` flow. The execute path checks for at least 80 GiB of free
space under `--source-root` before it starts the clone/update-checkout sequence, because a Swift
monorepo checkout and build workspace can outgrow a small local disk quickly. Use an external
workspace with more capacity, lower the threshold with `--min-free-gib <n>`, or pass
`--allow-insufficient-disk` only when that preflight is intentionally being handled outside this
script. Keep `--source-root`, `--checkout-root`, `--build-dir`, and later `--plan` paths on that
same external workspace so the bootstrap, baseline receipt, build-output discovery, and strict
package-sync provenance all point at the same large-disk build. The bootstrap command also accepts
`--swift-local-branch <branch>` for release tags whose `update-checkout` dependency scheme expects a
branch name, plus `--swift-clone-depth <n>` and `--swift-clone-filter <expr>` for the initial
`swift.git` clone when a CI run wants a shallow or partial clone, for example
`--swift-clone-depth 1 --swift-clone-filter blob:none`. These options do not make
`swift/utils/update-checkout --clone` shallow by themselves; they only reduce the first `swift.git`
clone before dependency checkout runs. Add `--receipt
path/to/bootstrap-receipt.json` with `--execute` when a long checkout should leave a JSON record of
the selected source root, clone options, optional local branch, disk preflight, command list,
expected checkout file check, and pass/fail status. A successful bootstrap requires `swift/utils/build-script`,
`swift/CMakeLists.txt`, `llvm-project/llvm/CMakeLists.txt`, and `swiftpm/Package.swift` to exist
after `swift/utils/update-checkout --clone` finishes. After the source tree exists,
validate the build workspace with:

```sh
pnpm --dir runtime/swift run build:browser-compiler -- \
  --checkout-root path/to/swift-source-root \
  --build-dir path/to/browser-compiler-build \
  --raw-runtime-dir path/to/raw-swift-runtime \
  --source-bootstrap-receipt path/to/bootstrap-receipt.json \
  --browser-build-command "./build-browser-swift-runtime.sh" \
  --browser-build-log path/to/browser-compiler-build/browser-build.log \
  --execute-browser-build-command \
  --discover-build-outputs \
  --fetch-official-sdk \
  --allow-missing-tools
```

The checkout root must contain `swift/`, `llvm-project/`, and `swiftpm/`. The harness writes a
`wasm-idle-swift-browser-build-plan.json` that records the checked source tree, probed build tools,
and the expected `runner-worker.js`, `swiftc.wasm`, `swiftpm.wasm`, and `sdk.tar.gz` paths consumed
by `prepare:raw-runtime`. When `--source-bootstrap-receipt` is provided, the harness requires a
passed source bootstrap receipt for the same checkout root and records its clone/ref/check status in
the build plan. The plan also records a `browserCompilerBuild.requiredOutputs` contract
for each file, including the verifier used for runner worker, compiler Wasm identity, SwiftPM Wasm
identity, and SDK archive validation. It also embeds the current
`browserCompilerBuild.runtimeContract` snapshot so later package and readiness steps can reject
stale browser worker contracts. It does not treat the native SwiftWasm SDK artifactbundle as a
browser compiler. Provide `--browser-build-command` with the command that creates the browser
compiler outputs; add `--execute-browser-build-command` when the harness should run that command
from the checkout root and record `browserCompilerBuild.execution` status, timestamps, paths, and
exit code in the plan. Add `--browser-build-log` to tee stdout and stderr into a diagnostics log
whose path is recorded in that execution receipt. Add `--discover-build-outputs` when the harness
should immediately validate the generated `runner-worker.js`, `swiftc.wasm`, `swiftpm.wasm`, and
`sdk.tar.gz` candidates and write the discovered paths back into the plan. Strict package, export,
and readiness gates require both the command provenance and a passed execution receipt.
The exact baseline commands `swift/utils/build-script --preset buildbot_linux_crosscompile_wasm`,
`swift/utils/build-script --preset wasm_stdlib`, and
`swift/utils/build-script --preset wasm_stdlib_incremental` are rejected as browser build commands;
run those through `run:wasm-swift-upstream-baseline` instead.
The plan also records upstream wasm baseline presets such as `buildbot_linux_crosscompile_wasm`,
`wasm_stdlib`, and `wasm_stdlib_incremental`. Those commands are useful for proving the native
Swift/WASI baseline and WASI stdlib path, but they are not accepted as evidence that browser
`swiftc.wasm` or `swiftpm.wasm` outputs exist.

The in-tree browser compiler port starts by cross-compiling LLVM, Clang, and LLD themselves for a
`wasm32-wasip1` host. It reuses the native LLVM tools, WASI sysroot, libc++, and compiler-rt built by
the upstream baseline and applies the small LLVM CMake platform patch tracked in
`patches/llvm-wasi-platform.patch`:

```sh
pnpm --dir runtime/swift run build:wasi-compiler -- \
  --source-root /data/wasm-idle-swift/source-root \
  --llvm-source-root /data/wasm-idle-swift/browser-compiler-source/llvm-project \
  --build-dir /data/wasm-idle-swift/browser-compiler-build \
  --native-build-dir /data/wasm-idle-swift/source-root/build/buildbot_linux \
  --jobs 8 \
  --execute
```

Without `--execute`, the command writes a dry-run receipt containing the exact CMake and Ninja
commands. `--configure-only` validates the WASI host toolchain without compiling all LLVM targets.
Use a dedicated `llvm-project` checkout or worktree for `--llvm-source-root`; the port patch must not
be applied to the checkout concurrently used by the upstream native baseline build.
The WASI-hosted tools use CMake `MinSizeRel` so the uncompressed browser modules are optimized for
size before the runtime packaging layer applies gzip compression.
The receipt records whether the port patch was applied, already present, or skipped, and identifies
the expected WASI-hosted `clang` and `lld` outputs. A full build verifies both outputs' WebAssembly
1.0 headers and records their byte sizes before the receipt can pass. These are prerequisites for `swiftc.wasm`; their
existence alone is not reported as completed Swift browser support. The generated toolchain also
force-includes `patches/llvm-wasi-thread-shim.h`; it supplies the lock type surface removed by
no-thread WASI libc++ plus synchronous `thread`, `promise`, `future`, and `async` behavior while
LLVM itself remains compiled with `LLVM_ENABLE_THREADS=OFF`. A future callback must complete on the
same thread; attempting to wait on an unresolved future terminates instead of deadlocking the
browser worker.
The toolchain enables WASI libc's official `wasi-emulated-mman`, process-clock, PID, and signal
archives. LLVM therefore keeps its normal mapped-file and process-accounting implementations;
Unix-domain sockets, child-process creation, POSIX file locking, and system user lookup remain
unavailable. The platform patch disables only Clang's process-backed `-cc1depscand` service while
retaining inline `-cc1depscan`; browser code must invoke integrated compiler and linker entry points
instead of expecting `fork` or `exec`. LLVM's internal on-disk CAS lock is treated as acquired on
WASI because the browser worker contract has a single process. It does not provide cross-worker or
cross-process exclusion, so each worker must use an isolated CAS directory.
LLVM's MCJIT and ORC archives are linked because the upstream Swift frontend references them, but
WASI cannot register dynamically generated exception frames. Their frame registration code therefore
uses LLVM's runtime symbol lookup fallback on WASI instead of importing unavailable
`__register_frame` and `__deregister_frame` symbols; attempting to use those JIT paths still reports
the missing runtime service rather than claiming executable-memory support.

After the LLVM, Clang, and LLD WASI modules have completed, build cmark-gfm and the upstream Swift
frontend with:

```sh
pnpm --dir runtime/swift run build:wasi-frontend -- \
  --source-root /data/wasm-idle-swift/source-root \
  --swift-source-root /data/wasm-idle-swift/browser-compiler-source/swift \
  --swift-syntax-source-root /data/wasm-idle-swift/source-root/swift-syntax \
  --cmark-source-root /data/wasm-idle-swift/source-root/cmark \
  --llvm-source-root /data/wasm-idle-swift/browser-compiler-source/llvm-project \
  --build-dir /data/wasm-idle-swift/browser-compiler-build/wasi-port \
  --native-build-dir /data/wasm-idle-swift/source-root/build/buildbot_linux \
  --llvm-build-dir /data/wasm-idle-swift/browser-compiler-build/wasi-port/llvm-wasi \
  --toolchain /data/wasm-idle-swift/browser-compiler-build/wasi-port/swift-browser-wasi-toolchain.cmake \
  --jobs 4 \
  --swift-in-swift \
  --execute
```

This stage applies `patches/swift-wasi-platform.patch` to a dedicated Swift worktree and
`patches/swift-syntax-wasi-platform.patch` to the matching SwiftSyntax checkout. The SwiftSyntax
patch exposes WASI's standard I/O declarations through its upstream C shim. The Swift patch
removes the unavailable `libuuid` dependency only for a WASI host and implements the same UUID
surface with LLVM's WASI `random_get` path and standard UUID text encoding. It also makes the
upstream swift-syntax and macro support products static for WASI because a browser worker has no
dynamic library loader. The build uses upstream cmark-gfm, swift-syntax,
swift-experimental-string-processing, and Swift compiler sources;
it does not contain a wasm-idle parser or language subset. It forces `lld`, disables host test and
stdlib products that are already supplied by the matching upstream baseline, verifies the resulting
`swift-frontend` with `WebAssembly.validate`, and records the output size in
`wasm-idle-swift-wasi-frontend-build.json`. Swift compiler sources use explicit libc++, SwiftShims,
generated LLVM configuration, and Swift bridging module maps plus the matching WASI SDK/resource
directory. The no-thread compatibility types are imported through a dedicated Swift C++ bridging
module instead of defining a separate parser or runtime surface.

Swift-in-Swift is the default and selects upstream `HOSTTOOLS` bootstrapping, including the Swift parser,
swift-syntax, regex parser, AST generation, and compiler Swift modules in the frontend. The
WASI build uses upstream pure bridging mode so Swift imports the stable bridging declarations while
their implementations remain in the C++ compiler libraries. The platform patch also keeps the
bridged Swift object header pointer-sized, matching Swift's `InlineRefCounts` ABI on the 32-bit
wasm host instead of assuming the 64-bit native compiler layout. It also gives
`AbstractConformance` the eight-byte alignment promised by its upstream `PointerUnion` traits;
without that alignment, wasm32 treated the third pointer bit as a tag and corrupted the second
generic protocol conformance while linking array and variadic SIL. Likewise, compound declaration
names now use the eight-byte alignment promised by `Identifier::RequiredAlignment`; otherwise the
nested `PointerUnion` erased the compound-name tag and corrupted `appendLiteral(_:)` during string
interpolation type checking. The `--swift-in-swift` flag shown
above is optional and documents that default explicitly. Use
`--cxx-bootstrap` only for the smaller C++ frontend investigation, whose receipt records
`compilerCompleteness: cxx-frontend-bootstrap` and `swiftInSwift: false`. The Swift-in-Swift receipt
records `compilerCompleteness: upstream-swift-in-swift`, but it is still not accepted as the final
Swift browser runtime until execution and SDK compilation tests pass. Built-in macro plugins are
currently emitted as static archives; the browser compiler still needs a static plugin registration
bridge before macro expansion can be claimed. This is a staged upstream compiler port, not a claim
that a reduced language implementation is complete. Use `--configure-only` to generate the cmark
and Swift Ninja graphs without compiling them, and use a dedicated Swift checkout or worktree
because the WASI platform patch is applied to that source tree.

Verify the built frontend, its hosted autolink extractor, native WASI link inputs, and stdin/stdout
execution with:

```sh
pnpm run verify:wasm-swift-wasi-frontend -- \
  --source-root /data/wasm-idle-swift/source-root \
  --build-dir /data/wasm-idle-swift/browser-compiler-build/wasi-port-full \
  --native-build-dir /data/wasm-idle-swift/source-root/build/buildbot_linux
```

The verifier runs `swift-frontend` and `swift-autolink-extract` inside WasmKit, links the resulting
object against the matching static Swift/WASI SDK with native Clang, and requires exact
`swift-stdin:swift-stdin-ok\n` output from a real `readLine()`, string interpolation, and `print()`
Swift program. WasmKit currently
reports unsupported `path_rename` operations while materializing compiler outputs, so an exit-zero
compile is accepted only when the requested object actually exists and is non-empty. Results are
recorded in `wasm-idle-swift-wasi-frontend-verification.json`.

To run one of those recorded baseline presets and write a provenance receipt next to the build
plan, use:

```sh
pnpm run run:wasm-swift-upstream-baseline -- \
  --plan path/to/browser-compiler-build/wasm-idle-swift-browser-build-plan.json \
  --preset buildbot_linux_crosscompile_wasm
```

Add `--dry-run` to verify the selected command and receipt path without launching the large Swift
build. Non-dry-run baseline builds use the same 80 GiB free-space preflight as source checkout
execution; use a large external workspace, lower the threshold with `--min-free-gib <n>`, or pass
`--allow-insufficient-disk` only when that capacity check is being handled outside the script. By
default the command supplies `install_destdir` and `installable_package` preset substitutions under
the plan's build directory, and records those exact arguments in the receipt. Pass
`--preset-substitution name=value` to append or override Swift `build-script` substitutions for a
local build. Use `--preset-file <file> --allow-unplanned-preset` when a local run needs a custom
Swift preset. A cache-resume preset that skips LLVM and Swift builds must be independent of
`buildbot_linux_crosscompile_wasm`: inheriting that package preset first enables LLDB and the
installable-package tests, and later `option=0` entries do not reliably remove those boolean
flags. Mix in only the assertion and install-component presets, then declare `install-llvm`,
`install-swift`, `build-wasm-stdlib`, the required install components, and the relevant
`skip-build-*` options directly. Do not use that cache-resume preset for a clean source tree; a
fresh baseline must build the native LLVM, Swift, and WASI SDK products before packaging them.
For a browser compiler baseline-only proof, keep SourceKit-LSP, IndexStoreDB, Swift DocC, swift-format, toolchain
benchmarks, and all validation/test lanes disabled in the local preset; those packages are useful
for a full Swift toolchain but are not required to prove the Swift/WASI compiler and SDK baseline
and can turn a cached rerun into hours of unrelated work. Swift `build-script`
replaces its default preset file list as soon as any explicit `--preset-file` is provided, so pass
both the upstream `swift/utils/build-presets.ini` file and the local custom preset file:

```sh
pnpm run run:wasm-swift-upstream-baseline -- \
  --plan /data/wasm-idle-swift/browser-compiler-build/wasm-idle-swift-browser-build-plan.json \
  --preset buildbot_linux_crosscompile_wasm_no_lldb \
  --preset-file /data/wasm-idle-swift/source-root/swift/utils/build-presets.ini \
  --preset-file /data/wasm-idle-swift/browser-compiler-build/wasm-idle-swift-local-presets.ini \
  --allow-unplanned-preset
```

By default the command
records the receipt path and SHA-256 digest back into the build plan so
`package:wasm-swift-from-plan` can persist that baseline provenance in `runtime-build.json`. Failed
non-dry-run executions still write a `failed` receipt and update the plan before returning a
non-zero exit, so long-running upstream failures keep their exact command provenance. Failed
receipts also record the child exit code, termination signal, and error message, which distinguishes
an interrupted build from a compiler failure. Use
`--no-write-plan` only for a scratch receipt that should not affect packaging provenance. The
receipt intentionally states that this only proves the upstream Swift/WASI baseline; the browser
bundle still requires concrete `runner-worker.js`, `swiftc.wasm`, and `swiftpm.wasm` outputs before
wasm-idle can expose Swift.

After a browser compiler build completes, discover and validate output candidates before packaging:

```sh
pnpm run discover:wasm-swift-build-outputs -- \
  --build-dir path/to/browser-compiler-build \
  --plan path/to/browser-compiler-build/wasm-idle-swift-browser-build-plan.json \
  --allow-official-sdk-placeholder \
  --write-plan
```

The discovery step scans for `runner-worker.js`, `swiftc.wasm`, `swiftpm.wasm`, and `sdk.tar.gz`,
checks the runner worker contract and binary signatures, and writes validated paths into the build
plan. Use `--allow-official-sdk-placeholder` only when the SDK archive should be fetched from the
documented Swift.org artifact during the later package step.
If that later package step uses `--official-wasm-sdk-provenance`, the fetched `--sdk-url` and
`--sdk-checksum` must also be the documented official Swift Wasm SDK values. For any other
Swift.org SDK artifact, pass explicit `--wasm-sdk-url` and `--wasm-sdk-checksum` so
`runtime-build.json` records the artifact that was actually fetched. Packaging rejects placeholder
SDK fetches when those recorded URL/checksum values are missing or do not match the fetched
`--sdk-url` and `--sdk-checksum`.

After a browser compiler build writes the paths recorded in the plan, verify those outputs before
assembling the raw runtime:

```sh
pnpm run verify:wasm-swift-build-outputs -- \
  --plan path/to/browser-compiler-build/wasm-idle-swift-browser-build-plan.json \
  --require-browser-compiler-contracts \
  --require-browser-build-command \
  --require-browser-build-execution \
  --require-browser-build-log \
  --allow-official-sdk-placeholder \
  --prepare-raw-runtime
```

The verifier requires real `runner-worker.js`, `swiftc.wasm`, and `swiftpm.wasm` files. The official
Swift SDK placeholder is allowed only with `--allow-official-sdk-placeholder`.
`--require-browser-compiler-contracts` rejects stale plans that do not include the
`browserCompilerBuild.requiredOutputs` contract and current `browserCompilerBuild.runtimeContract`
snapshot written by the current build harness. `--require-browser-build-command` and
`--require-browser-build-execution` require the recorded command plus a passed execution receipt
from the harness-run build command. `--require-browser-build-log` also requires that receipt's
diagnostics log file to exist. `--prepare-raw-runtime` then downloads the documented SDK
archive while copying the verified browser compiler outputs into the raw runtime directory.

To verify the plan outputs, prepare raw runtime assets, and package the dist in one step, run:

```sh
pnpm run package:wasm-swift-from-plan -- \
  --plan path/to/browser-compiler-build/wasm-idle-swift-browser-build-plan.json \
  --swift-version 6.3.3 \
  --wasm-sdk-id swift-6.3.3-RELEASE_wasm \
  --source "local Swift browser compiler build" \
  --require-upstream-baseline-receipt \
  --require-browser-compiler-contracts \
  --require-browser-build-command \
  --require-browser-build-execution \
  --require-browser-build-log \
  --allow-official-sdk-placeholder \
  --official-wasm-sdk-provenance
```

The generated `runtime-build.json` records the supplied source text plus the build plan path and
SHA-256 digest, the source bootstrap receipt path and SHA-256 digest, plus any passed upstream
baseline receipt paths and SHA-256 digests recorded in the plan, so a synced Swift bundle can be
traced back to the exact source checkout, output plan, and baseline command that produced it.
Packaging from a plan also preserves the exact plan JSON as `build-plan.snapshot.json`, the workflow
preflight receipt as `workflow-preflight.snapshot.json` when `--workflow-preflight-receipt` is
provided, the source bootstrap receipt as `source-bootstrap.snapshot.json`, and each passed baseline
receipt as `upstream-baseline-<preset>.snapshot.json` in the packaged and synced bundle. When the
build plan records `browserCompilerBuild.execution.logPath`, packaging also preserves that
diagnostics log as `browser-build.snapshot.log`. Strict readiness first
checks the original absolute provenance paths, then falls back to those bundled snapshots with the
same SHA-256 digests, so the published asset keeps local audit copies even if the large external
build workspace is later removed.
`--require-source-bootstrap-provenance` rejects packaging when the plan has no passed source
bootstrap receipt, or when the recorded receipt file is missing. `--require-upstream-baseline-receipt`
rejects packaging when the plan has no passed baseline
receipt, or when the recorded receipt file digest no longer matches. Add
`--require-browser-build-command` when packaging candidate artifacts that must satisfy the final
readiness gate; this rejects plans that do not record `browserCompilerBuild.command`. Add
`--require-browser-build-execution` to require a passed `browserCompilerBuild.execution` receipt
from the harness-run browser compiler build command. Add `--require-browser-build-log` to require
the execution receipt's diagnostics log file before packaging from the plan. Add
`--browser-contract` when the resulting bundle should pass Chromium contract validation before
replacing `runtime/swift/dist`.

To package from the plan and immediately sync the verified dist into the app assets, run:

```sh
pnpm run package-sync:wasm-swift-from-plan:strict -- \
  --plan path/to/browser-compiler-build/wasm-idle-swift-browser-build-plan.json \
  --swift-version 6.3.3 \
  --wasm-sdk-id swift-6.3.3-RELEASE_wasm \
  --source "local Swift browser compiler build" \
  --allow-official-sdk-placeholder \
  --official-wasm-sdk-provenance
```

This writes `static/wasm-swift`, regenerates `runtime-manifest.v1.json`, writes
`sync-receipt.v1.json`, and updates `src/lib/playground/wasmSwiftVersion.ts` with the synced
bundle fingerprint. The root
`package-sync:wasm-swift-from-plan:strict` shortcut enables `--require-upstream-baseline-receipt`,
`--require-browser-compiler-contracts`, `--require-browser-build-command`,
`--require-browser-build-execution`, `--require-browser-build-log`,
`--require-source-bootstrap-provenance`, `--browser-contract`,
`--compress-static`, `--readiness`, `--readiness-require-build-plan-provenance`,
`--readiness-require-source-bootstrap-provenance`,
`--readiness-require-browser-build-command-provenance`,
`--readiness-require-browser-build-execution-provenance`,
`--readiness-require-browser-build-log-provenance`,
`--readiness-require-upstream-baseline-provenance`, `--readiness-require-compressed-manifest`, and
`--readiness-browser-contract` by default; use the lower-level
`package-sync:wasm-swift-from-plan` script only for diagnostics. `--compress-static`
then applies the same gzip-only large runtime asset strategy used by the page build; Swift manifest
validation accepts the resulting `swiftc.wasm.gz` and `swiftpm.wasm.gz` files. `--readiness`
syncs and compresses into a staging target first, checks that staged target and staged version
module, and publishes to `static/wasm-swift` only after readiness passes. Because this command
packages from a build plan, readiness always re-reads the recorded `build-plan` file, verifies the
recorded SHA-256 digest, and requires current `browserCompilerBuild.requiredOutputs` contracts and
`browserCompilerBuild.runtimeContract` snapshot. The strict shortcut also proves the recorded source
bootstrap receipt, `browserCompilerBuild.command`, and passed `browserCompilerBuild.execution`
receipt that created the browser compiler bundle; the GitHub runtime workflow records the command
from its `browser_build_command` input and the harness records the execution receipt after it runs.
It also proves the recorded baseline receipt in `runtime-build.json`; readiness then reads the
receipt file, verifies its SHA-256 digest, and requires a passed
`wasm-idle-swift-upstream-baseline-build-v1` receipt.
It requires the final bundle to be deployment-shaped:
`swiftc.wasm.gz` and `swiftpm.wasm.gz` must exist, and `compressed-runtime-assets.v1.json` must
list their logical `wasm-swift/*.wasm` paths with sizes matching `runtime-manifest.v1.json`.
The lower-level `package-sync:wasm-swift-from-plan` command accepts the same `--readiness-*` flags
when a diagnostic run needs to assemble that gate manually. Add `--readiness-require-registered` in
the change that exposes `SWIFT` in the app.

## Toolchain probe

When a native Swift toolchain is available, this probe checks the currently installed Swift Wasm SDK
path by compiling a tiny stdin program to a WASI `.wasm` module:

```sh
pnpm --dir runtime/swift run probe:toolchain
```

To persist the native baseline evidence for CI logs or external build notes, write a receipt:

```sh
pnpm --dir runtime/swift run probe:toolchain -- --receipt path/to/swift-toolchain-probe.json
```

To print the currently documented official install command:

```sh
pnpm --dir runtime/swift run probe:install
```

The probe is not a browser implementation. It is a guardrail for the native Swift/Wasm SDK baseline
that a future browser-hosted compiler bundle must match.
If multiple Wasm SDKs are installed, the probe rejects Embedded Swift-only SDKs and selects a full
`*_wasm` SDK, because wasm-idle must not expose an Embedded Swift subset as the Swift runtime.

To also verify that the native Swift Wasm SDK can execute the probe through WasmKit and preserve
stdin, run:

```sh
pnpm --dir runtime/swift run probe:toolchain -- --run-wasm
```

Use `--sdk-id <id>` to select an exact installed SDK for a local baseline or snapshot compiler.
The compiler and SDK must have matching full Swift versions because Swift standard-library modules
are precompiled and are not import-compatible across patch-version differences.

That optional check runs the compiled program with `hello wasm-idle\n` on stdin and requires exact
stdout `swift-stdin:hello wasm-idle\n`.

## Runtime manifest contract

A future `static/wasm-swift/runtime-manifest.v1.json` must use
`wasm-swift-runtime-manifest-v1` and include at least these files:

- `runner-worker.js`
- `swiftc.wasm`
- `swiftpm.wasm`
- `sdk.tar.gz`

Each manifest file entry records a relative path, byte size, and SHA-256 digest. The manifest is
also stamped with the Swift browser `runtimeContract` format and version used by the packaged
bundle. It is validated by:

```sh
pnpm --dir runtime/swift run validate:manifest path/to/runtime-manifest.v1.json
```

The validator also checks the runtime bundle file signatures: `swiftc.wasm` and `swiftpm.wasm`
must start with the WebAssembly binary magic header, and `sdk.tar.gz` must start with a gzip archive
header. SwiftWasm `.artifactbundle.zip` SDK release files are rejected when placed at `sdk.tar.gz`;
use a verified gzip SDK archive or an explicit conversion step with provenance. This keeps fixture
or placeholder files from being synced as a real Swift compiler bundle.

Once a real browser-hosted compiler bundle exists, package the raw build output into
`runtime/swift/dist` with:

```sh
pnpm --dir runtime/swift run fetch:official-sdk -- --output path/to/raw-swift-runtime/sdk.tar.gz
```

That helper downloads the documented Swift.org Wasm SDK artifact, verifies its SHA-256 checksum,
and writes it to the `sdk.tar.gz` path expected by the package step. It does not build
`swiftc.wasm` or `swiftpm.wasm`; those still must come from a real browser-hosted compiler build.

To assemble the raw runtime directory from explicit build outputs and validate that it is ready for
packaging, run:

```sh
pnpm --dir runtime/swift run prepare:raw-runtime -- \
  --source-dir path/to/raw-swift-runtime \
  --runner-worker path/to/runner-worker.js \
  --swiftc-wasm path/to/swiftc.wasm \
  --swiftpm-wasm path/to/swiftpm.wasm \
  --fetch-official-sdk
```

Use `--sdk-archive path/to/sdk.tar.gz` instead of `--fetch-official-sdk` when the SDK archive was
created by the same local build recipe. This preparation step verifies the runner worker contract
and file signatures before `package:wasm-swift` records provenance and writes the manifest.

```sh
pnpm run package:wasm-swift -- --source-dir path/to/raw-swift-runtime --swift-version 6.3.3 --wasm-sdk-id swift-6.3.3-RELEASE_wasm --source "upstream/build provenance"
```

`--source` is required for every packaged dist and should identify the upstream compiler build or
local build recipe. When the bundle is based on a Swift.org Wasm SDK artifact, also pass
`--official-wasm-sdk-provenance` for the documented official SDK, or pass `--wasm-sdk-url` and
`--wasm-sdk-checksum` explicitly for another Swift.org artifact; these optional fields are validated
and persisted in `runtime-build.json`. The same metadata records the Swift browser runtime contract
format and version used by the package step. Add `--browser-contract` to run the staged package
through Chromium before replacing `runtime/swift/dist`.
The package source may already store large compiler modules as gzip-only `swiftc.wasm.gz` and
`swiftpm.wasm.gz`; package metadata still records the logical `swiftc.wasm` and `swiftpm.wasm`
runtime paths, and manifest validation hashes the decompressed wasm bytes.

When the real bundle is built on a large CI worker, export the packaged `dist` into a publishable
archive before uploading it:

```sh
pnpm run export:wasm-swift:strict -- \
  --bundle-dir runtime/swift/dist \
  --out-dir runtime/swift/out \
  --url https://example.invalid/wasm-swift-runtime.tar.gz
```

The export command validates `runtime-manifest.v1.json`, `runtime-build.json`, and runtime file
signatures, optionally requires build-plan, source bootstrap receipt, browser build command,
browser build execution, and upstream baseline receipt provenance, optionally reruns the browser
contract, then writes a `.tar.gz` archive, matching
`.sha256` file, and `wasm-swift-runtime-export-v1` descriptor JSON. The descriptor records the
archive SHA-256, manifest fingerprint, Swift/Wasm SDK versions, runtime contract, file list, and
`runtime-build.json` SHA-256 digest, plus an optional published URL. Its SHA-256 value can be
passed directly to `import:wasm-swift` or `import-sync:wasm-swift` as `--input-sha256`.
The root `export:wasm-swift:strict` shortcut enables `--require-build-plan-provenance`,
`--require-source-bootstrap-provenance`, `--require-browser-build-command-provenance`,
`--require-browser-build-execution-provenance`, `--require-browser-build-log-provenance`,
`--require-upstream-baseline-provenance`, and
`--browser-contract` by default; use the lower-level
`export:wasm-swift` only for non-candidate diagnostic archives.
The descriptor itself can also be used directly. If it contains a published `url`, import downloads
that URL and verifies `archiveSha256`; otherwise it reads `archiveFile` next to the descriptor:

```sh
pnpm run import:wasm-swift -- --input-descriptor runtime/swift/out/wasm-swift-runtime.tar.gz.json
```

The repository also includes a manual GitHub Actions workflow for this export step:
`.github/workflows/wasm-swift-runtime.yml`. It is `workflow_dispatch` only because the checkout and
browser compiler build are large. Run it on a runner with enough disk space, optionally provide
paths for externally produced `runner-worker.js`, `swiftc.wasm`, `swiftpm.wasm`, and `sdk.tar.gz`,
and set `min_free_gib` when the runner should use a threshold other than the default 80 GiB. The
workflow will run the Swift/Wasm baseline probe with a receipt, write the build plan, verify browser
compiler outputs, package from that plan, run `export:wasm-swift:strict`, and upload the archive,
`.sha256`, descriptor JSON, and a `PROMOTE.md` command note as the `wasm-swift-runtime` artifact.
It also uploads a diagnostics artifact with the browser build log, output contract, output summary,
workflow preflight receipt, toolchain probe receipt, bootstrap receipt, build plan, and staged
runtime metadata when those files exist.
After downloading and unpacking that artifact locally, import the descriptor through the same strict
staged publish path and apply the gated registration in one promotion step:

```sh
pnpm run promote:wasm-swift-artifact -- \
  --artifact-dir path/to/wasm-swift-runtime
```

`promote:wasm-swift-artifact` finds the single `*.tar.gz.json` export descriptor in the downloaded
artifact directory, verifies the sibling archive exists and matches the descriptor SHA-256, then
delegates to the strict promotion path. If the descriptor path should be selected explicitly instead,
use the lower-level promotion command:

```sh
pnpm run promote:wasm-swift -- \
  --prefer-descriptor-archive-file \
  --input-descriptor path/to/wasm-swift-runtime/wasm-swift-<fingerprint>.tar.gz.json
```

`promote:wasm-swift` enables the same strict descriptor metadata, compression, build-plan,
source bootstrap, browser build command/execution/log, upstream baseline provenance, compressed
manifest, and browser contract gates as `import-sync:wasm-swift:strict`, then runs
`apply:wasm-swift-registration`. Use `--dry-run-registration` when the candidate should be synced
but the app registration edits should only be planned.
If registration should remain a separate reviewed change, run the strict staged publish path
manually:

```sh
pnpm run import-sync:wasm-swift:strict -- \
  --prefer-descriptor-archive-file \
  --input-descriptor path/to/wasm-swift-runtime/wasm-swift-<fingerprint>.tar.gz.json
```

`--prefer-descriptor-archive-file` makes this local artifact path deterministic even when the
descriptor also records a `published_url`; without it, descriptor imports use the recorded URL first.
The workflow runs `preflight:wasm-swift-workflow` before the expensive steps. If
`bootstrap_source` is false, provide `checkout_root` pointing at an existing Swift monorepo checkout
and `source_bootstrap_receipt` pointing at a passed receipt for that checkout; strict candidate
artifacts require source bootstrap provenance, and preflight rejects receipts that did not pass or
whose `sourceRoot` does not match `checkout_root`. If any external compiler output path is provided,
`runner-worker.js`, `swiftc.wasm`, and `swiftpm.wasm` must be provided together.
`browser_build_command` is required even when those explicit output paths are provided, because
exported candidate artifacts must record `browserCompilerBuild.command` provenance for the final
readiness gate. The preflight step writes `wasm-swift-workflow-preflight.json` into the diagnostics
artifact even when validation fails, preserving the dispatch inputs, normalized paths, disk probe,
explicit output paths, and preflight errors used for the run. When the workflow runs that command
through the build harness, the generated build plan also records `browserCompilerBuild.execution`,
and strict package/export/readiness gates reject artifacts without a passed execution receipt. The
preflight also checks the workflow build directory
against the same 80 GiB default free-space threshold used by the local
doctor, or the `min_free_gib` workflow input when overridden, so undersized runners fail before
clone/build steps begin. The same threshold is passed to the source checkout and upstream baseline
steps. When `bootstrap_source` is true, optional `swift_clone_depth` and `swift_clone_filter` inputs
are forwarded to the initial `swift.git` clone for shallow or partial CI checkouts. Set
`browser_build_command` to the shell command that creates the browser compiler outputs
before the verification step. The
workflow exposes
`WASM_SWIFT_SOURCE_ROOT`, `WASM_SWIFT_BUILD_DIR`,
`WASM_SWIFT_RAW_RUNTIME_DIR`, `WASM_SWIFT_BUILD_PLAN`, `WASM_SWIFT_RUNNER_WORKER`,
`WASM_SWIFT_SWIFTC_WASM`, `WASM_SWIFT_SWIFTPM_WASM`, and `WASM_SWIFT_SDK_ARCHIVE` to that command.
The default build plan expects browser compiler outputs at those four output paths unless the
workflow inputs override them with explicit artifact paths. When provided, the command is also
recorded in `browserCompilerBuild.command` inside the generated build plan, so the exported runtime
can be traced back to the actual browser compiler build invocation. The workflow prints this output
contract before running `browser_build_command`, so failed artifact production leaves the expected
paths visible in the Actions log. Immediately after the command, the workflow also summarizes
whether each expected file exists and how many bytes were written before the stricter verifier reads
the build plan and validates signatures/contracts. When no explicit compiler output inputs are
provided, the workflow then runs `discover:wasm-swift-build-outputs -- --write-plan` against
`WASM_SWIFT_BUILD_DIR` so nested outputs can update the build plan before the upstream baseline,
packaging, export, and readiness provenance gates run. The workflow always uploads a
`wasm-swift-runtime-diagnostics` artifact with the workflow preflight receipt, native toolchain
probe receipt, source bootstrap receipt, output contract, output summary, build plan, and any
packaged manifest/build metadata that exist, so failed long-running builds leave enough context for
the next run.

If the browser-hosted compiler bundle was produced on another machine or CI worker, import the
directory or archive instead of manually unpacking it into `dist`:

```sh
pnpm run import:wasm-swift -- \
  --input path/to/swift-browser-runtime.tar.gz \
  --swift-version 6.3.3 \
  --wasm-sdk-id swift-6.3.3-RELEASE_wasm \
  --source "external Swift browser compiler build" \
  --official-wasm-sdk-provenance \
  --browser-contract
```

For CI artifacts or release assets that are already published over HTTP, use `--input-url` with an
explicit archive digest:

```sh
pnpm run import:wasm-swift -- \
  --input-url https://example.invalid/swift-browser-runtime.tar.gz \
  --input-sha256 <64-hex-sha256> \
  --swift-version 6.3.3 \
  --wasm-sdk-id swift-6.3.3-RELEASE_wasm \
  --source "external Swift browser compiler build" \
  --official-wasm-sdk-provenance \
  --browser-contract
```

`--input` accepts a bundle directory, `.tar.gz`, `.tgz`, or `.zip` archive. Add
`--input-sha256` with local archives when the archive digest should be checked before unpacking.
`--input-url` accepts an HTTP(S) `.tar.gz`, `.tgz`, or `.zip` archive and requires
`--input-sha256` before unpacking.
`--input-descriptor` accepts the `wasm-swift-runtime-export-v1` JSON written by `export:wasm-swift`
and uses its archive URL or sibling archive file, SHA-256, Swift version, Wasm SDK id, and build
source metadata. Descriptor imports verify `archiveSha256` before unpacking, then compare any
fingerprint, runtime contract, or file-list metadata with the packaged manifest. They also
verify `runtimeBuildSha256` against the imported `runtime-build.json` and reject mismatches. With
`--input-descriptor`, add `--prefer-descriptor-archive-file` to read the descriptor's sibling
`archiveFile` even when the descriptor records a published URL. The
`--require-descriptor-metadata` option requires all four receipt fields before import; the strict
import-sync shortcut enables that option by default. The
import command locates the single bundle root containing `runner-worker.js`,
`swiftc.wasm` or `swiftc.wasm.gz`, `swiftpm.wasm` or `swiftpm.wasm.gz`, and `sdk.tar.gz`, then runs
the same package validator that `package:wasm-swift` uses. Ambiguous archives with multiple bundle
roots are rejected. The packaged `runtime-build.json` notes record the absolute import input path,
URL, or descriptor path, the input archive SHA-256 when the input is a file, URL, or descriptor, and
a deterministic SHA-256 of the imported bundle tree.
To import, sync, compress, and run the final candidate readiness gate in one staged publish flow,
use the descriptor produced by `export:wasm-swift:strict`:

```sh
pnpm run import-sync:wasm-swift:strict -- \
  --prefer-descriptor-archive-file \
  --input-descriptor path/to/wasm-swift-runtime/wasm-swift-<fingerprint>.tar.gz.json
```

`import-sync:wasm-swift` accepts the same `--input-url`, `--input-sha256`, and
`--input-descriptor` options as `import:wasm-swift`, including descriptor fingerprint,
runtime-contract, and file-list checks before staging the synced assets.
Use the lower-level `import-sync:wasm-swift` script instead of the strict shortcut for diagnostic
direct-archive syncs that do not yet have descriptor receipt metadata.

With `--readiness`, sync/compress/readiness run in a staging target first. The existing
`static/wasm-swift` directory and `wasmSwiftVersion.ts` are replaced only after readiness succeeds.
The root `import-sync:wasm-swift:strict` shortcut enables `--require-descriptor-metadata`,
`--compress-static`, `--readiness`, `--readiness-require-build-plan-provenance`,
`--readiness-require-source-bootstrap-provenance`,
`--readiness-require-browser-build-command-provenance`,
`--readiness-require-browser-build-execution-provenance`,
`--readiness-require-browser-build-log-provenance`,
`--readiness-require-upstream-baseline-provenance`,
`--readiness-require-compressed-manifest`, and `--readiness-browser-contract` by default. Use it
when importing an archive exported from `package:wasm-swift-from-plan`; those flags require the
embedded `runtime-build.json` provenance and snapshots to match the final candidate readiness gate.

The packaged dist includes `runtime-build.json` with this contract:

```json
{
  "format": "wasm-swift-runtime-build-v1",
  "swiftVersion": "6.3.3",
  "wasmSdkId": "swift-6.3.3-RELEASE_wasm",
  "wasmSdkUrl": "https://download.swift.org/.../swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz",
  "wasmSdkChecksum": "cabfa08b73bb8ac783927ecd15fa386e99d0c139c5f232445067bcf58379cae7",
  "runtimeContract": {
    "format": "wasm-swift-runtime-contract-v1",
    "version": 2
  },
  "runnerWorker": "runner-worker.js",
  "compilerWasm": "swiftc.wasm",
  "packageManagerWasm": "swiftpm.wasm",
  "sdkArchive": "sdk.tar.gz",
  "source": "upstream/build provenance note"
}
```

Then sync the packaged bundle into the app with:

```sh
pnpm run sync:wasm-swift runtime/swift/dist static/wasm-swift
```

`sync:wasm-swift` requires the packaged `runtime-manifest.v1.json` and `runtime-build.json`
source provenance; raw file bundles are rejected, and unprovenanced bundles are rejected.
The synced target also receives `sync-receipt.v1.json`, which records the source directory,
target directory, version module path, manifest fingerprint, Swift/SDK IDs, runtime contract, and
`runtime-build.json` SHA-256 digest used for the asset publication.
The source bundle may store large compiler modules as gzip-only `swiftc.wasm.gz` and
`swiftpm.wasm.gz` files. They are copied as compressed assets, while the manifest remains keyed by
the logical `swiftc.wasm` and `swiftpm.wasm` paths and is validated against the decompressed wasm
bytes. In that gzip-only case, direct sync also updates the root
`compressed-runtime-assets.v1.json`, replacing stale `wasm-swift/*` entries while preserving other
runtime entries. If a later direct sync uses uncompressed `swiftc.wasm` and `swiftpm.wasm`, stale
`wasm-swift/*` compressed manifest entries are removed.
The direct sync CLI accepts only optional `sourceDir` and `targetDir` positional arguments.

## Browser runtime contract

The future `runner-worker.js` must satisfy the machine-readable contract emitted by:

```sh
pnpm --dir runtime/swift run contract
```

The contract cases cover the minimum behavior required before `SWIFT` can be exposed in the
playground: single-line and multi-line `readLine()` stdin, `CommandLine.arguments`, multi-file
workspace compilation, worker progress, output, success, and error messages. It also verifies that
invalid Swift source reports a matching compiler error instead of posting a successful result. These
cases are intentionally about real Swift programs, not a compatibility subset. The current contract
snapshot uses `version: 2`; any build plan with an older `browserCompilerBuild.runtimeContract`
snapshot must be regenerated before packaging or readiness can pass.

After a real bundle is synced, run the browser contract probe:

```sh
pnpm --dir runtime/swift run validate:contract -- ../../static/wasm-swift
```

This launches Chromium, serves the bundle locally, creates `runner-worker.js` as a browser worker,
validates the packaged manifest and `runtime-build.json` provenance, and checks every contract case
against exact stdout or the expected compiler error.
Use `--timeout-ms <positive-integer>` only when a real compiler bundle needs a longer browser
contract window.

Before registering `SWIFT` in the playground, run the candidate readiness gate:

```sh
pnpm run verify:wasm-swift-candidate
```

That command intentionally does not require `SWIFT` registration yet, but it does require the real
synced bundle, non-manual asset version, build-plan provenance, browser build command provenance,
browser build execution provenance, source bootstrap receipt provenance, upstream baseline receipt
provenance, static compressed asset manifest, and browser contract probe to pass.
It is the gate for proving a real Swift bundle is ready for the registration change.
After that candidate gate is green, print the app registration plan:

```sh
pnpm run plan:wasm-swift-registration
```

The plan command reruns the same candidate readiness requirements and then lists every app file and
metadata surface that must be changed for registration. It fails if candidate readiness is not
green, or if `SWIFT` is already registered.
When the candidate bundle is ready, the same gate can apply the registration edits automatically:

```sh
pnpm run apply:wasm-swift-registration
```

That command updates the core language ids, playground route, page language registry, support
matrix source, and regenerated README support table. It refuses to write those files unless the
real Swift bundle passes the candidate readiness gate first. After writing, it reruns the strict
readiness gate with `--require-registered`, so a registration apply only exits successfully when the
registered app surfaces, compressed asset manifest, provenance, and browser contract all still pass.
Add `--dry-run` to see the file list without writing.

After registering `SWIFT` in the playground, run the final readiness gate:

```sh
pnpm run verify:wasm-swift-readiness
```

That command requires `SWIFT` to be registered in `packages/core/src/languages.ts`
(`WasmIdleLanguageId`, `supportedLanguageIds`, and `DEFAULT_DEFERRED_PROGRESS_LANGUAGES`),
`src/lib/playground/index.ts` (`supportedLanguages`, a `SWIFT` sandbox route alias, and a dynamic
`$lib/playground/swift` import that constructs `new Swift()`), `src/routes/language-registry.ts`
(`PlaygroundLanguage`, `playgroundLanguages`, `languageLabels`, `editorLanguages`,
`argsHelpLanguages`, `compilerDiagnosticLanguages`, `diagnosticMarkerLanguages`, and a
`monacoLanguageContributionLoaders.swift` entry for Monaco's Swift contribution), and
`scripts/support-matrix.mjs` (a `Swift` support row with `SWIFT`, `stdin: Yes`, and browser test
metadata, with no blocked candidate row),
checks that the synced asset version matches the manifest fingerprint, validates bundle file
signatures and hashes, requires `runtime-build.json` source provenance to match the manifest,
requires `sync-receipt.v1.json` to match the manifest fingerprint and `runtime-build.json` digest,
verifies any recorded `wasmSdkChecksum` against the bundled `sdk.tar.gz` bytes,
re-reads the recorded build plan and upstream baseline receipt files, verifies their SHA-256
digests and contract/status metadata, requires the build plan's
`browserCompilerBuild.command` provenance,
passed `browserCompilerBuild.execution` receipt,
`browserCompilerBuild.requiredOutputs` and `browserCompilerBuild.runtimeContract` snapshot to match
the current verifier, verifies the static compressed asset manifest for gzip-only Swift compiler
modules, and then runs the browser contract probe. It is expected to fail until a real browser-hosted
Swift compiler bundle has been synced and `SWIFT` is intentionally exposed.
When forwarding readiness flags, use `--timeout-ms <positive-integer>` only with
`--browser-contract`.

The root browser-test entrypoint delegates to the same readiness gate:

```sh
pnpm run test:browser:swift
```

## Registration checklist

Do not register `SWIFT` until all of these are true:

- `pnpm run package-sync:wasm-swift-from-plan:strict -- --plan ... --swift-version ... --wasm-sdk-id ... --source ...`
  has produced `runtime/swift/dist/runtime-build.json`, `static/wasm-swift/runtime-manifest.v1.json`, and a non-`manual`
  `src/lib/playground/wasmSwiftVersion.ts` fingerprint from a verified build plan with source
  provenance, recorded browser compiler build command provenance, a passed browser compiler build execution receipt,
  a passed upstream baseline receipt, and a passing browser runtime contract.
- `pnpm run compress:static-runtimes` keeps the Swift manifest valid when `swiftc.wasm` and
  `swiftpm.wasm` are served as gzip-only `.wasm.gz` files.
- `pnpm run doctor:wasm-swift:candidate` passes before the registration change, proving the synced
  bundle is ready for the same candidate checks with doctor output.
- `pnpm run verify:wasm-swift-candidate` passes before the registration change; if this fails, the
  bundle is not ready to expose even if the TypeScript registration edits are straightforward.
- `pnpm run doctor:wasm-swift:strict` passes after the registration change, before the final
  readiness gate.
- `pnpm run verify:wasm-swift-readiness` passes after `SWIFT` is intentionally added to
  `packages/core/src/languages.ts` (`WasmIdleLanguageId`, `supportedLanguageIds`, and
  `DEFAULT_DEFERRED_PROGRESS_LANGUAGES`), `src/lib/playground/index.ts`,
  `src/routes/language-registry.ts` (`PlaygroundLanguage`, `playgroundLanguages`,
  `languageLabels`, and `editorLanguages`), and the support matrix as a stdin-capable Swift row
  with browser test metadata.
- The temporary Swift exclusion guards in
  `src/lib/playground/core-language-contract.test.ts`, `src/lib/playground/index.test.ts`, and
  `src/routes/language-registry.test.ts` are replaced with positive registration tests in the same
  change.
