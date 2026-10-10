# Actual Kotlin allocator and Preview 1 poll canaries

This probe uses the complete selected-source, patched `wasmWasi` target stdlib
recorded by `../../evidence/stdlib-source-build.json`. The official bootstrap
compiles the observer; its source commit is unknown. The browser compiler is
not involved. Run from the repository root with Node 24 and Chromium prepared:

```sh
node producer/kotlin-browser/stdlib-probe/allocator-canary/check.mjs out/my-new-allocator-proof
node producer/kotlin-browser/stdlib-probe/allocator-canary/verify.mjs
```

The first command requires a new output directory. The second verifies the
checked-in receipt against its retained output, raw observations, source and
tool pins, and completed process logs. It does not replace the recorded run.

`AllocatorCanary.kt` calls the genuine scoped allocator for 77 sizes, including
1–65 and boundaries through 65,537 bytes. Each allocation is followed by a
64-byte canary which Kotlin checks after the host callback. Four additional
cases measure the original and patched poll buffer requests. A 20-byte request
has 24 bytes before the next allocation; reading a 48-byte subscription span
therefore includes 24 bytes of the next canary. This case only reads memory.
The 48-byte request has no overlap. Both 26-byte and 32-byte event requests have
32 bytes before the next allocation; a full 32-byte event write leaves the
canary intact. These observations use the patched library's unchanged allocator.
They do not execute the unpatched stdlib or claim observed corruption in it.

The same program then calls the actual patched stdlib `print`. The controlled
host returns `AGAIN` on its first `fd_write`, forcing the genuine stdlib poll
path. It checks the full 48-byte subscription, writes a full 32-byte event and
the event count, verifies alignment and nonoverlap of all three allocations,
and checks that subscription bytes remain unchanged. Subsequent three-byte
partial writes preserve the UTF-8 output `poll-canary-λ\n`.

All 81 allocation observations and the real poll/output sequence match exactly
between Node and two fresh Chromium module Workers, with no normalization.
Both Workers start Wasm compilation and execution after the browser goes
offline; no execution requests occur. The module imports `random_get` but this
execution does not call it. Its host provider uses actual cryptographic random
bytes if called. The initial rejected import and its exact input snapshot are
retained separately from the passing run.

This establishes the measured allocator extents and patched poll path only.
Complete WASI behavior, browser Kotlin source compilation, selected-pin compiler
R0/R1, cancellation, resource limits and public language readiness remain
separate acceptance requirements.
