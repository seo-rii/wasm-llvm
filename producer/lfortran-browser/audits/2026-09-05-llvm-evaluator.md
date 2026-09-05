# LFortran LLVM evaluator acceptance — 2026-09-05

The browser-hosted upstream compiler compiled and executed the fixtures through
LLVM and LLD in both Node and Chromium. Every successful case produced an LLVM
object and a linked Emscripten side module inside the compiler instance. No
native compiler or server participated in these acceptance runs.

## Inputs and artifacts

| Input | Version or identity |
| --- | --- |
| LFortran source | `ab867a23029b0c1b1c3131b5a0e2363709be37f0`, 97 commits after `v0.65.0` |
| LLVM | 22.1.8, pinned Emscripten-forge binary package |
| Emscripten | 4.0.9 |
| Native build prerequisites | GCC 12.2.0, CMake 4.0.3, Bison 3.8.2, re2c 3.1 |
| Node acceptance | v24.1.0 |
| Chromium acceptance | 149.0.7827.55, fresh module Worker per case |

The recipe follows upstream's JupyterLite LLVM evaluator path. The native
helper generates runtime module metadata during the build. Runtime acceptance
uses only the resulting Emscripten compiler and its preloaded modules.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `lfortran.js` | 968,283 | `783a9d989b3dac8f4b28e8e61fc71fb8a158c10e60cb36e92d3fd5e45716c2b6` |
| `lfortran.wasm` | 80,661,511 | `33d7e052fe9269f437206d60c99e7719efa0f79809196e7f0a37fb5d19707303` |
| `lfortran.data` | 179,758 | `b23ab435da811ad7db46e931b2bb6fdd472269983deb14ba9f79af34c77cfb60` |

These hashes identify this local build. Build outputs remain ignored and are
not committed or deployed. The build locks the LLVM binary input; it does not
rebuild LLVM from source or provide a hermetic operating system image.

## Actual compilation and execution

| Case | Standard input | Expected result | Node | Chromium |
| --- | --- | --- | --- | --- |
| Array `READ` | `3\n10 20 30\n` | stdout `60\n`, exit 0 | passed | passed |
| Same source, different array | `4\n-5 6 7 8\n` | stdout `16\n`, exit 0 | passed | passed |
| Module procedure | empty | stdout `42\n`, exit 0 | passed | passed |
| Invalid source | empty | undeclared `this_symbol_is_not_declared` diagnostic, exit 1 | passed | passed |

Both engines produced matching object and side-module hashes for each
successful source. Positive cases require exact stdout, an empty stderr and a
zero exit code. The invalid-source case must contain the upstream semantic
diagnostic; an unrelated runtime exception does not pass.

The Node receipt binds all four cases, source and stdin hashes, generated
artifact identities and the validator hash. It keeps `browserAcceptance: false`
to describe Node's scope. The separate Chromium receipt records browser
version, compiler artifact hashes, producer input hashes and browser harness
hashes. Artifact and harness identities are checked again before browser
acceptance is recorded.

The final build, package, Node validation and strict verification process exited
0. The separate Chromium acceptance process exited 0. Nine focused tests,
including the repository contract and browser-result rejection cases, passed.

Reproduce these results with the commands in the [producer README](../README.md).
The Node receipt is `out/lfortran-browser/artifacts/producer-receipt.json`.
This run's browser receipt is
`out/lfortran-browser/browser-acceptance-2f84b86d-854d-4832-8971-9fbe80e8fdf5.json`.
Receipts contain the case-level evidence; this report summarizes the observed
results rather than serving as an artifact verification substitute.

## Consumer work remaining

The generated program is an Emscripten dynamic side module loaded by the
compiler instance. It is not a standalone WASI executable. Side modules remain
loaded for the instance lifetime, so each consumer run needs a fresh Worker.

`wasm-idle` still needs artifact loading, Worker ownership, asynchronous terminal
input, filesystem policy, cancellation and language/backend registration before
users can select this compiler. The manifest therefore retains readiness false.
The roughly 80.7 MB uncompressed compiler also needs consumer startup and memory
measurement. These four fixtures demonstrate the upstream LLVM route; they do
not establish complete Fortran language or standard-library coverage.
