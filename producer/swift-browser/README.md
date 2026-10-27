# Swift browser compiler producer

This producer creates and verifies a full Swift compiler toolchain for browser hosting. It does not
contain a Swift parser, language subset, or browser editor integration. The consumer-side worker
host and runtime loader live outside this repository.

`manifest.json` pins the Swift release, resolved source commit, official Wasm SDK, SDK checksum,
and every local patch hash. Build plans and exported bundles carry the effective source checkout,
commands, output checksums, and browser contract receipts so an artifact can be traced back to its
producer inputs.

The recipe targets Swift 6.4.1 and its matching full Wasm SDK. The SDK URL and checksum
come from the [official Wasm installation instructions](https://www.swift.org/documentation/articles/wasm-getting-started.html).
The complete 92,759,931-byte SDK archive was downloaded on 2026-10-27 and matched the pinned
SHA-256. [The observed input receipt](validation/6.4.1-sdk.json) records the full and embedded
SDK metadata, target triple, archive structure, and selected standard-library hashes. This
qualifies the target SDK input; the browser-hosted compiler still requires its full build and
acceptance checks below.
The WASI patches were checked against the `swift-6.4.1-RELEASE` source commits:

| Repository | Commit |
| --- | --- |
| `swiftlang/swift` | `6e2c19458fdccc3257f9abdad2cfeacf27c6c1a4` |
| `swiftlang/llvm-project` | `51091bd668a61591b761afe08e2776476e20ff1c` |
| `swiftlang/swift-syntax` | `050f1a346fbbac0ca2cfb15a95274f7bd1cf0ccf` |

Swift 6.4.1 uses its own LLVM 21.1 fork, so the native Clang resource directory remains
`lib/clang/21`. Its dependency scanner now shares daemon code between Unix and Windows;
the WASI patch excludes the daemon while retaining inline dependency scanning. The patch
also preserves the upstream retry handling for interrupted file-lock operations.

Patch application and producer tests do not qualify a rebuilt compiler. Native baseline,
WASI frontend, Chromium target and complete browser compiler validation must be repeated
for 6.4.1 before publishing artifacts. The [recorded 6.3.3 acceptance](browser-target-audit.md)
remains historical evidence for that earlier toolchain.

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
requires 80 GiB free. A native Swift 6.4.1 installation and the matching Wasm SDK are used to prove
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

## Browser target stdin baseline

After installing the pinned native Swift toolchain and full Wasm SDK, run:

```sh
pnpm probe:swift-browser-target
# Use an existing Chromium installation when needed:
pnpm probe:swift-browser-target -- --chromium /path/to/chromium
```

This compiles `fixtures/browser-stdin.swift` with native SwiftPM and executes the resulting
WASI Preview 1 program in fresh Chromium Workers. The fixture uses standard `readLine`,
collections, integer arithmetic, and `print`; acceptance covers UTF-8, input delivered in short
reads, a final line without a newline, and empty input followed by EOF. Each case must return
the exact expected stdout, empty stderr, and exit code zero within 15 seconds.

The local server and Worker under `test/` are acceptance tools. Product runtime integration
belongs to `wasm-idle`. The receipt in `out/swift-browser-target/probe-*/receipt.json` records
the native toolchain version, SDK identifier, source and target hashes, Chromium version, and
each result. It sets `compilerHost: native` and leaves browser compiler, browser SwiftPM, and
release readiness gates false. This command verifies target execution; packaging still requires
the existing browser compiler contracts below. See [the recorded validation](browser-target-audit.md).

## Bootstrap source

First write a checkout plan. Add `--execute` only when the large clone and dependency checkout
should run.

```sh
pnpm --dir producer/swift-browser run bootstrap:source -- \
  --source-root /data/wasm-llvm-swift/source \
  --swift-ref swift-6.4.1-RELEASE \
  --dependency-scheme release/6.4.1 \
  --swift-clone-depth 1 \
  --swift-clone-filter blob:none \
  --receipt /data/wasm-llvm-swift/source-bootstrap-receipt.json \
  --execute
```

The default ref resolves to commit `6e2c19458fdccc3257f9abdad2cfeacf27c6c1a4`. For the default
repository/ref/scheme combination, bootstrap adds `--tag swift-6.4.1-RELEASE` to
`update-checkout` so the dependency update retains the release instead of switching Swift
to the newer release-branch tip. Custom repository/ref/scheme combinations retain their
requested scheme behavior. The bootstrap receipt records the selected repository and ref,
clone options, dependency scheme and release tag, disk probe,
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
  --swift-version 6.4.1 \
  --wasm-sdk-id swift-6.4.1-RELEASE_wasm \
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
