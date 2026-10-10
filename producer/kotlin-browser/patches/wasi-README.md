# WASI Preview 1 stdlib allocation patch

`wasi-preview1-io.patch` changes only two allocation sizes in the pinned official
Kotlin stdlib: `subscription` 20 → 48 bytes and `event` 26 → 32 bytes. Field offsets,
poll/read/write sequencing, diagnostic checks, EOF handling, and language behavior
remain in the official implementation. The patch does not change user source.

The source and resulting file hashes are recorded in `wasi-preview1-io.json`.
The pin is Kotlin development candidate `4d78aae1e337cd40f69baa865aed950fe807a775`.
The ABI reference is wasi-libc `165235bc467d5fa52d424f5d82587dfb76ed9d54`.

The pinned [`MemoryAllocation.kt`](https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/libraries/stdlib/wasm/src/kotlin/wasm/unsafe/MemoryAllocation.kt)
guarantees pointers aligned to 8 bytes. Its scoped allocator delegates to an arena
allocator backed by a free list, which rounds each allocation up to a multiple of
8. Therefore the original 26-byte event already receives a 32-byte physical slot;
the original 20-byte subscription receives 24 bytes, below the standard 48-byte
structure. [Actual Kotlin allocator observations](../stdlib-probe/allocator-canary/README.md)
now confirm these extents and alignment with the source-built patched library.
The original-size subscription probe only reads the 48-byte span; it does not
execute the unpatched stdlib or demonstrate corruption in it. The patch uses the existing allocator
contract and does not add a separate alignment adapter.

Verify against a source directory containing the three pinned source files and
a downloaded, pinned `wasi/wasip1.h`:

```sh
node producer/kotlin-browser/patches/wasi-stdlib-patch.mjs verify \
  --source-dir /path/to/unmodified-kotlin-sources \
  --abi-header /path/to/wasip1.h \
  --output /path/to/new-verification-receipt.json
```

The verifier checks original/source dependency/header hashes, applies the actual
Git patch to a temporary source tree, compares the entire patched file, reverses
the patch, and compares the restored original. The receipt distinguishes selected
source verification from a verified complete checkout or compiler build.

Apply in an isolated build source tree; the shared audit source cache must retain
the unmodified upstream bytes:

```sh
node producer/kotlin-browser/patches/wasi-stdlib-patch.mjs apply \
  --source-dir /path/to/isolated-kotlin-build-sources \
  --abi-header /path/to/wasip1.h \
  --output /path/to/new-application-receipt.json
node producer/kotlin-browser/patches/wasi-stdlib-patch.mjs check \
  --source-dir /path/to/isolated-kotlin-build-sources \
  --abi-header /path/to/wasip1.h \
  --output /path/to/new-patched-input-receipt.json
```

The producer then builds the complete target `wasmWasi` stdlib from that source
tree. The pinned stdlib Gradle file selects `wasm/wasi/src` in `wasmWasiMain`, which
also depends on `wasmCommonMain` and `nativeWasmWasiMain`. Generated common version
and copied builtins inputs must be prepared by the upstream build. The proposed
task is `:kotlin-stdlib:compileKotlinWasmWasi`; confirm it with the pinned Gradle
build before recording it as an executed task. It has not been run here.

Record the actual compiler/bootstrap/JDK/Gradle identities, generated-source
hashes, patch digest, target KLIB hash, and compile command in the build receipt.
Rebuild the programs with that target KLIB. Compiling this one `io.kt` into an
override library or editing a precompiled KLIB does not establish an equivalent
patched stdlib. A bootstrap-version stdlib is a separate artifact probe and
cannot be labeled as a same-commit patched target stdlib.

This source-patch verification does not pass G5 or enable public Kotlin support.
The [source stdlib probe](../stdlib-probe/README.md) now builds the complete pinned
WASI target library through the official CLI, including generated version and
copied builtin inputs. The upstream Gradle task above is still unrun. Its
[source-build receipt](../evidence/stdlib-source-build.json) records the actual
patched KLIB hash, commands and exit status. Hello World and stdin-driven Fibonacci
built with that KLIB run in Chromium; their execution receipt is maintained in
wasm-idle. Actual allocator alignment and full-sized patched poll canaries now
pass in Node and two fresh offline Chromium Workers, including `AGAIN` followed
by partial UTF-8 output. Complete stdin/EOF/Unicode/stderr coverage and the
remaining G5 checks are still required.
