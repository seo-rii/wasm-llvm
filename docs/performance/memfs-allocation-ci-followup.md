# A real execution test found the allocation stub

The first candidate run 38024501627 compiled all four real Wasm binaries and
passed the existing uninstrumented ABI/capacity checks. Node and Chromium153 Worker
both reproduced the old one-byte read returning six bytes, while the candidate
passed that guard, vector/EOF/cursor/overflow/fd/Unicode and gap-write checks.
Explicit zero-fill counters were 65536→0 for a fresh 64KiB write and 65535→65534
for a 65534-byte gap followed by one byte. These are actual C-operation counts,
not an elapsed-time performance claim.

One real regression failed in both engines: fd_allocate(6, 2) left a six-byte file
at six bytes, not eight. Source inspection then showed the upstream implementation
was a TODO returning success. The original design's statement that allocation
already used EnsureFileSize was incorrect; only truncate expansion did.

Patch v2 implements real regular-file allocation through offset+length, rejects
ranges not representable in wasm32 before addition/conversion, returns allocation
failure without losing the previous pointer, initializes every newly visible byte,
and preserves existing data/descriptor position. Allocation does not use the
write-only zero-fill elision. The original allocate assertion is retained rather
than changed to accept the stub. The candidate has not been promoted.

The Preview1-style API describes fd_allocate as forcing space allocation for the
specified offset/length, similar to posix_fallocate:
https://www.wasix.org/docs/api-reference/wasi/fd_allocate/ .

The first binaries' size observations cannot describe the v2 binary, which adds
previously missing functionality. Use the new build receipt for the final sizes.
This remains a component probe, not a full browser Clang/LLD product run.
