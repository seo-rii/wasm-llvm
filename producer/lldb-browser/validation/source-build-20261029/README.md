# Source-built debugger qualification

The checked-in Clang, LLDB and WAMR artifacts passed their producer checks and
the recorded native and Chromium sessions. [qualification.json](qualification.json)
binds these results to the exact runtime manifest and authenticated Actions
artifact digests.

- Debugger source: `7bd1d38d61c6602fd05260f04af979abbfdc8e0f`.
- Clang source: `ff18b37c934f7526885f5a49d77698712615f23a`.
- Public wasm-idle consumer: `372415901d25b85d709f19e06c143963b4565c2e`.
- [Clang build](https://github.com/seo-rii/wasm-llvm/actions/runs/40811368673).
- [Native qualification and two clean LLDB/WAMR builds](https://github.com/seo-rii/wasm-llvm/actions/runs/40789115130).

The source-build workflows ran before replacement artifacts were checked in,
so their historical delivery-provenance jobs describe the previous bytes.
Each accepted build job and its producer-contract prerequisites passed. The
replacement artifacts must also pass the current repository provenance jobs.

[browser-qualification.json](browser-qualification.json) records the exact
compiler/debugger bytes, derived C/C++ sysroots, strict-CSP sessions, module
cache off/off/on/on, recursive frames and caller locals, four official UI cases,
and C++ adaptor/function-end sessions. [ui-vitest.json](ui-vitest.json) preserves
the UI runner result. The `native/` directory contains source inputs, binary and
fixture hashes, function-end/adaptor transcripts and hit-condition results.

Clean patched native Clang/LLDB binaries passed function-end stepping and live
locals, two adaptor/deque stops, and the three DAP hit-condition cases. The
separate command/DAP/trap/interrupt baselines used the pinned upstream LLVM
22.1.8 binaries. [native-evidence-verification.json](native-evidence-verification.json)
records independent source-patch and transcript checks. Native executable hashes
were rechecked by CI; the evidence archive contains their hash records, not binaries.
[clang-evidence-verification.json](clang-evidence-verification.json) records an
independent reconstruction of the pinned compiler source inputs and receipt
checks. It does not establish an independent rebuild of the compiler output.

The scripts under [harness/](harness/) preserve the seven custom qualification
helpers; the cache and UI probes come from the pinned consumer commit. Script
hashes in the browser report identify the code actually executed. The recorded
absolute paths are historical locations and may be changed for a new run.

To repeat the browser qualification:

1. Rebuild the pinned producer inputs and verify the Clang, LLDB and WAMR
   packages. Use `producer/clang-browser/scripts/prepare-release.mjs` with
   `WASM_LLVM_CLANG_ARTIFACT_DIR`, `WASM_LLVM_LLDB_ARTIFACT_DIR` and
   `WASM_LLVM_WAMR_ARTIFACT_DIR` pointing to those verified producer directories
   to assemble the ordinary release layout in a new directory.
2. Copy only the seven harness scripts and `configuration.json` into a new empty
   directory on persistent storage. Set `gitDirectory` to a private consumer Git
   repository with an `origin` remote, `dependencyDonor` to an installed checkout
   with the pinned consumer lockfile, and `producerRepository` to a local producer
   Git repository containing the recorded debugger source commit. Set
   `supportAssetDonor` to a local static cache containing the files pinned by the
   consumer's browser-test manifest. Preserve the recorded source revisions.
   Keep result/identity files separate; preparation refuses an existing frozen
   fixture. Keep the private Git metadata on persistent storage as well.
3. Run `python3 prepare.py --consumer-revision 372415901d25b85d709f19e06c143963b4565c2e`,
   then `python3 build-packages.py` and `python3 run.py --dry-run`. Preparation
   uses a separate sparse worktree and copies the C/Rust assets plus pinned
   compiler, container and editor files required to start the official UI.
4. Read `python3 run.py --help` for the exact argument syntax. Pass the recorded
   debugger revision as `--producer-revision` and the compiler revision as
   `--clang-producer-revision`. Supply the ordinary release directory for both
   `--bundle` and `--clang-source`, its `runtime-manifest.v2.json` SHA-256 for
   `--manifest-sha256`, the original producer receipt paths for `--lldb-receipt`
   and `--wamr-receipt`, and the Clang receipt SHA-256 for
   `--clang-receipt-sha256`. Choose a new `--report` path. All hashes must identify
   the newly assembled bytes. Pass these arguments to `python3 launch.py` and
   monitor the returned process and status paths through termination.

The harness builds the official UI and runs Chromium on an isolated loopback
preview. It validates asset and helper identities again after execution and
retains private phase logs. Its task-specific temporary directory is recorded in
the report and retained for post-run inspection. A started command or partial
report is not a passed run; a new result qualifies only its own recorded bytes.
Sequential browser samples qualify behavior without establishing a controlled
latency improvement. Release publication and consumer deployment are separate.
