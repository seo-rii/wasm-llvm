# Trace-driven sysroot delivery profiles

This opt-in post-build packager does not change the compiler, producer lock, existing output
receipt, or wasm-idle's currently pinned sysroot. Its input is the selected target's materialized
`rust/lib/rustlib/TARGET/lib` directory, not the compiler host's library directory.

```
node producer/rust-browser/scripts/package-sysroot-profiles.mjs \
  --inventory /verified/rust/lib/rustlib/wasm32-wasip1/lib --target wasm32-wasip1

node producer/rust-browser/scripts/package-sysroot-profiles.mjs \
  --sysroot /verified/rust/lib/rustlib/wasm32-wasip1/lib --target wasm32-wasip1 \
  --compiler-manifest producer/rust-browser/manifest.json --trace /probes/access.json \
  --output /build/new-sysroot-profiles
```

## Required trace contract

Capture successful file-open/read accesses using the matching real compiler's filesystem host.
Remove the `/lib/rustlib/TARGET/lib/` prefix and retain only existing file paths. Record one entry
per source/case, not a hand-written guessed list of rlibs. The JSON has:

- `format`: `wasm-rust-sysroot-trace-v1`
- `target`, exact `compilerManifestSha256`, and `inventorySha256` from the inventory command
- `scenarios`: objects with unique `name`, `exitCode: 0`, `sourceSha256`, and `files`

Cover empty main, formatting, stdin, args/environment, Vec/String/HashMap, filesystem, time,
panic-abort, generics and supported debug/edition modes. A successful trace is evidence for its
cases only, not a proof that every Rust program needs the same files. The trace producer and source
manifest must be trusted; matching hashes do not authenticate an untrusted hand-written trace.

The packager rejects failed/empty scenarios, unknown/traversing paths, stale manifests/inventories,
links/devices, and input beyond 10,000 files or 128 MiB. It generates deterministic gzip packs and
indexes in the existing identity-pack format. `hot` plus `extra` preserves every input file exactly
once; `full` is independently runnable with respect to sysroot availability. All compressed/logical
bytes, file inventories and coverage source hashes are recorded.

## Cold direct versus warm delta

Every selected target retains a direct full pack. P2/P3 can therefore be published without requiring
P1 base bytes on a cold load. `selectSysrootDelivery` compares compressed direct bytes to delta plus
any absent base; it treats a base as present only when its exact verified hash is supplied. This is
a transfer estimate, not the consumer's decoded-byte, memory or CPU budget. Existing delta packs
are not rewritten by this command.

## Promotion / deployment gate

Every result deliberately says `promotion: requires-real-compiler-probe`. This PR includes packaging
and selection logic, not a fabricated production access corpus or a deployed minimal sysroot.
Before publishing, run the real corpus again against hot only, test extra/full fallback on new
programs, and verify output equivalence. Preserve the full profile and fail clearly rather than
retrying unrelated syntax/type errors. Then publish/pin the profile manifest, update the consumer
schema and verified asset receipts, and select it in a separate wasm-idle PR. That consumer work is
intentionally deferred until the producer output is released.

```
node --test test/rust-sysroot-profiles.test.mjs
```

The tests use actual gzip with small synthetic sysroot bytes, not a rebuilt rustc or a browser
latency benchmark. No production cold-start byte reduction is claimed yet.
