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
| Chromium acceptance | 147.0.7727.15, fresh module Worker per case |

The recipe follows upstream's JupyterLite LLVM evaluator path. The native
helper generates runtime module metadata during the build. Runtime acceptance
uses only the resulting Emscripten compiler and its preloaded modules.

This build includes the nested statement-transformation fix in
`patches/source-archive-and-bridge.patch`. The upstream formatted `PRINT` pass
could leave a removal flag set after transforming a nested body and delete its
enclosing `IF` or `DO`. Initializing the flags and restoring the enclosing
transformation state preserves both output and surrounding side effects.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `lfortran.js` | 968,283 | `348d5472c307da2bae15eb73e8a38da0e7c2a4cfaebacbccbee2b163806a59c3` |
| `lfortran.wasm` | 80,662,569 | `b7c8ef4e942e9965a511b8700955c47c1f48d4ef18c61953a4847a6dcd680181` |
| `lfortran.data` | 179,758 | `6d6dbe72e4f23f9761eb8005c8a737490750f54dbb173c6455a9c9cb9489c99f` |

These hashes identify this local build. Build outputs remain ignored and are
not committed or deployed. The build locks the LLVM binary input; it does not
rebuild LLVM from source or provide a hermetic operating system image.

## Actual compilation and execution

| Case | Standard input | Expected result | Node | Chromium |
| --- | --- | --- | --- | --- |
| Array `READ` | `3\n10 20 30\n` | stdout `60\n`, exit 0 | passed | passed |
| Same source, different array | `4\n-5 6 7 8\n` | stdout `16\n`, exit 0 | passed | passed |
| Module procedure | empty | stdout `42\n`, exit 0 | passed | passed |
| Nested `IF`/`DO` output and accumulation | empty | stdout `if=1\nloop=1\nif=2\nloop=2\nloop=3\ntotal=6\n`, exit 0 | passed | passed |
| EOF through `IOSTAT` and `IF` | empty | stdout `EOF\n`, exit 0 | passed | passed |
| Same source, `ELSE` branch | `7\n` | stdout `7\n`, exit 0 | passed | passed |
| Invalid source | empty | undeclared `this_symbol_is_not_declared` diagnostic, exit 1 | passed | passed |

Both engines produced matching object and side-module hashes for each
successful source. Positive cases require exact stdout, an empty stderr and a
zero exit code. The invalid-source case must contain the upstream semantic
diagnostic; an unrelated runtime exception does not pass.

The Node receipt binds all seven cases, source and stdin hashes, generated
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
`out/lfortran-browser/browser-acceptance-d2289045-7234-465f-b283-879741af1a70.json`.
Receipts contain the case-level evidence; this report summarizes the observed
results rather than serving as an artifact verification substitute.

## Consumer delivery

The generated program is an Emscripten dynamic side module loaded by the
compiler instance. It is not a standalone WASI executable. Side modules remain
loaded for the instance lifetime, so each consumer run needs a fresh Worker.

The companion `wasm-idle` integration consumes these exact reviewed assets and
provides Worker ownership, asynchronous terminal input, filesystem policy,
cancellation and a separate experimental `LFORTRAN` entry. Its compiler and
program share a bounded imported memory, with a 128 MiB minimum and a 512 MiB
default maximum. Runtime asset publication and deployment remain separate; the
producer manifest retains readiness false. These seven fixtures demonstrate the
upstream LLVM route and the nested-output repair. They do not establish complete
Fortran language or standard-library coverage.
