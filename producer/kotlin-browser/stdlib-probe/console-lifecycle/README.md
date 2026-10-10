# Actual Kotlin Worker termination and recovery

This probe reuses the hash-verified real Kotlin program and selected patched
stdlib from `../console-runtime/evidence/receipt.json`. The original official
bootstrap compilation, source, target library and consumer TypeScript/generated
JavaScript artifacts are verified before execution. It does not compile Kotlin
in the browser.

Six fresh Workers execute offline in Chromium. An actual Kotlin `println` followed
by `while (true) {}` is stopped by an external AbortController after its first
successful stdout write, and separately by a 1,500 ms external deadline. Both
deadlines begin before Worker creation and compilation. For these two cases,
an explicit observer wraps `WebAssembly.instantiate`, delegates the actual
consumer `fd_write` unchanged, and posts the accepted bytes/result. This proves
the real program reached stdout before termination; the observer is test-only.
A third deadline case runs the consumer Worker without this observer. Its
deadline covers compilation and instantiation too; entry into the Kotlin loop
is not directly observed in that case. The evidence counts three stopped
requests and two observed loop-fixture stdout writes.

Each stop is followed by a fresh unmodified consumer Worker executing the real
Kotlin global-state fixture. All three must return exactly `state:1\n`, with no
stderr, eight output bytes and successful completion. Raw messages, timing and
main-thread heartbeat counts are retained. Heartbeats establish continued event
processing during these runs, not a general performance guarantee.

The controller belongs to this test. The consumer still exposes an internal
one-shot Worker; this does not claim an integrated production cancellation API,
partial stdout delivery after termination, memory limits, full WASI acceptance,
compiler R0/R1, browser Kotlin compilation, or public language readiness.

Run with the pinned Node 24 executable:

```sh
node producer/kotlin-browser/stdlib-probe/console-lifecycle/check.mjs out/unique-lifecycle-run
node producer/kotlin-browser/stdlib-probe/console-lifecycle/verify.mjs
```

`check.mjs` writes raw observations before assertions. The committed evidence
seals the successful output receipt, unit files, execution log and exit status.
