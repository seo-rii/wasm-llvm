# Optional C / C++ sysroot delivery profiles

After preparing the same full, matched Clang sysroot used by `package-toolchain.mjs`:

```sh
node producer/clang-browser/scripts/package-language-sysroots.mjs \
  --sysroot /build/clang-sysroot \
  --toolchain-receipt /build/clang-browser/toolchain.json \
  --output /build/clang-language-sysroots
```

This command refuses an existing output directory. It derives two deterministic USTAR/gzip
archives without modifying compiler binaries, the original sysroot, toolchain.json, producer
locks, or the existing full release. C consumes c-sysroot.tar.gz; C++ consumes that archive plus
cpp-addon.tar.gz. The union is byte-identical to the input regular files, with no overlaps.
Only c++ header directories and libc++.a / libc++abi.a go in the add-on. Compiler resource
headers, compiler-rt, CRT, libc, libm and other C-capable libraries remain in the base.

The manifest records the source receipt hash, LLVM revision/version, full file-inventory hash,
compressed/logical archive lengths and SHA-256, and every file's length/SHA-256. This is a
derived-packaging receipt, not a new attestation that the compiler was rebuilt. The source
receipt still needs verification against the pinned producer manifest before release, and the
new manifest must itself be pinned by the consumer.

The input must be a materialized directory of regular files/directories (no links/devices).
Limits are 20,000 files and 128 MiB of input. Unsafe paths and USTAR overflow are rejected.
Packaging is deterministic across input modes, mtimes and directory enumeration order.
Each archive records parent directories before regular files, so the current wasm-idle tar
consumer can create its MemFS paths. The C++ add-on repeats shared parent directories; the
consumer's `addDirectory` operation is idempotent. Manifest `files` lists regular files only.
The output directory is reserved exclusively before writing, and `language-sysroots.v1.json`
is published last as the completion marker. Consumers must ignore an output without that
manifest, which can briefly exist while packaging is in progress.
If packaging fails after reservation, leave the incomplete directory in place rather than
deleting a path another process could have replaced. Inspect ownership before cleaning it up.

## Consumer gate

Do not change wasm-idle's runtime URLs or trust receipts in this PR. Publish and verify these
profiles first; a later consumer change can select the C base only when all translation units
are C. Mixed C/C++ workspaces and language overrides need the add-on. Keep the old full sysroot
fallback for deployments/custom loaders without this new manifest. No CDN deployment or claimed
byte/time reduction is included here.

## Validation

```sh
node --test test/clang-language-sysroots.test.mjs
```

Tests use small deterministic fixture sysroots and real gzip/USTAR extraction with GNU tar.
They check byte-preserving partitioning, resource headers, reproducibility, unsafe inputs,
provenance fields, parent-first directory entries, real-path output containment, and refusal
to overwrite outputs even when an output directory appears concurrently. A production
Clang/sysroot rebuild and real-browser C/C++ compatibility run remain release prerequisites.
