# GCC WASI review and merge qualification, 2026-11-03

This record supplements the original [DWARF qualification](gcc-wasi-dwarf-20261103.md). The earlier receipts remain historical evidence for their original source identities; they were not rewritten to describe the review changes.

## Review fixes

Locked source discovery now uses a fresh HEAD index. An unapproved source file cannot disappear from the fingerprint merely because it is staged, including ignored additions. The regression covers apply/verify, staged/untracked, and ignored/ordinary inputs while preserving the real index and the clean source fingerprint. This fix reached main through PR95.

The O0 DWARF backend now restores an unused scalar parameter's actual ABI location only when its declared/passed/incoming modes match and its real parameter local is never written or clobbered. Addressable/reference parameters and unsupported carriers remain excluded. Existing mapped locations and TI/TF pieces retain their original paths. Actual C/C++ cases recover ten missing locations, including an unused C++ `this`; dead reassignment and call controls do not expose stale incoming values. The shared multi-TU corpus now measures the unused argument `91` at real ABI local index 2 on both languages.

Official libgcov verification now takes the compile source argument from the trusted expected recipe path, consistently with its exact include and flag checks. Its canonical source receipt is independently checked by content and reopened. This fixes packaging with a symlinked GCC source directory. Both objects retain negative checks for substituted source arguments, changed source contents, and reordered includes.

## Source and integration identities

- Upstream GCC17 commit: `ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27`, with 21 locked patches.
- Reviewed compiler implementation: `08b4c5392617322d6d94287a5ea75d7723bb90ce`.
- Source lock SHA256: `96a89a63f449a98d3168fd0ce9d8fcb1689cfa5525a1c327eae3063286209faf`.
- Combined GCC source diff: `088dce09f2c5f0d3b51012eb7f4b4a29405579cf69f43e5ff25e22a0f5f86564`.
- Updated patch 0021 SHA256: `220939ba557c4d48e7aff76beaf509c860d5624b6200606c5218426127ecf279`.
- Package path verifier fix: `1dd94fb885ea2f5e6acebe8498d581a786fb3968`.
- SDK main: `19da2f6f6d7e65be9475eb4f926af8ae0c3a240d`, tree `e6415ce5bed6672ab5e264bd18c537943e023a78`.

PR102/103 were reviewed and merged into PR100, then included in the producer branch. Their changes add tests and documentation for existing scalar fallbacks. Their historical full browser receipts remain bound to their original bundle; separate current native smoke checks cover 26 runtime-permutation and 16 lane-shift fixtures with independent Clang references. The final producer tree retains all prerequisite heads and their later proof documents.

The SDK main integration preserves the shared core changes. Its fresh CI package installation measured 2,730,470 bytes / 188 files / 4 packages for GCC and 42,670,036 bytes / 3,402 files / 66 packages for the aggregate. Both fit the reviewed budgets. All five SDK PRs reached main and its CI and LLDB checks passed.

## Completed validation

| Check | Result |
|---|---|
| Focused actual compiler regression | 8/8 cases; 10 missing locations restored; reassignment/call/wide controls preserved |
| Native DWARF matrix | 11 programs / 15 source units; 11 normal and 10 trapped executions on each host; 18 live frames |
| DWARF admission gate | 16 passed, 0 skipped; 23 programs / 47 source units / 1,642 reopened files |
| Coverage matrix | 28 cases, 32 native executions, 20 profile executions, 120 diagnostics |
| Native inherited corpus | 25 suites passed; 24 fresh runs and one identical-current-compiler core reuse; 27,231 artifact identities verified |
| Proper Wasm-host GCC/WABT build | Both recipes passed; 10,433 frozen inputs and full locked source profiles rechecked |
| Current producer unit tests | 189 passed, 4 intentional optional evidence skips |
| Full package | Passed; 30,037 frozen inputs / 107 files / 355,782,860 bytes |
| Full public SDK debug matrix | 22 programs / 4 combinations; 80 named values; four unused arguments read as 91; 20 traps per host |
| Standard Worker matrix | 21 suites passed; 1,734 Chromium and 1,734 Node executions; 1,504 objects and WAT files; 382 ABI signature checks; 979 opcode checks |
| Worker controls | 592 diagnostics; 480 weakref and 88 RTTI mixed-object executions per host; 62 assembler and 6 SDK target-feature cases |

The original manifest is 26,139 bytes, SHA256 `c2e13a7d697fc2a56a8a19284a8c20d809cbd562a7842b87e4ee95154aa8d768`, and remains `unverified`. The private SDK candidate differs only in its qualification status; its payloads remained identical. The standard Worker run rechecked the original manifest and all frozen inputs, then reopened and verified its generated artifacts. Publication and deployment are outside this review.

## Local evidence preservation

Completed historical raw qualification outputs were retained in fully verified private archives, with top-level JSON reports kept and explicit restoration instructions. Current native program paths remain accessible: byte-identical regular artifacts share hardlinks, and matching report JSON copies use retained immutable package payloads. All logical report hashes and the complete package inventory were rechecked after the storage changes.

Only compiler build intermediates ending in `.o` were separately archived after both proper builds exited. Final tools, source, libraries, headers, receipts, and target-program objects were preserved. Restore the recorded intermediate objects before a future `make` or relink in these local build directories.

The [machine-readable review record](gcc-wasi-review-20261103.json) binds the runtime results and completed job log paths. Failed preparation attempts remain distinct from successful reruns; no failed receipt is presented as a passed qualification.
