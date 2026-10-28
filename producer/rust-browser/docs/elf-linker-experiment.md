# Browser-only ELF linker experiment

This opt-in experiment compares two source-built Rust browser compilers. It does
not change the normal producer manifest, publish artifacts, or update a consumer.
The candidate excludes ELF only when compiling `rustc_llvm` for
`wasm32-wasip1-threads`. Native bootstrap Rust retains ELF.

The candidate changes three coupled inputs:

- The browser target defines `RUST_BROWSER_WASM_ONLY_LLD` and omits the
  `rustc-link-lib=static=lldELF` directive. Other targets keep that directive.
- The C++ bridge omits the ELF driver declaration and GNU driver mapping only
  under that define. The Wasm driver remains registered in both configurations.
- The cross-LLVM build requests `lldCommon`, `lldWasm`, and `LLVMOption`, without
  `lldELF`. The native LLVM/LLD build is unchanged.

Both experimental build scripts also pass the same job limit to `x.py`; limiting
Ninja alone would leave Rust bootstrap at its independent parallelism default.
The canonical producer remains unchanged. Derived manifests attest the exact
experimental scripts, full Rust patches, and resulting patched Git trees.

## Prepare without building

Use the exact source cache for the manifest and a prepared, validated `wasm-idle`
Rust runtime. The latter must have `dist` JavaScript, the published vendor graph,
its runtime manifest, lock files, and an installed `playwright-core`. Preparation
copies only the needed runtime/scripts/vendor bytes and Playwright into a private
snapshot. It hashes the entire pinned Chromium installation and uses that exact
executable for both arms. It does not copy a whole workspace `node_modules`.

```sh
node producer/rust-browser/scripts/prepare-elf-linker-experiment.mjs \
  --sources /retained/producer/sources \
  --consumer /isolated/wasm-idle/runtimes/wasm-rust \
  --out /new/empty-parent/rust-elf-experiment \
  --jobs 1
```

`--out` must not exist. Preparation verifies the canonical manifest and source
commit/tree identities, derives the candidate in a private Git object database,
and writes `plan.json`. It performs no downloads or compilation. The source cache
working files, original patched trees, original output and receipts are retained.
During the later build, Git registers new patched worktrees in the source cache's
Git metadata; keep that cache until the experiment worktrees are retired.

The frozen runner and probe are copied to `<out>/runner/`, and their inventory is
part of the plan. The browser snapshot includes package/producer locks, scripts,
JavaScript, actual vendor assets and the private Playwright package. The runner
and each browser arm recheck those identities and the Chromium installation.

The normal consumer receipt verifier validates every produced asset against a
derived experimental lock. Its normal memory-patching and pack-writing helpers
prepare a private runtime with fresh encoded/decoded receipts. Existing vendor
bytes are preserved. Each arm uses direct target sysroot packs, so the probe is
not a comparison against the published delta-pack delivery strategy.

Before a costly build, exercise the browser fixture using a retained, matching
producer output and its original manifest:

```sh
flock /tmp/wasm-perf-browser-20261023.lock node <out>/runner/probe-elf-linker-browser.mjs \
  --plan <out>/plan.json --variant baseline \
  --output /retained/producer/output \
  --manifest producer/rust-browser/manifest.json \
  --report <out>/preflight-browser.json
```

## Resource, interruption and resume contract

The initial build requires at least 60 GiB available disk and 12 GiB available
memory. The producer's documented minimum physical memory is 16 GiB. Jobs default
to one and cannot exceed two. The local source cache examined for this experiment
retained 8.6 GiB of sources/patched trees and a 294 MiB output, but no build,
downloads or Cargo cache. Therefore the native/cross LLVM and Rust bootstrap
must be rebuilt; do not expect a short relink. Wall time is unmeasured and may be
many hours or longer than a day on the constrained host.

The runner uses an experiment-local `CARGO_TARGET_DIR`, `CARGO_BUILD_BUILD_DIR`,
`CARGO_HOME`, temporary directory and x.py `build-dir`. It does not inherit the
workspace's shared Cargo target. A stable `active-producer` path prevents a
profile switch from changing CMake include/toolchain paths unintentionally.

Each phase writes a private log and running/final JSON status under `phases/`.
`<phase>.latest.json` points to the latest attempt; earlier attempt records remain.
`state.json` records the current arm, runner PID, resource gate, failure and final
exit status. The outer process also forwards TERM/INT through `flock --no-fork`
to the runner. On timeout, interruption or less than 4 GiB free disk, the runner
terminates its own phase process group, escalates to KILL after ten seconds, and
checks for live descendants before writing a finished phase status. A host crash
or SIGKILL can leave a running status; that is not evidence of success.
Early direct-child exit also triggers descendant cleanup. Resume refuses to start
another build while a previous incomplete phase still has live processes; an
empty group is recorded separately as interrupted with an unknown exit status.

Run the frozen runner in a private persistent background session, redirecting
stdout/stderr from the start. Record its PID and external exit-status file. If
this is the last task step, hand off those paths after verifying startup rather
than waiting for the multi-hour build:

```sh
node <out>/runner/run-elf-linker-experiment.mjs <out>/plan.json
```

Invoke the same command to resume after reviewing a failure. Concurrent invocations
are rejected by the experiment lock. A launch attempt alone never relaxes the
initial disk gate. Only a completed native-LLVM checkpoint with matching ownership
allows subtracting the work directory's measured allocation from the original
60 GiB reservation; the remaining requirement never falls below 12 GiB. Memory
is checked before each arm. Unexpected source edits or stamp identities fail.

The producer's ordinary stamps encode only completion, so the experiment adds a
separate input-ownership receipt. It binds common bootstrap inputs and the arm's
manifest. Before candidate compilation, `llvm-cross`, `rust-stage2` and
`rust-package` stamps move to `baseline/phase-stamps/`; they are not blindly
reused. An interrupted transition can resume only with exact baseline/candidate
file hashes. The common native LLVM outputs remain available throughout.

## Outputs and acceptance

Each arm retains its manifest/patch snapshot, output and producer receipt, native
ELF compile/execute probe, and real Chromium report. Browser checks cover all
three WASI targets with stdin, collections and stdout, located type diagnostics,
metadata-success/link-failure separation, and retained DWARF for LLDB compilation.
The DWARF check is not a complete LLDB debugger-session test.

`comparison.json` records actual raw/gzip-9/Brotli-5 compiler lengths and hashes,
signed byte savings, check/compile/execute timings, and comparison controls. It
requires identical native clang/LLD/llvm-config bytes, target sysroot inventories,
consumer snapshot, Chromium engine and workload. Different output compiler bytes
are recorded explicitly; a zero reduction remains a valid experimental finding.
Single ordered observations are not a statistical speedup claim.

Do not delete native bootstrap outputs or intermediate build state before the
candidate, browser probes and comparison finish. Keep sources and the original
published producer output even after the experiment. Review actual reports in a
follow-up before deciding whether to propose a canonical producer change. The
runner never commits, pushes, publishes or deploys its output.

Focused regression command:

```sh
node --test producer/rust-browser/test/elf-linker-experiment.test.mjs \
  producer/rust-browser/test/producer.test.mjs
```

Tests compile both configurations of the C++ bridge against an explicitly labeled
driver fixture, verify candidate patch application/tree identity, and exercise
failure/timeout/disk-floor status, TERM-ignoring descendant cleanup, resource-gate
calculation and interrupted stamp transitions. These tests do not substitute for
the complete source rebuild and real compiler acceptance reports.

## Preparation validation on 2026-10-23

Fourteen focused tests and producer-only repository validation passed. Independent
process tests also verified cleanup after direct-parent failure or success,
initial status-write failure, and refusal to resume while a phase survived a
SIGKILL of its runner. An empty recovered group retains an unknown exit status.

The browser preflight passed against retained output for canonical manifest
`cfb6854a2c0b6d5102969ffa7b2b82c87aa416742a48ba436cbeb445c33f83b8`,
using Chromium `153.0.8010.12`. All three WASI targets passed metadata checking,
compile and stdin/stdout execution. Located type errors, successful metadata
followed by a link failure, and 140,617 bytes of retained `.debug_info` also passed.
This validates the fixture with the existing compiler; neither experimental arm
has been source-built yet. ELF size savings and candidate qualification remain
pending the complete build and comparison.
