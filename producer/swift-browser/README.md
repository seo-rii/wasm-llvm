# Swift browser compiler producer

This producer creates and verifies a full Swift compiler toolchain for browser hosting. It does not
contain a Swift parser, language subset, or browser editor integration. The consumer-side worker
host and runtime loader live outside this repository.

`manifest.json` pins the Swift release, resolved source commit, official Wasm SDK, SDK checksum,
and every local patch hash. Build plans and exported bundles carry the effective source checkout,
commands, output checksums, and browser contract receipts so an artifact can be traced back to its
producer inputs.

## Artifact contract

A raw browser compiler build must produce:

- `runner-worker.js`
- `swiftc.wasm`
- `swiftpm.wasm`
- `sdk.tar.gz`

The packaging step compresses large WebAssembly modules, writes `runtime-manifest.v1.json`, and
writes `runtime-build.json` with source, build-plan, SDK, patch, and browser-contract provenance.
The export step emits a deterministic archive, a SHA-256 sidecar, and a JSON descriptor. Those
files are uploaded to external static hosting; they are never npm package content.

## Prerequisites

The source checkout and compiler build require a large Linux workspace. The default disk preflight
requires 80 GiB free. A native Swift 6.3.3 installation and the matching Wasm SDK are used to prove
the upstream baseline before browser compiler artifacts are accepted.

```sh
pnpm --dir producer/swift-browser run probe:install
pnpm --dir producer/swift-browser run probe:toolchain -- --run-wasm \
  --receipt /tmp/swift-toolchain-probe.json
pnpm swift:doctor
```

The official SDK URL and checksum are recorded in `manifest.json` and exposed by
`scripts/probe-toolchain.mjs`. Embedded-only SDKs are rejected because this producer targets full
Swift.

## Bootstrap source

First write a checkout plan. Add `--execute` only when the large clone and dependency checkout
should run.

```sh
pnpm --dir producer/swift-browser run bootstrap:source -- \
  --source-root /data/wasm-llvm-swift/source \
  --swift-ref swift-6.3.3-RELEASE \
  --dependency-scheme release/6.3 \
  --swift-clone-depth 1 \
  --swift-clone-filter blob:none \
  --receipt /data/wasm-llvm-swift/source-bootstrap-receipt.json \
  --execute
```

The default ref resolves to commit `064859e41d68596f486c5d724401cb370f260409`. The bootstrap
receipt records the selected repository and ref, clone options, dependency scheme, disk probe,
commands, required checkout files, and pass/fail status. Retain that receipt with the build plan.

## Build plan

The browser build command is explicit because upstream Swift does not provide the complete
`runner-worker.js`/`swiftc.wasm`/`swiftpm.wasm` set as one reproducible release bundle. The command
must write the required outputs into the paths supplied by the producer.

```sh
pnpm --dir producer/swift-browser run build:browser-compiler -- \
  --checkout-root /data/wasm-llvm-swift/source \
  --build-dir /data/wasm-llvm-swift/build \
  --source-bootstrap-receipt /data/wasm-llvm-swift/source-bootstrap-receipt.json \
  --browser-build-command '<pinned build command>' \
  --execute-browser-build-command \
  --discover-build-outputs \
  --fetch-official-sdk
```

This writes `wasm-idle-swift-browser-build-plan.json`. The historical filename and receipt format
are retained for compatibility, but the plan is owned by this producer. It records source roots,
the command and execution status, required outputs, build log, SDK provenance, and runtime contract.

For the direct WASI compiler experiments and the matching frontend verification, use:

```sh
pnpm --dir producer/swift-browser run build:wasi-compiler -- --help
pnpm --dir producer/swift-browser run build:wasi-frontend -- --help
pnpm --dir producer/swift-browser run verify:wasi-frontend -- --help
```

These commands apply the checked-in LLVM, Swift, and SwiftSyntax platform patches. They leave
receipts in the selected build directory and never modify an installed compiler runtime.

## Verify outputs

Run the upstream Swift/WASI baseline and then verify the browser build plan before packaging:

```sh
pnpm --dir producer/swift-browser run run:upstream-baseline -- \
  --plan /data/wasm-llvm-swift/build/wasm-idle-swift-browser-build-plan.json \
  --preset buildbot_linux_crosscompile_wasm

pnpm --dir producer/swift-browser run verify:build-outputs -- \
  --plan /data/wasm-llvm-swift/build/wasm-idle-swift-browser-build-plan.json \
  --prepare-raw-runtime \
  --require-browser-compiler-contracts \
  --require-browser-build-command \
  --require-browser-build-execution \
  --require-browser-build-log \
  --require-source-bootstrap-provenance
```

Verification rejects malformed WebAssembly, missing worker contracts, incomplete source receipts,
unexecuted build commands, stale build logs, unverified SDK inputs, and output paths that do not
match the plan.

## Package and export

```sh
pnpm --dir producer/swift-browser run package:from-plan -- \
  --plan /data/wasm-llvm-swift/build/wasm-idle-swift-browser-build-plan.json \
  --dist-dir producer/swift-browser/dist \
  --swift-version 6.3.3 \
  --wasm-sdk-id swift-6.3.3-RELEASE_wasm \
  --source 'pinned source build' \
  --require-upstream-baseline-receipt \
  --require-browser-compiler-contracts \
  --require-browser-build-command \
  --require-browser-build-execution \
  --require-browser-build-log \
  --require-source-bootstrap-provenance \
  --browser-contract

pnpm --dir producer/swift-browser run export:runtime -- \
  --bundle-dir producer/swift-browser/dist \
  --out-dir producer/swift-browser/out \
  --url https://static.example.invalid/swift/
```

`--source` is required for every packaged bundle. `--browser-contract` launches Chromium through
Playwright and verifies compile errors, stdin handling, stdout, multi-file compilation, package
layout, and the compressed asset manifest before export.

## CI workflow

`.github/workflows/swift-browser-producer.yml` is manual because a full source checkout and build
are expensive. Its inputs remain explicit, but defaults use the pinned release and dependency
scheme. The workflow performs preflight, native toolchain probing, optional source bootstrap,
browser build execution, output discovery, upstream baseline, strict output verification,
packaging, browser-contract validation, and archive export. Build plans, logs, and receipts are
uploaded as diagnostics even when a later step fails.

## Focused checks

```sh
pnpm swift:test
pnpm swift:doctor
```

`swift:test` uses fixtures and temporary directories; it does not rebuild LLVM or Swift. Use each
command's `--help` output for the complete option list.
