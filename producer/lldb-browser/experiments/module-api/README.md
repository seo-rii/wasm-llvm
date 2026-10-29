# Verified debugger module instantiation

LLDB and WAMR opt into `instantiateWasm` in Emscripten 6.0.0's
`INCOMING_MODULE_JS_API`. The source-build recipes otherwise retain their existing
pthreads, filesystem, memory, exports and runtime-exit options. LLDB's default
artifact version advances to `llvmorg-22.1.8-lldb-web-8`. This document preserves
the October 23 local experiment. The current checked-in artifacts instead have
[full source-build qualification](../../validation/source-build-20261029/qualification.json);
the historical post-link outputs below are not used for that bundle.

The optional `moduleInstantiation: "emscripten-instantiate-wasm-v1"` contract is
written into the LLDB debug manifest and build receipt, and the WAMR receipt.
Release assembly preserves it in each RuntimeManifestV2 asset group. Absence is
the legacy path. Unknown values and LLDB manifest/receipt disagreement fail
verification. Packaging checks a lexical generated hook-call marker; that check
is not proof that an arbitrary JavaScript program invokes the hook. The actual
candidate browser test below separately observes the executed callback for the
exact recorded asset hashes.

A consumer supplies the callback to each fresh Emscripten factory. The callback
creates a new `WebAssembly.Instance` from the verified immutable Module and that
factory's imports, invokes `receiveInstance(instance, module)`, and returns the
exports. Workers, imports, shared memory and queues must remain fresh. Do not
patch generated glue or global WebAssembly functions to force unsupported assets
through this path. [Emscripten's Module API](https://emscripten.org/docs/api_reference/module.html#Module.instantiateWasm)
describes the incoming API option.

## Local generated candidate evidence

The October 23 experiment used the pinned consumer manifest
`d4b08c91cd9bc810d0862ea2a5ef5a092e52f6b22a6f3121499ec5d3df2086b5`
and LLDB Wasm
`e7146642a865ffb41cca6635c72f97bfe923be1ce7f0d930e2e59713a3ee5222`.
Native LLDB object files were unavailable. LLDB therefore used the pinned SDK's
**official experimental `emcc --post-link` path**, not a full source rebuild.
The original release had stripped target-feature metadata; the recorded
`wasm-opt --all-features --emit-target-features` step restores metadata before
post-link. The post-link invocation uses the unchanged `EMSCRIPTEN_LINK_FLAGS`
plus `-Oz` and the locked shared-ring JS library. ASYNCIFY is not enabled in the
original recipe or this invocation. Pthreads (pool eight, proxy-to-pthread), FS,
FS/callMain/HEAPU8 exports, initial/max memory, stack and runtime-exit flags remain
in the proof. Reoptimization changes the Wasm bytes, so original-versus-candidate
clocks cannot measure the Module cache.

WAMR was built from its pinned commit with all current patches in a separate
source/build tree, using the same SDK and two build jobs. Both runtime packages
passed their generated-loader, transport, source-lock, hash and size checks.
The candidate LLDB Wasm is 40,986,922 bytes; the WAMR Wasm is 278,958 bytes.

[The experiment receipt](results/20261023/experiment-receipt.json) retains both
producer receipts and the baseline/candidate manifest digests.
[The post-link proof](results/20261023/post-link-experiment.json) is bound by
`lldb.build.derivation.sha256`; it records the exact baseline manifest, input and
recovered-input digests, commands, pinned SDK revision and output hashes/sizes.
`fullSourceBuild: false` is explicit. Normal `prepare-release.mjs` **rejects** a
receipt carrying this experimental derivation. Only the local experiment
assembler accepts it and preserves the proof. It does not publish artifacts.

The wasm-idle consumer independently passed:

- [Pinned baseline, two fresh sessions](https://github.com/seo-rii/wasm-idle/blob/d33d1e1737c6ca5261f6ddddbb7b7424e078235d/scripts/performance-results/lldb-module-cache-baseline-20261023.json).
- [Identical candidate, cache off/off/on/on](https://github.com/seo-rii/wasm-idle/blob/d33d1e1737c6ca5261f6ddddbb7b7424e078235d/scripts/performance-results/lldb-module-cache-candidate-20261023.json).

Under Chromium 153.0.8010.12 and strict CSP, every enabled launch invoked the
actual consumer callback once per runtime, and both Modules were reused by
identity on the repeat. Disabled launches invoked it zero times. All four
candidate sessions had fresh workers/queues and correctly debugged a 120-level
recursive C program: navigable top frame, 100 unique paged frames, top/caller
locals, successful continue/output, no CSP violations. Observation modifies only
the probe's own loader bundle, not producer glue or global WebAssembly APIs.
These are sequential shared-host samples, not a controlled latency speedup.
The consumer cache remains opt-in and disabled by default.

## Reproduction

Use the source-locked Emscripten 6.0.0 SDK at revision
`d223ae73c6998296e3ab27cf81dc2c2c9fd383de`. The normal source-build paths remain
`producer/lldb-browser/scripts/build.mjs` and
`producer/wamr-browser/scripts/build.mjs`. To reproduce this smaller experiment,
replay the feature-recovery and post-link argument arrays in the proof, replacing
only local directory paths; retain all flags, pinned input bytes and JS library.
Record the new output hashes and command arrays in the same proof format. Then:

```sh
node producer/lldb-browser/scripts/package.mjs \
  --js "$WORK/lldb-web-dap.js" --wasm "$WORK/lldb-web-dap.wasm" \
  --worker producer/lldb-browser/overlays/lldb/tools/lldb-web-dap/lldb-web-dap.pthread.mjs \
  --target-dir "$WORK/lldb-package" --version llvmorg-22.1.8-lldb-web-8-module-api-experiment \
  --experimental-provenance "$WORK/post-link-experiment.json"
node producer/lldb-browser/experiments/module-api/assemble.mjs \
  --baseline "$BASELINE" \
  --baseline-manifest-sha256 d4b08c91cd9bc810d0862ea2a5ef5a092e52f6b22a6f3121499ec5d3df2086b5 \
  --lldb "$WORK/lldb-package" --wamr "$WORK/wamr-package" --output "$WORK/fixture"
```

In wasm-idle, prepare pinned Clang assets and run
`probe-lldb-first-pause.mjs --debug-assets "$WORK/fixture"
--debug-manifest-sha256 <assembler-output-sha256> --cache-mode both --json <report>`.
Run its baseline mode separately. For full UI fixtures prepare `clang container`
assets, verify the Container SDK URL and pinned manifest, and use the production
preview with COOP/COEP and strict CSP. A missing asset or worker setup failure is
not a passed debugger callback.

These historical post-link outputs remain excluded from normal release assembly.
The source-built artifacts and their exact consumer qualification are recorded
in the current evidence linked above. Release publication and consumer pin
selection are separate from this experiment.
