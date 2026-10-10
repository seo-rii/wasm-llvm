# MemFS memory-I/O candidate and producer optimization map

## Existing optimizations are not new work

At producer base 5c0592f3a9ea01eb2e8874ccf31f9e5de622b34e, build-toolchain.mjs
already uses MinSizeRel/-Oz, compile and link -flto, Wasm-only backends, stripped
outputs, optional hot-path -O2/-O3 and selectable Binaryen optimization. Clangd
already disables tidy/decision-forest work in its optimized profile. Repeating
these flags is not a new optimization. Source: producer/clang-browser/scripts/
build-toolchain.mjs and hot-path-launcher.sh on that base.

## Actual additional source candidate

The pinned upstream MemFS ReadIovec expands a short requested read to the entire
remaining file (`offset + len < size`) and fails to subtract earlier vector reads.
The candidate bounds each copy by min(request, remaining), advances the position
once, and returns EOF without touching memory at or past the file size. fd_pread
retains the descriptor cursor; fd_read advances it. MAX_FDS is an exclusive bound.

A growing regular fd_write previously reallocates and zeroes every added byte,
then immediately overwrites those bytes from guest iovecs. The candidate allocates
the same exact logical size and zeroes only an unwritten gap. It preserves existing
EnsureFileSize for explicit allocate/truncate expansion. Zero-length writes do not
grow truncated files. Summed vector lengths and size conversion are checked before
allocation, and allocation failure does not replace the old pointer. No geometric
capacity policy, export, layout, node limit, optimizer flag or compiler ABI change.

This is not a complete WASI filesystem audit: directory/prestat behavior, allocation
failure in other operations, VLA limits, fd_seek's existing clamp, trap-time partial
writes and host pointer validation need separate review. Hosts still validate guest
ranges; the candidate is not a sandbox boundary replacement.

## Reproducible build and evidence

The opt-in builder first calls the existing hash/size-pinned MemFS producer using
WASI SDK 33 and then applies the reviewed memory patch to its modernized C source.
It repeats the exact compile/link command arrays for a candidate and two separately
instrumented test binaries. Candidate exports/imports/function arities and 8192-node
capacity are checked by the existing verifier. The receipt binds base source,
compatibility patch, candidate patcher, builder, commands, revision and raw/gzip
output hashes and sizes. Baseline licenses are retained.

Instrumented variants add one test-only zero-fill counter import. They measure
explicit C-source memset byte counts, not allocator internals, total memory traffic,
wall time or browser speedup. Uninstrumented ABI validation is mandatory. Browser
correctness must execute the actual produced Wasm, not a JavaScript filesystem
model. Candidate adoption remains manual: no manifest, release receipt or consumer
pin is changed by this PR, and no workflow promotes an artifact or writes a branch.

## Remaining performance opportunities

1. Measure this filesystem change in the actual Clang/LLD consumer on large output
   objects, many small header reads and repeated link workloads. The avoided work
   is an expected mechanism until the instrumented build executes; it is not an
   established percentage improvement.
2. Compare O2/Oz/LTO profiles for the MemFS binary and compiler hot paths using the
   same pinned compiler, representative sources and cold/warm browser conditions.
   A smaller compiler can still be slower after extra decompression/compilation.
3. Evaluate combined Clang/LLD linkage to deduplicate shared LLVM components; this
   requires an actual producer patch, not just concatenated assets. PGO needs
   representative training held out from evaluation. Neither is implemented here.
4. Review compiler/clangd/LLDB profile sharing and demand loading separately. A
   consumer's Module/object/PCH cache does not make the producer binary smaller.
5. Kotlin's unfinished whole-compiler port in #29 remains a correctness prerequisite;
   this MemFS candidate does not make that compiler callable in the browser.

The interactive container was unavailable for this follow-up. Executed results
belong in the exact-head Actions receipt/report and PR, not a claimed local run.
