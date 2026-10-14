# Nim browser artifacts

This producer owns the pinned Nim distribution acquisition, asset and license transformations,
LLVM compatibility inputs, and artifact receipt previously implemented in
`wasm-idle/scripts/sync-wasm-nim.mjs`. The consumer owns runtime workers, shared compiled-module
caching, delivery compression, application manifests, and browser execution.

The distribution is `benagastov/Nim-WASM-Compiler` at
`ca3471ae124b40b51268da6e202753dfa061731c`. `sources.lock.json` retains the archive digest,
individual original and modified file receipts, and the limits of the existing provenance:
Nim 2.2.4 and the LLVM 8.0.1 assets are content-locked prebuilts, not source-build-attested outputs.
The compiler binaries and sysroot are preserved byte for byte. This producer does not claim a
new Nim or LLVM source build.

## Package and verify

Requires Node 20+. Reading a source archive additionally requires GNU tar. Choose one explicit
input; absent or invalid supplied inputs never fall back to another source.

```sh
# An unpacked, pinned upstream distribution containing demo/static and LICENSE.
pnpm package:nim -- --source /path/to/Nim-WASM-Compiler --out out/nim-browser

# A locally cached archive, or explicitly download the exact locked codeload archive.
pnpm package:nim -- --archive /path/to/pinned-source.tar.gz --out out/nim-browser
pnpm package:nim -- --download --out out/nim-browser

# Migrate a previously published, content-locked wasm-idle installation without a download.
pnpm package:nim -- --from-runtime /path/to/static/wasm-nim --out out/nim-browser

pnpm verify:nim-artifacts -- --verify out/nim-browser
pnpm test:nim-producer
```

`WASM_LLVM_NIM_SOURCE_DIR` supplies an unpacked source root. Output directories must be new and
must not overlap input directories. Downloads reject redirects, wrong lengths, truncated or
excess bodies, and mismatched hashes. Archive processing reads only the explicitly named pinned
files to memory and does not extract archive entries onto the filesystem. Local sources reject
symlinks and are read and verified before publication.

`--from-runtime` reads canonical inert `.gz.bin`/`.bin` assets and independently verifies their
logical hashes. It accepts the current patched loader or the specifically recorded
`legacyRuntime.clangJs` hash, then upgrades that exact legacy loader to the same result as patching
the pinned raw source. There is no general acceptance of self-described installed assets.

## Consumer contract

The new output contains the eight raw logical assets at the paths in `sources.lock.json`, plus
`LICENSE`, `THIRD_PARTY_NOTICES.md`, the upstream `README.md`, and `producer-receipt.json`.
The producer's own documentation is not substituted for the upstream README.

The receipt has `schemaVersion: 1`, `format: wasm-llvm-nim-browser-artifacts-v1`,
`producerId: wasm-llvm/nim-browser`, `manifestSha256`, `sourceLockSha256`, and an `artifacts` array
of exactly eleven `{path, bytes, sha256}` entries. Every output hash is independently pinned in
the producer source lock. Consumers must pin the receipt or the complete output digest set and
verify the exact file set before copying or compressing it. Manifest/source-lock identity fields
alone do not authenticate arbitrary receipt contents.

The patched `clang.js` API is `init({assets, modules})`. `assets` contains the four exact
`clang.wasm`, `lld.wasm`, `memfs.wasm`, `sysroot.tar` ArrayBuffers. Optional `modules` contains
exactly the three corresponding native `WebAssembly.Module` objects. Modules are structured-cloned
to the inner compiler worker, while only buffers and the message port enter the transfer list.
The worker uses supplied compiled modules and retains the verified-byte compile fallback for
callers without a module cache. It performs no compiler-asset network fetches and returns linked
program bytes without executing the program in the compiler worker.

The producer migration does not make LLVM 8 compatible with the current Clang LLVM producer.
Consumers may share cache/service code while keying compiled modules by their exact verified
content and compatibility profile. C3 and LFortran keep their own existing producer manifests.
