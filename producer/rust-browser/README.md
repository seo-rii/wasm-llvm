# Rust browser compiler producer

This directory owns the source build for the full Rust compiler that runs as a
`wasm32-wasip1-threads` program in the browser. The compiler contains its matching LLVM 22 code
generator and LLD linker. It does not depend on the historical LLVM 16 Emscripten `llc.js` and
`lld.js` split backend, and it is not a handwritten parser, interpreter, or language subset.

## Reproducibility contract

`manifest.json` pins every source checkout by commit and Git tree, the complete post-patch tree,
every patch by SHA-256, and both the bootstrap compiler-rt archive and its extracted payload by byte
length and SHA-256. It also pins the five Rust stage0 host-tool archives by URL, byte length, and
SHA-256; Rust bootstrap consumes those exact archives under the date and checksums in `src/stage0`.
Stage0 is an explicit bootstrap input for building stage2 from source, not a browser compiler or
runtime asset copied into the producer output.
The manifest also locks the host CMake, Ninja, Make, GCC, Python, Node, Git, and tar versions and
refuses a different build environment. The canonical container additionally pins the amd64 Debian
image digest, Debian package snapshot, and downloaded CMake and Node archives. The build sets
`SOURCE_DATE_EPOCH`, keeps generated files outside the patched source worktrees, disables Cargo
incremental output, and remaps the producer work directory.

Before attestation, the producer recomputes every patched Git tree, re-verifies the pinned Rust
submodules, bootstrap payload, and rendered configuration, and rejects ignored or unexpected
source files. It then writes a sorted output receipt with a SHA-256 for every produced file.

The current producer baseline is:

- Rust `1.99.0` at `48c2cee70232ecc3a6a8e285b2e15620b39f82a7`
- rust-lang LLVM `22.1.8` at `52ed14fcd56afc30f9cccd8ca8ce237c2eef7e04`
- wasi-libc at `08799da37ae52955427ebec1336b49d6a8eb5051`
- GCC/libstdc++ at `ae91b5dd14920ff9671db8ff80c0d763d25f977f`
- backtrace-rs at `d902726a1dcdc1e1c66f73d1162181b5423c645b`
- compiler host `wasm32-wasip1-threads`
- output standard libraries for `wasm32-wasip1`, `wasm32-wasip2`, and `wasm32-wasip3`

The Rust and LLVM patches were ported from `olimpiadi-informatica/wasm-compilers` commit
`8a37216d7529e8e7cb5aeac1610f0e654af86850`; the vendored Apache-2.0 license and modification
notice are included here.

The wasi-libc patch records the `__wasip1__` and `__wasip2__` predefined macros emitted by the
pinned LLVM 22 Clang so wasi-libc's own metadata self-check remains enabled.
The LLVM patch also selects its unsupported-platform jobserver implementation for WASI, where Unix
jobserver file-descriptor duplication is unavailable.
The Rust manifest's `requiredNewFiles` list additionally verifies that the patch itself creates the
in-process LLD bridge and both libloading compatibility trees. A cached worktree cannot substitute
untracked files that are absent from the checked-in patch.

## Commands

Verify the checked-in lock and patch files without downloading sources:

```bash
npm run producer:rust:verify
```

Prepare immutable source checkouts, separate patched worktrees, the verified bootstrap archive,
and rendered absolute-path build configuration:

```bash
WASM_LLVM_RUST_BROWSER_WORK_DIR=/path/to/work \
  npm run producer:rust:prepare
```

Build and attest the compiler. This is a large native and cross LLVM build; reserve at least 60 GB
of free disk space and 16 GB of memory.

```bash
WASM_LLVM_RUST_BROWSER_WORK_DIR=/path/to/work \
NINJA_JOBS=8 \
  npm run producer:rust:build
```

For an audit build, pass a new empty directory. `rebuild.sh` refuses a non-empty directory, so a
clean run cannot silently reuse prior stamps or source edits.

```bash
npm run producer:rust:rebuild -- /path/to/new-empty-work-directory
```

The canonical cross-machine audit path uses the digest-pinned container and also requires a new
empty work directory:

```bash
NINJA_JOBS=8 \
  npm run producer:rust:container-rebuild -- /path/to/new-empty-work-directory
```

The receipt records whether the assets were built with the canonical `container` runner or the
strictly version-checked `host` runner.

The final directory contains `rust/bin/rustc.wasm`, the compiler libraries and target sysroots
under `rust/lib`, and `producer-receipt.json`. Consumers must reject assets whose receipt does not
match this producer manifest.

## Patch maintenance

Each patch is a full-index Git diff against the exact source commit in `manifest.json`. To refresh
a patch after making reviewed changes in a detached worktree:

```bash
git -C /path/to/patched-rust add --intent-to-add -- path/to/each/new-file
git -C /path/to/patched-rust diff --binary --full-index > \
  producer/rust-browser/patches/rust.patch
sha256sum producer/rust-browser/patches/rust.patch
```

`git diff` omits untracked files unless they are first added with `--intent-to-add`. Keep every
producer-created source file in `requiredNewFiles`; `producer:rust:verify` rejects a patch that does
not contain a `new file mode` section for each one.

Compute the post-patch tree without committing the patch:

```bash
index_file="$(mktemp)"
GIT_INDEX_FILE="$index_file" git -C /path/to/patched-rust read-tree HEAD
GIT_INDEX_FILE="$index_file" git -C /path/to/patched-rust add --all
GIT_INDEX_FILE="$index_file" git -C /path/to/patched-rust write-tree
rm -f "$index_file"
```

Update the matching `patchSha256` and `patchedTree`, plus the SHA-256 of every changed build input
listed in `configurationFiles`. Then update `wasm-idle/runtimes/wasm-rust/producer-lock.json` from
the finalized producer manifest and run:

```bash
npm run producer:rust:verify
npx vitest run runtime/rust/test/producer.test.ts
NINJA_JOBS=8 npm run producer:rust:container-rebuild -- /path/to/new-empty-work-directory
```

Do not reuse a prior output receipt after any source, patch, configuration, or producer-script
change. The manifest hash intentionally makes such a receipt invalid.

## Historical runtime

The previously shipped `1.79.0-dev` compiler came from Bjorn3's browser Rust branch at
`29fc7ad5e5af675b0d1746dcf4bbe45701d70461`, based on upstream
`05ccc49a4412a23a7afa1226804bb44558fb15b0` with LLVM
`af8f9eb61a2ad4ee1f2d3f46d157b93a47c6a4bf`. The later local build added uncommitted portability
edits and was packaged with a separate LLVM 16 backend. That lineage is recorded for provenance,
but it is not the source baseline for this new producer.
