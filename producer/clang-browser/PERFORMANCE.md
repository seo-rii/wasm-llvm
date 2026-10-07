# Compiler performance evaluation, 2026-10-07

The implementation retains the shipped execution compiler and embedded-header clangd artifacts. Selective O2 and Binaryen O3 candidates did not show a consistent end-to-end Chromium benefit sufficient to justify their extra bytes. clangd now prepares verified Wasm with streaming compilation and compiled-Module reuse; complete separate-header builds are supported through `CLANGD_SEPARATE_HEADERS=ON`, but their artifact promotion is deferred because they increased startup time and transfer bytes in this experiment. The producer defaults remain Oz, no selective O2, and `CLANGD_SEPARATE_HEADERS=OFF`.

The tracked JSON reports are included with these changes. Links to consumer evidence identify the corresponding wasm-idle commit. Absolute paths below identify private local logs and build artifacts retained from this experiment; those files are not included in the repositories.

## Inputs and method

The execution compiler is LLVM 22.1.8 at `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1`, WASI SDK 33, with Emscripten SDK 6.0.0 supplying the pinned Binaryen executable. Selective optimization applies to Clang/LLD themselves. User-program optimization remains the workload's `-O2` or `-O0 -g`; clangd does not use the WASI selective-optimization launcher.

The narrow build receipt identifies `MinSizeRel`, `LLVM_MINSIZE_OPT=Oz`, `LLVM_HOT_PATH_OPT=O2`, and exactly `clang/lib/Lex,clang/lib/Basic,llvm/lib/Support`. Its modules were built with `clangWasmOpt=none` before the separate pinned post-processing passes.

The tool was `wasm-opt version 130 (version_130-4-gb9c72894f)` at `/home/seorii/.cache/wasm-llvm-speed-20261005/hot-o2/work/emsdk/upstream/bin/wasm-opt`, executable SHA-256 `edaca574b1d17eee1a03c902d0b827bd3fb30e131c249b0c7f5612b16bf55275`. Each candidate receipt records the exact argv and input/output hashes.

`benchmark-compiler.mjs` used Node 24.1.0, V8 13.6.233.10-node.16, Linux x64. It compiled each compiler module once, then created a fresh WASI instance for every invocation. Five passes interleaved all variants in a fixed order. Warm numbers are the median of the four invocations after the first; complete unrounded samples, first invocation, module compilation, instantiation/preparation and combined timings remain in the data files. No network transfer or persistent-cache reload is included in these Node timings. The reports do not include a machine-load trace or statistical confidence interval.

All measured compiler/link invocations exited successfully. The verification then linked and ran each C, standard-library C++ and template-heavy source and checked the exact expected stdout. The sources, expected outputs and source hashes are preserved in the reports and exported from the benchmark script. The standard-library output verification uses the last emitted object, from the debug workload.

Node used `artifacts/clang-browser/sysroot.tar.zip`, archive SHA-256 `79c77fe54d89eeb9b3f405f601bbffac21c4e57d698d2aea9c96a898442d77ec`; its refreshed tar is 19,466,240 bytes, SHA-256 `25b7c305628bc480fa5243de493343edcadb1c57dd66552ea0820340a9dd5492`. Browser fixtures preserve the existing consumer's base sysroot tar, 19,312,640 bytes, SHA-256 `e122f1acec0642d62d8976101c542aaa5346460df6eae5a3f8efb594ff32f5ae`, plus the manifest-selected long-double supplement. Inputs are shared across variants within each experiment; Node and browser measurements remain separate experiments.

## Candidate identities and measured sizes

`baseline` is the shipped Clang/LLD. `baseline-o3` applies an additional pinned O3 pass to the recovered baseline input files. `raw-oz` applies an additional pinned Oz pass to those same files. `narrow-oz` and `narrow-o3` apply the corresponding pinned pass to the same narrow selective-O2 build outputs.

All sizes below are bytes. Gzip uses level 9 and matches the byte-identifiable browser fixture modules; gzip is distinct from the producer's zip packaging.

| Candidate   |  Clang raw | Clang gzip |    LLD raw |  LLD gzip |
| ----------- | ---------: | ---------: | ---------: | --------: |
| baseline    | 35,658,969 | 13,121,917 | 16,171,013 | 6,417,339 |
| raw-oz      | 35,543,064 | 13,121,364 | 16,128,402 | 6,415,190 |
| baseline-o3 | 35,926,269 | 13,184,307 | 16,373,430 | 6,454,222 |
| narrow-oz   | 36,957,355 | 13,564,600 | 16,584,706 | 6,559,015 |
| narrow-o3   | 37,342,356 | 13,629,600 | 16,846,197 | 6,600,395 |

Relative to shipped, combined Clang/LLD gzip grows by 99,273 bytes (0.51%) for baseline-O3, 584,359 bytes (2.99%) for narrow-Oz, and 690,739 bytes (3.54%) for narrow-O3. Each candidate is within the benchmark's 10% limit for both raw and gzip bytes of each module. Passing that size gate alone does not establish a browser benefit.

| Candidate   | Module | Raw module SHA-256                                                 |
| ----------- | ------ | ------------------------------------------------------------------ |
| baseline    | clang  | `d92ef06cdd3fea88acf384db15a6f2a344790c05bcba8e9f13f5b75b36ad4a99` |
| baseline    | lld    | `34d39bc410c098e7e09933b61cc8e28699447af9a28abf4544d71b6e9cad1f9d` |
| raw-oz      | clang  | `5d67fd170ac3ffa19d5c4ee1670fb2ec22e252b2d6deff51bf032f295a332a37` |
| raw-oz      | lld    | `5c66b708a31010aebe81025dc446f47e252b0c59fd47f108271fa96bf75bf55f` |
| baseline-o3 | clang  | `b74b60a03126cdd7f5130e98481967bf04368dc480782618a70d497f631e0ace` |
| baseline-o3 | lld    | `488b9cf2b816f3051752c48c3e33a1e97d951e3d99adfa4b30496130f474733f` |
| narrow-oz   | clang  | `03212f72546252816f4fa0fe3df17cd9c320b87dff889ab11cdeace875bddb6c` |
| narrow-oz   | lld    | `a96aa4df2a63195d44b80f74c086fc13a40c0ed9c769932af11dfa600ca83f75` |
| narrow-o3   | clang  | `997a3afaad710d7e3ff9529c45ccdae53e332481c929eb4a9c2f336b96625f3e` |
| narrow-o3   | lld    | `8c5eeb304f4a245eea2dec1b37408cdb11c193c68cddf503034f41d79ab3c1b9` |

The compact data files also preserve compressed SHA-256 receipts for every candidate and the shared memfs, base sysroot and supplemental archive assets.

## Node four-way comparison

Warm compiler invocation medians in milliseconds, excluding WASI preparation:

| Candidate   | C O2 | bits/stdc++ O2 | templates O2 | bits/stdc++ O0 debug | link bits/stdc++ |
| ----------- | ---: | -------------: | -----------: | -------------------: | ---------------: |
| baseline    |   47 |           3096 |        10723 |                 3186 |              155 |
| baseline-o3 |   46 |           3326 |         9379 |                 3052 |              148 |
| narrow-oz   |   45 |           2931 |         9452 |                 3082 |              142 |
| narrow-o3   |   40 |           2846 |         9058 |                 3026 |              146 |

These are measurements from one interleaved five-pass run. Effects vary by workload: for example, baseline-O3 was slower on the bits workload in this run but faster on templates. The combined candidate was measured directly; selective-O2 and Binaryen improvement percentages are not added together.

## Matched-input Binaryen comparison

The recovered baseline files under `wasi-raw/bin` have exactly the shipped raw module hashes. Their path names do not establish that they are untouched linker outputs. Applying pinned Oz to them changed both hashes and did not reproduce shipped bytes or the previous cached pinned-Oz outputs. Consequently, shipped versus baseline-O3 measures an additional pass over shipped-identical inputs, while raw-Oz versus baseline-O3 isolates Oz versus O3 over the same recovered inputs. It does not prove the effect of replacing the first production post-processing pass on a newly linked baseline.

Warm compiler invocation medians in a separate interleaved five-pass run:

| Candidate   | C O2 | bits/stdc++ O2 | templates O2 | bits/stdc++ O0 debug | link bits/stdc++ |
| ----------- | ---: | -------------: | -----------: | -------------------: | ---------------: |
| raw-oz      |   64 |           3658 |        10794 |                 3523 |              150 |
| baseline-o3 |   43 |           3004 |        10479 |                 3202 |              169 |

In this matched run, O3 reduced the bits invocation by 17.9% and templates by 2.9%; the linker was slower. Clang raw/gzip grew 1.08%/0.48% and LLD raw/gzip grew 1.52%/0.61% over raw-Oz. Baseline-O3 timings differ between runs, so comparisons use medians from the same run. These are Node results, not browser acceptance.

## Reproduction and recorded evidence

The data files preserve all original measurement samples, source identities, original-report SHA-256, source receipt filenames/hashes, and post-processing commands. Receipt summaries omit unrelated memfs/clangd and previous component-refresh details; original full receipts are identified by exact file hashes.

- [Four-way Node data](performance/node-four-way-20261007.json)
- [Matched-input Binaryen Node data](performance/node-matched-binaryen-20261007.json)

The source receipt files at measurement time were:

| Candidate   | Receipt filename                                                                    | Receipt SHA-256                                                    |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| baseline    | `/home/seorii/dev/hancomac/wasm-llvm/artifacts/clang-browser/toolchain.json`        | `4e32a952f83e6eb118892caecbf2035b678df3dbc42b549553d8ddb1b1f2b3e9` |
| raw-oz      | `/home/seorii/.cache/wasm-llvm-perf-20261006/raw-oz/benchmark-provenance.json`      | `cf11fea19e58fafcfbc49f0a6261f08f1784e223d8de1d2c59a72d0ab24d3250` |
| baseline-o3 | `/home/seorii/.cache/wasm-llvm-perf-20261006/baseline-o3/benchmark-provenance.json` | `79b32f4383ba4c6cc3914b613603b6ca758c79227c5c598b746b3f17d77bddf0` |
| narrow-oz   | `/home/seorii/.cache/wasm-llvm-perf-20261006/narrow-oz/benchmark-provenance.json`   | `22ed58a0cd7c06289fc4cbc6b8a39495d4263bd1c45c408f214ad36a31465d0b` |
| narrow-o3   | `/home/seorii/.cache/wasm-llvm-perf-20261006/narrow-o3/benchmark-provenance.json`   | `20dc7f05c9e9b1dc28a97f8aa1ed91a96bde5adc6400053964ff6eb9e503bb70` |

Run the comparisons from the wasm-llvm checkout after preparing the recorded candidate directories:

```sh
node producer/clang-browser/scripts/benchmark-compiler.mjs \
  --sysroot artifacts/clang-browser/sysroot.tar.zip \
  --baseline artifacts/clang-browser \
  --candidate baseline-o3=/path/to/baseline-o3 \
  --candidate narrow-oz=/path/to/narrow-oz \
  --candidate narrow-o3=/path/to/narrow-o3 \
  --runs 5 --max-growth 10 --enforce --json /path/to/node-comparison.json

node producer/clang-browser/scripts/benchmark-compiler.mjs \
  --sysroot artifacts/clang-browser/sysroot.tar.zip \
  --baseline /path/to/raw-oz \
  --candidate raw-o3=/path/to/baseline-o3 \
  --runs 5 --max-growth 10 --enforce --json /path/to/node-matched-binaryen-comparison.json
```

Each post-processing receipt contains commands of this form; preserve the input hashes and use the pinned executable identified above:

```sh
/path/to/pinned/wasm-opt -Oz /path/to/recovered-baseline/llvm -o /path/to/raw-oz/clang
/path/to/pinned/wasm-opt -O3 /path/to/recovered-baseline/llvm -o /path/to/baseline-o3/clang
/path/to/pinned/wasm-opt -Oz /path/to/narrow-raw/clang -o /path/to/narrow-oz/clang
/path/to/pinned/wasm-opt -O3 /path/to/narrow-raw/clang -o /path/to/narrow-o3/clang
```

Repeat for the corresponding LLD input. To build new narrow inputs, use `LLVM_MINSIZE_OPT=Oz LLVM_HOT_PATH_OPT=O2 LLVM_HOT_PATH_DIRS=clang/lib/Lex,clang/lib/Basic,llvm/lib/Support` and `build-toolchain.mjs --compiler-only`. The current producer retains raw inputs at `<work>/build/wasi-raw/bin/llvm` and `lld`, and writes its pinned-pass outputs separately under `<work>/build/wasm-opt`. Compare those raw inputs, rather than applying another pass to already post-processed exported modules. The historical narrow input receipt records `clangWasmOpt=none`; the current producer accepts `default`, `O2` or `O3`. Confirm the build receipt and actual raw module hashes before using a replacement input.

Prepare browser fixtures using `prepare-browser-benchmark.mjs`. An example configuration follows; the shared `compilerAssets` directory's parent must contain the manifest-selected supplemental archive. The shipped compressed compiler directory can be a captured pre-promotion snapshot.

```json
{
  "runtimeManifest": "../wasm-idle/static/clang/runtime-manifest.v1.json",
  "compilerAssets": "../wasm-idle/static/clang/bin",
  "compiler": {
    "baseline": { "compressedDirectory": "/path/to/shipped/clang/bin" },
    "raw-oz": { "rawDirectory": "/path/to/raw-oz" },
    "baseline-o3": { "rawDirectory": "/path/to/baseline-o3" },
    "narrow-oz": { "rawDirectory": "/path/to/narrow-oz" },
    "narrow-o3": { "rawDirectory": "/path/to/narrow-o3" }
  },
  "clangd": {
    "shipped": {
      "directory": "/path/to/shipped/clangd",
      "implementation": "shipped"
    },
    "streaming-embedded": {
      "directory": "/path/to/shipped/clangd",
      "implementation": "current"
    },
    "separated": {
      "directory": "/path/to/separated-clangd",
      "implementation": "current",
      "rawWasm": "clangd.wasm",
      "headers": "clangd.headers.json.gz"
    }
  }
}
```

```sh
node producer/clang-browser/scripts/prepare-browser-benchmark.mjs \
  --config /path/to/browser-fixtures-config.json --out-dir /path/to/browser-fixtures
```

The measured fixture configuration is `/home/seorii/.cache/wasm-llvm-perf-20261006/browser-fixtures-config.json`; its fixtures are under `browser-fixtures-matched/fixtures.json` in the same cache directory. Shared supplemental gzip is 52,723 bytes, SHA-256 `b3f11e17e40fb13371a97244fdde00d5bd951ad8e20dfdf88a069167d6be628b`, and its raw archive is 111,062 bytes, SHA-256 `33e04007d3547095068391b42189d1ac5398dd04e9da3118dfa644ffea7f4148`.

Long-running commands used detached processes with private logs. Completed runs:

| Operation                           | Private log                                                              | Exit-status file                                            | Exit |
| ----------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ---: |
| Six pinned candidate passes         | `/home/seorii/logs/wasm-perf-binaryen-20261006.log`                      | `/home/seorii/.cache/wasm-llvm-perf-20261006/optimize.exit` |    0 |
| Four-way Node benchmark             | `/home/seorii/logs/wasm-clang-node-20261007-jh_5dr4o.log`                | same log path plus `.status`                                |    0 |
| Matched Oz pass and Node benchmark  | `/home/seorii/logs/wasm-clang-matched-binaryen-20261007-m6qovyzq.log`    | same log path plus `.status`                                |    0 |
| Complete browser-fixture generation | `/home/seorii/logs/wasm-browser-fixtures-complete-20261007-gip11vvy.log` | same log path plus `.status`                                |    0 |

## clangd header candidate and build policy

The header-separation candidate was relinked from the baseline's cached clangd LTO objects, keeping its Emscripten pthread configuration, 2 GiB initial memory and 4 GiB maximum memory. The actual working directory and complete command are recorded in `/home/seorii/.cache/wasm-llvm-perf-20261006/relink.json` (7,008 bytes, SHA-256 `6f47c2201b8d38a434df796d9db959229759d4b431a944371711c3745db577af`). This is a relink of those objects, rather than a clean rebuild of all LLVM sources.

The separate tree contains all 5,533 selected-target C/C++ and matching Clang resource-header files, with version `llvmorg-22.1.8:ca7933e47d3a3451d81e72ac174dcb5aa28b59d1`, target `wasm32-wasi` and resource directory `/lib/clang/22`. It retains the expected `/usr/include` and resource paths. The execution compiler's pruned sysroot was not used as the clangd header asset.

| Asset                                | Embedded bytes | Separated bytes |
| ------------------------------------ | -------------: | --------------: |
| JavaScript                           |         97,002 |          95,953 |
| Wasm raw                             |     78,993,623 |      40,573,921 |
| Wasm gzip                            |     16,723,115 |      11,610,367 |
| Header JSON raw                      |       embedded |      47,317,802 |
| Header JSON gzip                     |       embedded |       5,732,672 |
| JavaScript + transferred gzip assets |     16,820,117 |      17,438,992 |

The raw Wasm shrank 48.6%, while the transferred asset total grew 618,875 bytes (3.68%). The header JSON's raw size includes its serialized representation. Separating headers does not imply a reduction in total download bytes or initialization latency.

| Asset identity       | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Embedded JavaScript  | `92dce989f2623a6e8930369dd205301c2815d70cf81312c64de1c47a16302b27` |
| Embedded Wasm gzip   | `284e7117da923ca99ea9d64e4d9a80a739cdce4cc1c81dd099b040ab0a8a926f` |
| Embedded Wasm raw    | `f2bef5c4b4aa8691f0b996286231c5778a17119c41537ae4108c7ff2795f7fc3` |
| Separated JavaScript | `1d24e63428f4cc345b8a1bff09ff078c7779af1e7ba2ca1d307658de19145f99` |
| Separated Wasm gzip  | `e44247a0a616f679323ada88542074d28a5c7baaccc2b1f84561339450dcd013` |
| Separated Wasm raw   | `5c55f0b410126432c7ff2ebfbb2be86e0556ba36d885f030994c2deb53e164fc` |
| Header JSON gzip     | `70fae69d9d1f59269fcba00da077ed1e3cce3372d2a1ca5bbff520b173f23340` |
| Header JSON raw      | `5f130b405bc9e2743d3d6f56e5b93f872ac336ad84fd6b62f16ae2e9a875031f` |

The tracked shipped compiler and embedded-header clangd artifact bytes remain unchanged. `CLANGD_SEPARATE_HEADERS=ON` produces the complete separate asset and contract; the default is `OFF`, retaining the embedded bundle. Both contracts are supported. The default retains the measured faster embedded bundle; header separation is an implemented and validated optional path, rather than a promoted default artifact change. The final Chromium section below records the acceptance decision. Execution-compiler optimization defaults are also unchanged; the narrow O2 directory selection is available for isolated builds.

`refresh-clangd-assets.mjs` stages a candidate in an explicit directory outside its inputs. It checks source receipts, new assets, complete headers and the stdin bridge; retains all compiler, sysroot, MemFS and historical receipt bytes; and appends the actual clangd derivation inputs and outputs to the staged receipt. A reproducible local staging command is:

```sh
node producer/clang-browser/scripts/refresh-clangd-assets.mjs \
  --source-artifacts /path/to/shipped-artifacts \
  --clangd-dir /path/to/separated-clangd \
  --build-receipt /path/to/relink.json \
  --out-dir /path/to/isolated-staged-artifacts
```

The completed relink used `/home/seorii/logs/wasm-perf-clangd-relink-20261006.log`, with final exit `0` recorded in `/home/seorii/.cache/wasm-llvm-perf-20261006/relink.exit`.

## Persistent PCH Chromium reference validation

The [PCH reference report](https://github.com/seo-rii/wasm-idle/blob/08d32432027f60c0ceed09de063a76f4574a6c41/scripts/performance-results/pch-chromium.json) is a separate validation run at `2026-10-07T00:01:39.937Z`, using Chromium `147.0.7727.15` and the shipped static compiler artifacts. Its receipt is 51,306 bytes, SHA-256 `6ac8106eef1784f9ea7e145c906557c54c4461922263cd332b00969ea51bd843`. The C++20 workload includes `<bits/stdc++.h>`, performs vector accumulation, checks stdout, and changes source in every phase. Each row is one observed sample, rather than a statistical median. Exact timings, cache identities, stage ranges and response bytes remain in that report.

The generated PCH record was 19,813,536 bytes. Both the default playground and runtime-session path retrieved it on persistent reload and used it during the first eligible compilation. Empty-cache and explicitly disabled cases compiled textually. Focused tests separately cover identity changes, stale/corrupt entries, unavailable storage, write/quota failures, eligibility, Clang rejection and textual fallback.

All timing columns below are milliseconds from the probe's phase start, rounded to one decimal. `ready` is runtime readiness, `compiled` is compile/link completion and `first output` is the first program stdout event. The session path can report runtime readiness before creating its compilation worker, so its readiness column is not equivalent to the default path's preparation boundary.

| Path    | Network     | Phase             |   Ready | Compiled | First output | PCH used | Asset transfer bytes |
| ------- | ----------- | ----------------- | ------: | -------: | -----------: | -------- | -------------------: |
| default | local       | empty-cache       |   983.3 |   7290.3 |       7299.1 | no       |           24,668,714 |
| default | local       | persistent-reload |   865.8 |   3633.9 |       3638.6 | yes      |           24,667,445 |
| default | local       | warm              |     0.0 |    808.7 |        812.3 | yes      |                    0 |
| default | local       | disabled          |   792.4 |   7539.5 |       7545.2 | no       |           24,668,714 |
| default | constrained | empty-cache       | 20294.3 |  33292.6 |      33298.7 | no       |           24,668,714 |
| default | constrained | persistent-reload | 20177.9 |  29132.5 |      29137.4 | yes      |           24,667,445 |
| default | constrained | warm              |     0.0 |    781.7 |        787.2 | yes      |                    0 |
| default | constrained | disabled          | 20196.4 |  32084.4 |      32110.7 | no       |           24,668,714 |
| session | local       | empty-cache       |   198.1 |   7356.7 |       7914.6 | no       |           24,668,714 |
| session | local       | persistent-reload |   180.6 |   4114.0 |       4420.2 | yes      |           24,667,445 |
| session | local       | warm              |     0.0 |   1372.5 |       1625.4 | yes      |                    0 |
| session | local       | disabled          |   195.6 |   6752.9 |       7032.0 | no       |           24,668,714 |
| session | constrained | empty-cache       |  2885.4 |  32490.3 |      37308.6 | no       |           24,668,714 |
| session | constrained | persistent-reload |  2877.1 |  31090.6 |      35990.2 | yes      |           24,667,445 |
| session | constrained | warm              |     0.1 |   6381.1 |      11215.0 | yes      |                    0 |
| session | constrained | disabled          |  2988.8 |  36945.5 |      41781.5 | no       |           24,668,714 |

The constrained profile uses 50 ms CDP latency and 1,250,000 download bytes/s. CDP also throttles development-module traffic and preparation of fresh runtime-session workers. The byte metric counts `/clang/` responses using CDP `encodedDataLength`, including response headers, and excludes that development traffic. Consequently, the constrained session's warm time cannot be attributed entirely to PCH compilation.

This local Vite probe serves `.gz` files with `Content-Encoding: gzip`, so `fetch` exposes already decompressed bodies. Existing persistent-asset representation gates skip storing those bodies under compressed receipts. With the HTTP cache disabled and host memory replaced on reload, runtime assets download again; the independently verified generated-PCH record still survives. These reload observations establish PCH reuse, without establishing zero-byte persistent runtime-asset reload. The main browser matrix uses byte-preserving fixture responses and reports its own transfer metric separately.

The completed PCH probe log is `/home/seorii/logs/wasm-idle-pch-chromium-20261007-k6y6sg08.log`; final exit `0` is recorded in `/home/seorii/logs/wasm-idle-pch-chromium-20261007-k6y6sg08.status`.

## Focused validation and log index

These are independently completed validation groups. Later groups repeat some earlier tests after further changes; their counts must not be added into a unique-test total. The complete matrix and final post-matrix checks are recorded in the final Chromium section.

| Validation                                          | Result                                                                                                                                                | Private log                                                                           | Exit-status file                                | Exit |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- | ---: |
| Persistent storage/PCH host and LLVM runtime checks | 87 host/storage tests and 182 LLVM/Clang tests passed; package build/type checks passed                                                               | `/home/seorii/logs/wasm-idle-pch-checks-20261006-clfh3wc0.log`                        | same filename with `.log` replaced by `.status` |    0 |
| Shared asset operations                             | 127 focused tests passed, including cancellation, retry, integrity and buffer ownership; browser MessageChannel download/compile-sharing probe passed | `/home/seorii/logs/wasm-shared-assets-chromium-20261007-1vyxqftj.log` (browser probe) | same log path plus `.status`                    |    0 |
| Monaco completion and resolve cancellation          | 8 unit tests and 1 real Chromium test passed                                                                                                          | `/home/seorii/logs/wasm-idle-completion-chromium-20261006-235620.log`                 | same filename with `.log` replaced by `.status` |    0 |
| Initial consumer contract checks                    | 46 tests passed                                                                                                                                       | `/home/seorii/logs/wasm-idle-clangd-contracts-20261007-000445.log`                    | same filename with `.log` replaced by `.status` |    0 |
| Producer header/legacy bundle contracts             | 25 tests passed; 1 SDK-gated test skipped                                                                                                             | `/home/seorii/logs/wasm-llvm-clangd-contracts-20261007-000445.log`                    | same filename with `.log` replaced by `.status` |    0 |
| clangd startup and verified-Wasm regressions        | 125 LSP tests and 29 LLVM tests passed; both type checks passed                                                                                       | `/home/seorii/logs/wasm-idle-clangd-focused-20261007-eror90u7.log`                    | same log path plus `.status`                    |    0 |
| Complete header validation at worker boundary       | 53 tests passed; LSP type check passed                                                                                                                | `/home/seorii/logs/wasm-idle-clangd-header-validator-20261007-7sgi4bt7.log`           | same log path plus `.status`                    |    0 |
| Local asset bootstrap and receipt policy            | 249 tests passed; script syntax and focused formatting checks passed                                                                                  | `/home/seorii/logs/wasm-idle-clangd-bootstrap-final-20261007-t9300li_.log`            | same log path plus `.status`                    |    0 |

Short producer checks additionally passed: 3 browser-fixture tests; 5 clangd-only refresh tests plus 6 shared header-contract tests; and 5 selected build-mode/manifest guard tests. The summary tool was manually checked against a complete synthetic 144-cell matrix and an actual partial report, including exact raw samples, medians, missing/duplicate guards and completion request counts. A displaced-slow-request case verified that a 90.125 ms first-request median still reports a 6,270.875 ms median three-request sum and a 6,100.25 ms median per-repeat maximum. These short checks ran directly and have no detached build log.

The summary command rejects an incomplete matrix by default. Explicit partial summaries require `--partial true`; the final report must be generated without that flag:

```sh
node producer/clang-browser/scripts/summarize-browser-performance.mjs \
  --input /path/to/completed-browser-report.json \
  --output /path/to/compact-browser-summary.json
```

## Reviewable changed-file index

This index covers task changes only. Existing unrelated version, README, generated-lock and risk-register changes in the shared workspace are excluded. Paths below are relative to their named repository; brace lists enumerate files in the stated directory.

- Persistent PCH, **wasm-idle**: `packages/core/src/{index.ts,persistent-asset-cache.ts}`; `packages/llvm-core/runtime/clang/src/{precompiled-header.ts,runtime.ts,types.ts}` and `test/precompiled-header.test.ts`; `packages/llvm-core/runtime/core/src/wasm.ts` and `test/wasm.test.ts`; `src/lib/persistent-asset-cache.test.ts`; `src/lib/playground/{clang.ts,clang.test.ts,cachedClang.ts,cachedClang.test.ts,clangWorkerProtocol.ts}` and `worker/{clang.ts,cachedClangCompile.ts,clangStreaming.ts}`; `scripts/probe-persistent-pch-browser.mjs` and `scripts/performance-results/pch-chromium.json`.
- Shared operations, **wasm-idle**: `src/lib/playground/{runtimeAssetCache.ts,runtimeAssetCache.test.ts,assetBridge.ts,runtimeAssetBridge.test.ts,assetBridge.persistent-policy.test.ts}`.
- Monaco cancellation, **wasm-idle**: `patches/monaco-editor@0.55.1.patch`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and `src/lib/{monaco-completion-cancellation.test.ts,monaco-completion-cancellation.playwright.test.ts}`. The repository-managed patch is the dependency deliverable.
- clangd preparation and contracts, **wasm-idle**: `packages/lsp/src/{assets.ts,runtime.ts,types.ts}`; `packages/lsp/src/clangd/{protocol.ts,server.ts,worker.ts,headers.ts,wasm.ts}`; `packages/lsp/test/{clangd-server.test.ts,clangd-worker-integrity.test.ts,clangd-headers.test.ts,clangd-wasm.test.ts}`; `packages/llvm-core/runtime/clang/src/{runtime-manifest.ts,types.ts}` and `test/runtime-manifest.test.ts`; `packages/llvm-core/runtime/core/src/verified-wasm.ts` and `test/verified-wasm.test.ts`; `scripts/{prepare-browser-test-assets.mjs,prepare-clangd-assets.mjs,sync-wasm-clang.mjs}`; `scripts/llvm-contracts/clangd-header-asset-contract.mjs`; `src/lib/{prepare-browser-test-assets.test.ts,prepare-clangd-assets.test.ts,sync-wasm-clang.test.ts}`; `src/lib/playground/{assets.ts,assets.test.ts,assetBridge.ts,assetBridge.test.ts}`.
- Producer header packaging, **wasm-llvm**: `producer/clang-browser/{README.md,manifest.json}`; `producer/clang-browser/scripts/{build-toolchain.mjs,prepare-clangd-headers.mjs,package-toolchain.mjs,prepare-release.mjs,verify-artifacts.mjs,clangd-header-asset-contract.mjs,refresh-clangd-assets.mjs}`; `test/{clang-build-options.test.mjs,clangd-headers.test.mjs,clangd-header-assets-contract.test.mjs,clangd-assets-refresh.test.mjs}`. Both legacy embedded bundles and optional separate-header bundles remain reviewable.
- Evaluation and receipts, **wasm-llvm**: `producer/clang-browser/{README.md,PERFORMANCE.md}`; `producer/clang-browser/scripts/{benchmark-compiler.mjs,prepare-browser-benchmark.mjs,summarize-browser-performance.mjs}`; `producer/clang-browser/performance/{node-four-way-20261007.json,node-matched-binaryen-20261007.json,browser-20261007.json}`; `test/clang-browser-benchmark-fixtures.test.mjs`.
- Chromium matrix harness, **wasm-idle**: `scripts/{benchmark-clang-browser.mjs,compiler-performance.worker.ts,performance-browser.html,performance-browser.ts,performance-vite.config.mjs}` and `scripts/performance-results/{clangd-restart-chromium.json,monaco-c-cpp-chromium.json}`. The complete matrix is recorded in `wasm-llvm/producer/clang-browser/performance/browser-20261007.json`; final compatibility changes also touch the existing clangd Wasm/server files and their tests.

## Chromium validation and promotion decision

The completed [Chromium matrix](performance/browser-20261007.json) contains 144 passing samples: five compiler variants and three clangd variants, two network profiles, three repeats, and separate empty-cache, persistent-reload and warm phases. The raw report is 409,459 bytes, SHA-256 `a8be5d4e23d43163270148906850b674a5e625ad8531ee36cd97b7c73693f5bd`. The compact tracked report preserves every unrounded sample, source identity, output, emitted size, stage sequence, diagnostic-message digest and RPC trace identity, together with median/minimum/maximum statistics.

Chromium was `147.0.7727.15`, headless on this Linux host with eight CPUs and browser `hardwareConcurrency=8`; the pages were cross-origin isolated. Each variant/repeat started a new browser and context. The HTTP cache was disabled, asset responses were `no-store`, and persistent-cache namespaces were unique to each variant/repeat. Persistent reload reused that context and namespace after document reload; warm operation reused the active compiler worker or clangd worker and its preambles. Variant order rotated across repeats. The shipped clangd implementation came from the current checkout's `HEAD` server/worker source; streaming-embedded used the changed consumer with identical shipped artifact bytes.

The constrained asset origin imposed a shared 1,250,000-byte/s budget (10 Mbit/s) with 50 ms request latency across all asset fetches, including worker fetches. Transfer counts are actual asset response payload bytes sent by that origin; HTTP headers, document and development-tooling traffic are excluded. Responses retain the `.gz` bytes without `Content-Encoding`, so persistence is tested against the exact compressed receipts. This differs from the PCH reference probe's CDP shaping and Vite response representation.

The compiler adapter retained the already implemented execution-Clang/LLD verified streaming pipeline and used the same persistent backend for MemFS, sysroot and the manifest-selected supplemental archive. All variants compiled the same C17, C++17 bits/stdc++ and C++20 template workloads at user-program `-O2`, linked, executed, and checked exact expected stdout. The compiler phase clock starts when the worker receives the request, excluding development-worker JavaScript bootstrap. Workloads run sequentially, so first C++ output includes the preceding C workload; total includes the final template workload. This comparison does not build a generated PCH; persistent PCH behavior is measured by the separate reference probe above.

clangd opened equivalent C++ bits/stdc++/filesystem and C stdio/wchar/math sources with deliberate errors, checked diagnostics without missing-header failures, and checked `std::vector` completion on three consecutive RPC requests. C diagnostics follow C++ diagnostics. Warm edits reuse those documents and increment their versions to preserve the existing preamble caches. Actual Emscripten pthread initialization and worker analysis completed in all three clangd variants. This is browser execution evidence, not an estimate of browser behavior from Node.

### Compiler preparation and first output

All timing cells below are medians of three repeats in milliseconds, rounded to the nearest millisecond. `Prepare` is runtime readiness before the first workload; LLD is prepared on demand during that first workload. `C++ output` is the bits/stdc++ program's first stdout event. Persistent-reload and warm asset transfer was zero in every group. The full report keeps the timing ranges; for example, unconstrained baseline cold total ranged from 15,143 to 22,315 ms, so small differences in this three-repeat experiment should not be read as established general speedups.

**Unconstrained**

| Candidate   | Phase             | Prepare | First C output | First C++ output |  Total | Asset payload bytes |
| ----------- | ----------------- | ------: | -------------: | ---------------: | -----: | ------------------: |
| baseline    | empty-cache       |     740 |          2,069 |            6,705 | 15,604 |          24,667,583 |
| baseline    | persistent-reload |     564 |          1,845 |            6,587 | 15,046 |                   0 |
| baseline    | warm              |       0 |            130 |            2,749 | 10,344 |                   0 |
| raw-oz      | empty-cache       |     680 |          1,979 |            6,704 | 15,406 |          24,664,881 |
| raw-oz      | persistent-reload |     557 |          1,780 |            6,741 | 15,600 |                   0 |
| raw-oz      | warm              |       0 |            132 |            2,862 | 10,340 |                   0 |
| baseline-o3 | empty-cache       |     680 |          2,000 |            6,548 | 15,162 |          24,766,856 |
| baseline-o3 | persistent-reload |     545 |          1,656 |            6,140 | 14,673 |                   0 |
| baseline-o3 | warm              |       0 |            129 |            2,799 | 10,330 |                   0 |
| narrow-oz   | empty-cache       |     689 |          2,052 |            7,267 | 17,336 |          25,251,942 |
| narrow-oz   | persistent-reload |     554 |          1,746 |            6,903 | 15,786 |                   0 |
| narrow-oz   | warm              |       0 |            135 |            2,842 | 10,597 |                   0 |
| narrow-o3   | empty-cache       |     731 |          2,176 |            6,962 | 15,635 |          25,358,322 |
| narrow-o3   | persistent-reload |     526 |          1,734 |            6,499 | 15,134 |                   0 |
| narrow-o3   | warm              |       0 |            130 |            2,793 | 10,535 |                   0 |

**Constrained**

| Candidate   | Phase             | Prepare | First C output | First C++ output |  Total | Asset payload bytes |
| ----------- | ----------------- | ------: | -------------: | ---------------: | -----: | ------------------: |
| baseline    | empty-cache       |  14,916 |         21,122 |           25,634 | 34,142 |          24,667,583 |
| baseline    | persistent-reload |     512 |          1,644 |            6,353 | 14,788 |                   0 |
| baseline    | warm              |       0 |            133 |            2,822 | 10,433 |                   0 |
| raw-oz      | empty-cache       |  14,911 |         21,127 |           25,511 | 34,109 |          24,664,881 |
| raw-oz      | persistent-reload |     533 |          1,630 |            6,210 | 14,800 |                   0 |
| raw-oz      | warm              |       0 |            122 |            2,900 | 10,363 |                   0 |
| baseline-o3 | empty-cache       |  14,964 |         21,248 |           25,657 | 33,960 |          24,766,856 |
| baseline-o3 | persistent-reload |     544 |          1,716 |            6,158 | 14,432 |                   0 |
| baseline-o3 | warm              |       0 |            126 |            2,753 |  9,949 |                   0 |
| narrow-oz   | empty-cache       |  15,286 |         21,672 |           26,106 | 34,438 |          25,251,942 |
| narrow-oz   | persistent-reload |     540 |          1,721 |            6,321 | 14,802 |                   0 |
| narrow-oz   | warm              |       0 |            127 |            2,796 | 10,008 |                   0 |
| narrow-o3   | empty-cache       |  15,345 |         21,808 |           26,015 | 34,427 |          25,358,322 |
| narrow-o3   | persistent-reload |     536 |          1,737 |            6,339 | 14,493 |                   0 |
| narrow-o3   | warm              |       0 |            126 |            2,700 |  9,976 |                   0 |

Warm compile/link medians isolate user-program compilation from earlier workloads and startup. They include the compiler's LLVM work and LLD work, and exclude program execution.

| Candidate   | Unconstrained bits | Unconstrained templates | Constrained bits | Constrained templates |
| ----------- | -----------------: | ----------------------: | ---------------: | --------------------: |
| baseline    |              2,609 |                   7,573 |            2,694 |                 7,631 |
| raw-oz      |              2,725 |                   7,471 |            2,762 |                 7,334 |
| baseline-o3 |              2,664 |                   7,480 |            2,619 |                 7,187 |
| narrow-oz   |              2,711 |                   7,746 |            2,661 |                 7,205 |
| narrow-o3   |              2,657 |                   7,734 |            2,568 |                 7,270 |

The additional O3 candidate lowered unconstrained cold total from 15,604 to 15,162 ms (2.8%) and reload from 15,046 to 14,673 ms (2.5%), while warm total was essentially unchanged, 10,344 versus 10,330 ms. Under the constrained profile its cold total was 34,142 versus 33,960 ms (0.5%); first C and first C++ output were slightly later. Some constrained warm medians improved by about 4.6%, but this was not consistent across profiles and phases. The recovered-input Oz/O3 controls and the interleaved Node results remain useful reference data; they do not establish a sufficient download-to-output improvement for promoting O3.

Narrow selective O2 increased compressed compiler assets by 2.99% with Oz, or 3.54% combined with O3. Unconstrained warm totals rose to 10,597 and 10,535 ms; constrained cold first output also regressed. The directly measured combined configuration did not establish the case for promotion. The shipped Oz artifacts remain the defaults; the narrower Lex/Basic/Support launcher configuration is available for future isolated measurements. No separate improvement percentages were added.

### clangd readiness and diagnostics

All cells are three-repeat medians in milliseconds. Diagnostics are measured from phase start; `ready=0` in warm rows means the existing worker is retained. Cold embedded variants transfer 16,820,117 payload bytes in two requests; cold separated variants transfer 17,438,992 bytes in three requests. Every reload and warm group transferred zero payload bytes.

**Unconstrained**

| Variant            | Phase             | Ready | First C++ diagnostics | First C diagnostics |
| ------------------ | ----------------- | ----: | --------------------: | ------------------: |
| shipped            | empty-cache       | 1,493 |                12,843 |              13,146 |
| shipped            | persistent-reload | 1,276 |                 8,298 |               8,439 |
| shipped            | warm              |     0 |                   356 |                 430 |
| streaming-embedded | empty-cache       | 1,316 |                12,181 |              12,532 |
| streaming-embedded | persistent-reload | 1,146 |                 7,917 |               8,081 |
| streaming-embedded | warm              |     0 |                   310 |                 388 |
| separated          | empty-cache       | 2,009 |                13,153 |              13,460 |
| separated          | persistent-reload | 1,796 |                 8,758 |               8,887 |
| separated          | warm              |     0 |                   368 |                 445 |

**Constrained**

| Variant            | Phase             |  Ready | First C++ diagnostics | First C diagnostics |
| ------------------ | ----------------- | -----: | --------------------: | ------------------: |
| shipped            | empty-cache       | 15,029 |                26,284 |              26,557 |
| shipped            | persistent-reload |  1,182 |                 7,906 |               8,014 |
| shipped            | warm              |      0 |                   305 |                 378 |
| streaming-embedded | empty-cache       | 14,415 |                24,834 |              25,110 |
| streaming-embedded | persistent-reload |  1,114 |                 7,706 |               7,839 |
| streaming-embedded | warm              |      0 |                   308 |                 380 |
| separated          | empty-cache       | 15,321 |                26,254 |              26,581 |
| separated          | persistent-reload |  1,742 |                 8,488 |               8,608 |
| separated          | warm              |      0 |                   352 |                 425 |

### Completion requests and preparation stages

Each row below contains three batches of three requests: the first-request median has three observations; the all-request median has nine. `Batch sum` and `Batch max` are medians of the per-repeat sum and maximum of the three measured request durations. Summed durations exclude document-open and inter-request overhead. These columns retain expensive work when it moves to a later request. A small first-request number or small median across all nine requests alone would hide that work.

**Unconstrained**

| Variant            | Phase             | First request (n=3) | All requests (n=9) | Batch sum (n=3) | Batch max (n=3) |
| ------------------ | ----------------- | ------------------: | -----------------: | --------------: | --------------: |
| shipped            | empty-cache       |               6,225 |                151 |           6,490 |           6,225 |
| shipped            | persistent-reload |               5,301 |                128 |           5,624 |           5,301 |
| shipped            | warm              |                 100 |                 91 |             269 |             101 |
| streaming-embedded | empty-cache       |               6,350 |                169 |           6,611 |           6,350 |
| streaming-embedded | persistent-reload |               5,171 |                130 |           5,690 |           5,171 |
| streaming-embedded | warm              |                  89 |                 86 |             261 |              89 |
| separated          | empty-cache       |                 234 |                215 |           6,643 |           6,244 |
| separated          | persistent-reload |                 107 |                107 |           5,438 |           5,324 |
| separated          | warm              |                 102 |                 90 |             281 |             102 |

**Constrained**

| Variant            | Phase             | First request (n=3) | All requests (n=9) | Batch sum (n=3) | Batch max (n=3) |
| ------------------ | ----------------- | ------------------: | -----------------: | --------------: | --------------: |
| shipped            | empty-cache       |                 332 |                332 |           6,789 |           6,324 |
| shipped            | persistent-reload |               5,232 |                123 |           5,465 |           5,232 |
| shipped            | warm              |                  89 |                 89 |             267 |              92 |
| streaming-embedded | empty-cache       |               6,079 |                164 |           6,898 |           6,613 |
| streaming-embedded | persistent-reload |               5,106 |                116 |           5,424 |           5,203 |
| streaming-embedded | warm              |                  88 |                 86 |             251 |              88 |
| separated          | empty-cache       |               5,695 |                238 |           6,737 |           6,358 |
| separated          | persistent-reload |                 101 |                105 |           5,600 |           5,494 |
| separated          | warm              |                 101 |                 95 |             293 |             101 |

For example, separated headers gave an unconstrained cold first-request median of 234 ms, but the median three-request sum was 6,643 ms and median per-batch maximum was 6,244 ms. The corresponding shipped sum was 6,490 ms. On the constrained cold shipped path the first-request median was also small (332 ms), with a 6,789 ms batch sum. Analysis work moved among requests; neither observation establishes a large completion speedup.

The following are median status-transition timestamps from phase start, rather than independent stage durations. Preparation stages overlap, and their names differ between the old complete-download/decompress worker and the new host-prepared Module path. `Module-loading` on the new path follows verified Wasm/header preparation; the final `Wasm initialization` boundary marks the worker initialization after the prepared inputs have arrived. Raw stage sequences for every sample remain in the tracked report. Compiler sequences additionally retain Clang and LLD prepare-start/finish; compiler warm sequences are explicitly identified as the preceding initialization retained by the worker, rather than current warm preparation.

| Variant            | Profile       | Phase             | Module loading | Wasm initialization |  Ready |
| ------------------ | ------------- | ----------------- | -------------: | ------------------: | -----: |
| shipped            | unconstrained | empty-cache       |            457 |                 803 |  1,492 |
| shipped            | unconstrained | persistent-reload |            238 |                 554 |  1,276 |
| streaming-embedded | unconstrained | empty-cache       |            877 |                 879 |  1,316 |
| streaming-embedded | unconstrained | persistent-reload |            726 |                 729 |  1,146 |
| separated          | unconstrained | empty-cache       |          1,204 |               1,207 |  2,008 |
| separated          | unconstrained | persistent-reload |            992 |                 995 |  1,795 |
| shipped            | constrained   | empty-cache       |         14,010 |              14,350 | 15,028 |
| shipped            | constrained   | persistent-reload |            259 |                 560 |  1,182 |
| streaming-embedded | constrained   | empty-cache       |         13,996 |              13,999 | 14,414 |
| streaming-embedded | constrained   | persistent-reload |            686 |                 688 |  1,113 |
| separated          | constrained   | empty-cache       |         14,511 |              14,513 | 15,320 |
| separated          | constrained   | persistent-reload |            979 |                 981 |  1,742 |

### Adopted changes and deferred artifact promotion

Verified streaming compilation and Module reuse are adopted for clangd while retaining shipped embedded-header artifacts. In this experiment streaming-embedded improved unconstrained readiness from 1,493 to 1,316 ms cold (11.8%) and from 1,276 to 1,146 ms on reload (10.2%). Constrained cold readiness improved from 15,029 to 14,415 ms (4.1%); first C++ diagnostics improved from 26,284 to 24,834 ms (5.5%). These are measured medians on this host, with unchanged artifact payload bytes. Completion batch results vary and support no large general completion-speed claim.

The separate-header producer/consumer contract is implemented and its complete header tree, paths, integrity gates, concurrent preparation and pthread handoff are tested. Artifact promotion remains deferred: compared with streaming-embedded, separated headers increased unconstrained cold readiness from 1,316 to 2,009 ms (52.7%) and reload from 1,146 to 1,796 ms (56.7%); first C++ diagnostics were later as well. Under the constrained profile, separated cold readiness was 15,321 ms and first C++ diagnostics 26,254 ms, versus 14,415 and 24,834 ms with streaming-embedded. The extra 618,875 transferred bytes and measured preparation/initialization overhead outweighed the smaller raw Wasm on these workloads. Header parsing and mounting are part of that changed preparation path; their individual costs were not isolated. The first completion request sometimes improved because expensive analysis moved to a later request; the complete batch does not justify promotion.

The deferred promotion is recorded locally as `PERF-005`; the workspace risk register is not included in these changes. This leaves item 5 partly deferred at the artifact-selection level: `CLANGD_SEPARATE_HEADERS=ON` is a buildable, verified optional separate-header configuration; shipped clangd still embeds headers by default. No new compiler/clangd binary is copied into the consumer's shipped static assets or producer's shipped artifacts. A clean new LLVM baseline link and browser repeats on other hardware remain necessary before claiming the first-production-pass O3 effect or a general header-separation benefit.

The browser matrix completed with exit `0`; its private log is `/home/seorii/logs/wasm-performance-chromium-20261007.log`, with status in the same complete log path plus `.status`. The separate final build and packaging checks below validate the resulting implementation without replacing or altering these measured samples.

### Browser reproduction

The isolated performance Vite configuration supplies COOP/COEP and a dedicated dependency cache. The runner uses the workspace's Chromium executable helper and browser-cookie helper; it does not embed cookie values. Serve that probe separately from product validation and avoid rebuilding its dependencies during measurements. With fixtures prepared as above, run the runner from the wasm-idle checkout:

```sh
pnpm exec vite --force --config scripts/performance-vite.config.mjs

node scripts/benchmark-clang-browser.mjs \
  --fixtures /path/to/browser-fixtures/fixtures.json \
  --base-url http://127.0.0.1:5192/wasm-idle/ \
  --runs 3 --json /path/to/browser-comparison.json
```

Run long commands detached with private logs and status files, as required by the workspace. Then use the summary command above without `--partial` and review all phases, transfer bytes, and full completion batches before choosing artifacts. These headless development-probe results are local measurements; transfer counts omit tooling and HTTP headers, timing ranges are substantial in some repeats, and they are not production page-navigation or full Monaco-editor latency measurements. The repository-managed Monaco cancellation patch is independently validated against the actual pinned provider and real Chromium.

### Final source and candidate-package checks

The final Core, LLVM runtime and LSP package builds passed. Focused checks then passed 97 LSP tests, 44 LLVM tests and 377 host tests (518 tests in that final run), followed by the LLVM package-boundary check. These include the final custom-asset compatibility changes: compressed-only receipts retain their original integrity contract, partial logical receipts fail validation, and receiptless configurations without host WebCrypto retain the legacy worker preparation path. The native verified streaming path remains unchanged by these fallbacks.

A separate final review bound the compiler fingerprint to the exact bytes compiled into the actual `WebAssembly.Module`, retaining that fingerprint with cached Modules instead of fetching an asset URL again. Overrides returning Modules without a known fingerprint safely skip optional PCH reuse. Its focused 77-test group and LLVM type check passed. This preserves the actual-compiler identity requirement when URLs change or caller-provided Modules bypass ordinary loading. These counts overlap earlier checks and should not be summed into a unique-test count.

The final configured-header compatibility check also passed 19 server tests, including six new cases, plus the LSP type check and build. Bare SHA-256 and compressed-only header receipts preserve their compressed integrity gate; supplied logical metadata must still be complete and correct before worker startup. The full dual-receipt preparation, verification and mounting path used by the Chromium matrix is unchanged. PID `138952` exited `0`; its private log is `/home/seorii/logs/wasm-idle-clangd-header-receipt-20261007-upevhfde.log`, with the exit status at that complete log path plus `.status`.

The separated-header candidate was staged outside all shipped artifact directories, verified as a seven-asset bundle, and prepared into an isolated release directory. All refresh, verification and release commands exited `0`; 43 selected producer tests passed with no skips. The three clangd assets' compressed and logical hashes match the exact Chromium fixtures above. Eight other artifact files were preserved byte-for-byte, including Clang, LLD, MemFS and sysroot archives. The final comparison verified 5,533 headers and the shared-memory import with a 2 GiB minimum and 4 GiB maximum, together with the pthread linker settings and a worker pool of at least eight.

Concrete local candidate receipts and evidence are:

- [Candidate toolchain receipt](/home/seorii/.cache/wasm-llvm-perf-20261006/final-clangd-package-20261007-011148-artifacts/toolchain.json)
- [Release runtime manifest](/home/seorii/.cache/wasm-llvm-perf-20261006/final-clangd-package-20261007-011148-release/runtime-manifest.v1.json)
- [Release build receipt](/home/seorii/.cache/wasm-llvm-perf-20261006/final-clangd-package-20261007-011148-release/runtime-build.json)
- [Asset/preservation/pthread comparison](/home/seorii/.cache/wasm-llvm-perf-20261006/final-clangd-package-20261007-011148-comparison.json)

| Final operation                                                               |    PID | Private log                                                                | Exit-status file                      | Exit |
| ----------------------------------------------------------------------------- | -----: | -------------------------------------------------------------------------- | ------------------------------------- | ---: |
| Core/LLVM/LSP builds and 518 focused tests                                    | 106358 | `/home/seorii/logs/wasm-idle-final-checks-20261007-0bnwwenk.log`           | same complete log path plus `.status` |    0 |
| Actual Module fingerprint tests/type check                                    |      — | `/home/seorii/logs/wasm-idle-pch-module-fingerprint-20261007-i1tio577.log` | same complete log path plus `.status` |    0 |
| Candidate refresh, seven-asset verification, release preparation and 43 tests | 114156 | `/home/seorii/logs/final-clangd-package-20261007-011313.log`               | same complete log path plus `.status` |    0 |

An initial packaging-runner attempt exited `1` with a Python syntax error before executing producer commands; its completed private log is `/home/seorii/logs/final-clangd-package-20261007-011148.log`, with status at the same complete log path plus `.status`. The corrected runner produced the passing candidate above. Candidate receipts are local review artifacts; the default embedded-header assets and all shipped compiler bytes remain unchanged.

After the actual-Module fingerprint fix, LLVM runtime and LSP were rebuilt once more from the final source; both builds exited `0`. The new browser harness files also passed their final formatting check. This rebuild is recorded under PID `122627`, private log `/home/seorii/logs/wasm-idle-final-rebuild-20261007-8fz2nmh9.log`, final status `0` at the same complete log path plus `.status`.

Earlier final-browser probe attempts have retained private logs:

| Attempt                               | Private log                                                         | Exit | Resolved probe problem                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial worker-pool observation       | `/home/seorii/logs/wasm-idle-final-chromium-20261007-um4p809l.log`  |    1 | Initial CDP target events had empty URLs; the observer now queries authoritative target information.                                                                                                                                                                                                             |
| Second worker-pool observation        | `/home/seorii/logs/wasm-idle-final-chromium2-20261007-yw4ah4fx.log` |    1 | The same target-observation assertion was corrected.                                                                                                                                                                                                                                                             |
| First complete restart/provider probe | `/home/seorii/logs/wasm-idle-final-chromium3-20261007-ew93q2h5.log` |    1 | All five startup/restart cases and the pinned Monaco-token browser test passed; the subsequent full editor probe could not load local LSP dist files because the development server's allowed filesystem paths omitted them. An isolated private validation-server configuration now allows the repository root. |

A readiness-only fourth runner was stopped before launching Chromium because it polled the probe server's root rather than its specific HTML path. Its log is `/home/seorii/logs/wasm-idle-final-chromium4-20261007-kjuvy_s8.log`, final status `-15`; the corrected runner uses the verified probe HTML URL.

Each status file is its complete log filename plus `.status`. These probe failures are retained for reproducibility; they did not replace the 144 passing benchmark samples or change product server configuration.

The fifth final Chromium runner used the rebuilt final source and passed all five direct clangd startup/restart/custom-configuration cases. Both embedded and separated native paths compiled Wasm once on the first start and reused the compiled Module on restart, with zero benchmark asset requests on that restart; the pool observer verified at least eight Emscripten pthread workers. The receiptless host-without-WebCrypto fallback passed in Chromium; compressed-only custom receipts are covered by the final focused tests above. The actual pinned Monaco cancellation-token browser test passed once more. The full editor probe passed its C++ feature case before its subsequent C case failed: the test's file-switch helper had returned while the actual editor URI and language still referred to `main.cpp`/C++. This is a mixed-language editor-selection validation limitation; no unrelated product file-switch change was made. Follow-up validation uses a separate fresh context for each language and waits for the actual editor URI before editing.

That completed runner's private log is `/home/seorii/logs/wasm-idle-final-chromium5-20261007-iz98k8x2.log`; its final status is `1` at the same complete log path plus `.status`. Its passed direct startup/Module/pthread and provider checks remain separate evidence from the editor-selection failure. The 144-sample comparison already validated C/C++ emitted program output, clangd diagnostics/completion and pthread startup for all measured artifacts.

The [tracked final restart/Module/pthread evidence](https://github.com/seo-rii/wasm-idle/blob/7fc8769b832f6f23c8ce4052e1c84b25050e6757/scripts/performance-results/clangd-restart-chromium.json) preserves the five cases, compileStreaming/compile counts, request payloads, authoritative pthread-target observations, diagnostics and completions.

The tracked restart receipt is 31,997 bytes, SHA-256 `d2396a4b76576343d5ea8351772a53f89a6fdcd13cede062a0b121cbe8a8a6e6`; it records 13 observed targets titled `em-pthread`, plus the root clangd worker (14 worker targets total), in each of the four native first-start/restart cases. These are functional validation samples, rather than additional repeated performance medians.

The complete existing C++ Monaco-editor feature case was then run independently in a fresh context, together with the actual pinned cancellation-token provider test: four selected tests passed, including valid-invalid-valid diagnostics and completion suggestions. The completed PID was `128367`, private log `/home/seorii/logs/wasm-idle-monaco-cpp-final-20261007-2crv348q.log`, final status `0` at the same complete log path plus `.status`. This avoids the earlier mixed-language selection race while preserving the product's file-switch behavior.

The final separate-context [C/C++ Monaco editor evidence](https://github.com/seo-rii/wasm-idle/blob/7fc8769b832f6f23c8ce4052e1c84b25050e6757/scripts/performance-results/monaco-c-cpp-chromium.json) passed after checking the actual model URI and language before and after every edit: C used `main.c`/`c`, C++ used `main.cpp`/`cpp`. C diagnostics changed from zero markers to four markers including a line-4 error, then back to zero; C++ changed from zero to two including a line-3 error, then back to zero. The valid and corrected workloads use their selected stdio/wchar/math and filesystem/vector headers, avoiding legitimate unused-include warnings. Monaco displayed both `vector<class Tp, class Alloc>` and `vector` suggestions with successful matching clangd completion request `18`. The probe checked service-worker control and cross-origin isolation, and observed no page errors.

This final evidence is 1,880 bytes, SHA-256 `67d7a3393f9392331a39fc79fc8d6f2b1862a6169f15c060fb8ab717845e44bd`. The validation process PID was `133666`, completed private log `/home/seorii/logs/wasm-idle-monaco-model-gated3-20261007-7nrn5xnj.log`, final status `0` at the same complete log path plus `.status`. Earlier private attempts exited `1` because the probe read its model hook during remount (`/home/seorii/logs/wasm-idle-monaco-model-gated-20261007-qggljqsk.log`) or incorrectly required zero markers while its valid workload triggered legitimate unused-include warnings (`/home/seorii/logs/wasm-idle-monaco-model-gated2-20261007-7u7nqv0v.log`). Their status files have the same `.log.status` naming. Only validation waits/workloads changed; the existing combined-language file-switch test's timing limitation remains outside these product changes.

All task-owned validation servers were stopped after the checks, and ports 5191/5192 no longer listen. Final private application/probe server logs are `/home/seorii/logs/wasm-idle-final-app-vite-20261007-r4gvq9h5.log` and `/home/seorii/logs/wasm-idle-final-probe-vite-20261007-l7qqhpyn.log`, each with shutdown status `143` in its `.log.status` file. The earlier PCH server log `/home/seorii/logs/wasm-idle-pch-vite-20261007-1lygr5_p.log` has status `143` in its sibling `.status` file; the matrix probe log `/home/seorii/logs/wasm-perf-probe-vite-20261007-nested.log` has status `-15` in its `.log.status` file. These are the expected explicit SIGTERM shutdowns, separate from test exit statuses.
