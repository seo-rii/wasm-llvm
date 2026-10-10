# Actual selected-target Kotlin console corpus

This corpus compiles one real Kotlin program with the verified official
bootstrap and complete source-built, patched `wasmWasi` stdlib. It executes the
same binary through the existing wasm-idle `wasi.ts` and `program.ts` runner in
Node, then through the actual `program.worker.ts` in 24 fresh offline Chromium
module Workers. Consumer source files are copied and transpiled with TypeScript;
their original and generated hashes are recorded. No consumer implementation is
replaced or modified. Browser blob module imports point to those exact outputs.

From the wasm-llvm repository root, with its verified bootstrap/target library
and the sibling wasm-idle TypeScript dependencies available:

```sh
node producer/kotlin-browser/stdlib-probe/console-runtime/check.mjs out/my-new-console-proof
node producer/kotlin-browser/stdlib-probe/console-runtime/verify.mjs
```

The output directory must be new. Verification binds the sealed receipt, actual
source/KLIB/Wasm bytes, command exits, raw observations and completed execution
logs. All 24 raw consumer results agree between Node and Chromium, including
the error strings reported by the consumer. No normalization is used.

The cases cover repeated EOF and the real `readln` EOF exception, blank lines,
CRLF, embedded CR/NUL, a final line without a newline, 32-byte internal buffer
boundaries and a 4,096-character line, malformed UTF-8 replacement, multibyte
Unicode and lone surrogate output, genuine `Throwable.printStackTrace` on
stderr with cause/suppressed exceptions, caught and uncaught Kotlin exceptions,
exact output budgets, fresh global state, and successful execution after errors.
The selected stdlib also removes a trailing CR at EOF; the corpus preserves
this behavior. Its WASI Throwable exposes an empty native stack, so this result
does not establish stack-frame capture. The consumer retains a raw Wasm exception
description for an uncaught Kotlin exception, rather than decoding its payload.

Each browser execution has an external deadline beginning before Worker
compilation/instantiation and records main-thread heartbeats. These are bounded
observations, not a performance or memory-cap acceptance claim. Cancellation is
not exercised by this corpus; the compiled fixture's loop mode is unused here.
Streaming stdin is unsupported by the existing prebuffered console.

The official bootstrap compiler's source commit remains unknown. It compiles
these programs on the development machine. Browser Kotlin source compilation,
selected-pin R0/R1, full WASI acceptance and public language readiness remain
unproven.
