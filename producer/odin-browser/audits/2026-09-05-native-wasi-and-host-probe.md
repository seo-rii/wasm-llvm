# Odin native WASI baseline and compiler-host probe — 2026-09-05

## Result

The official Odin compiler successfully compiled the checked-in two-file fixture to a relocatable
WASI object. Native LLD linked it, and Node WASI passed four input/output/exit cases. The invalid
program produced a compiler diagnostic and no output object.

Compiling the **compiler itself** for Emscripten is blocked by upstream host platform code.
No browser compiler Wasm, browser execution evidence, or consumer integration was produced.
`manifest.json` therefore retains `readiness.ready: false` and an empty browser artifact list.

## Inputs

| Input | Verified identity |
| --- | --- |
| Odin source | Official `dev-2026-09`, commit `a2fb372b76e81ef31fbbc8a2cf2b4fdf5ac6c924` |
| Official Linux x64 archive | 70,000,274 bytes; SHA-256 `167c3e1d7056419dad2e04bb3bd98715b7ff286d4c125f3c5a5ee337c6254283` |
| Native compiler | 140,670,440 bytes; SHA-256 `fc74430486881325ba5b68db58645102a304a729f65fc6488ea68ae7bd869dc6`; reports `dev-2026-09-nightly:a2fb372`, LLVM 20.1.8 |
| Native linker | LLD 21.0.0, Swift LLVM commit `82cdc19fa54d566969527b56f587ea8ea30bef51`; SHA-256 `e7ce91d07b4419ea779da6b575721c17eb7c44f932e63b6e2d03a9afe75cce61` |
| WASI harness | Node v24.1.0; SHA-256 `d749a21260a55be742733ae38a4f2def14822f9863a574993abeb65617747d44` |
| Compiler-host SDK | Emscripten 6.0.0, emsdk commit `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` |
| Host probe LLVM headers | LLVM 22.1.8; generated config SHA-256 `b806b09268fe673a5b775c696a0cc43c2fa95334b98bef3290f27aff3dac7983` |

The LLVM header archive is distributed under the release tag `llvm_22.1.10`; its contents identify
themselves as 22.1.8 and specify `wasm32-unknown-wasi` as the default target triple. Only headers
were used for the Emscripten syntax probe. No compatibility claim is made about linking its
libraries into an Emscripten compiler.

Source verification checked all 2,930 tracked files against the pinned Git tree, including byte
comparisons independent of the Git index's assume-unchanged/skip-worktree flags. The baseline
explicitly selected this checkout through `ODIN_ROOT`.

## Native target execution

The exact commands and all file hashes are recorded in the generated local
`out/odin-browser/baseline-final/native-baseline-receipt.json`. The important split is:

```text
odin build fixtures/stdin-sum -target:wasi_wasm32 -build-mode:obj -out:stdin-sum.o -o:minimal -thread-count:1
wasm-ld stdin-sum.o --stack-first -z stack-size=1048576 --allow-undefined -o stdin-sum.wasm
node --no-warnings scripts/run-wasi-fixture.mjs stdin-sum.wasm
```

| Artifact from this invocation | Bytes | SHA-256 |
| --- | ---: | --- |
| `stdin-sum.o` | 455,282 | `d943fe7619c03f5362507af75167081faf75c97d85e1c25a0acf9ce101b5e0de` |
| `stdin-sum.wasm` | 354,509 | `e6499f50590dd3753c15e7f8f3368b7543755013ec6db79c856771519ff43668` |

These are measured artifact identities, not a claim of reproducible bytes across filesystem paths.
Reproduction generates a fresh receipt, including its source and output paths.

| Case | Input | Actual stdout | Actual stderr | Exit |
| --- | --- | --- | --- | ---: |
| Standard input | `5\n7\n30\n` | `count=3 sum=42\n` | empty | 0 |
| EOF without newline | `-9\n4\n2` | `count=3 sum=-3\n` | empty | 0 |
| Empty EOF | empty | `count=0 sum=0\n` | empty | 0 |
| Invalid input | `abc\n` | empty | `invalid integer\n` | 2 |

The invalid source fixture failed compilation with exit 1 and `Undeclared name: missing_symbol`;
no `invalid.o` was produced. The executable module exports `_start` and `memory`, and imports
only the locked fixture's WASI Preview 1 functions, including `fd_read`, `fd_write`, and `proc_exit`.

## Compiler-host failure

The producer invoked real Emscripten `em++` with `-std=c++14 -fsyntax-only -ferror-limit=8`,
the verified LLVM include directory, and unmodified upstream `src/main.cpp`. It exited 1:

```text
src/gb/gb.h:91:4: error: This UNIX operating system is not supported
src/gb/gb.h:151:3: error: Unknown CPU Type
src/gb/gb.h:219:12: fatal error: 'sys/sendfile.h' file not found
```

The generated local `out/odin-browser/host-validated/host-probe-receipt.json` records the exact
tool invocation, source/script/header hashes, compiler version, and complete diagnostic text.
Its status is `blocked`, independently of the successful native target receipt.

This establishes the first real host port blockers. It does not establish the complete set of
changes necessary to run the compiler in a Worker. Platform threading, filesystem behavior,
compiler resource use, and external linker execution remain to be implemented and tested.
No host macros were spoofed, compiler implementation was replaced, or missing platform behavior
was stubbed out to obtain a nominal passing build.

## Verification

- Pinned source/bootstrap preparation: passed.
- Native compile, separate link, four actual WASI executions, invalid-source diagnostic: passed.
- Baseline receipt re-verification: passed.
- Focused tests with the real native compiler and producer repository check: 10 passed, none skipped.
- Tampering with source, hidden tracked source, injected ignored/untracked files, native binary,
  artifact bytes, artifact paths, and browser-readiness evidence is rejected.
- Emscripten compiler-host probe: exit 1 with the expected upstream platform errors.

The final validation process exited 0; log:
`/home/seorii/logs/odin-validate-final-113c2770f3a2470eb3c0f47203b7fa92.log`.
The host probe process exited 1; log:
`/home/seorii/logs/odin-host-validated-31247082aa4846d584ed9ea0ab2adfda.log`.
Both processes ran in the background from the start with private logs.

## Upstream references

- [Official monthly source release](https://github.com/odin-lang/Odin/tree/a2fb372b76e81ef31fbbc8a2cf2b4fdf5ac6c924)
- [Compiler build and supported LLVM versions](https://github.com/odin-lang/Odin/blob/a2fb372b76e81ef31fbbc8a2cf2b4fdf5ac6c924/build_odin.sh)
- [Compiler host platform definitions](https://github.com/odin-lang/Odin/blob/a2fb372b76e81ef31fbbc8a2cf2b4fdf5ac6c924/src/gb/gb.h)
- [Upstream external Wasm linker invocation](https://github.com/odin-lang/Odin/blob/a2fb372b76e81ef31fbbc8a2cf2b4fdf5ac6c924/src/linker.cpp)
- [WASI standard file descriptors](https://github.com/odin-lang/Odin/blob/a2fb372b76e81ef31fbbc8a2cf2b4fdf5ac6c924/core/os/file_wasi.odin)
