# FIR resolution control state on a serialized Worker

This host patch replaces only the two `ThreadLocal<Boolean>` holders in the
official `FirLazyDeclarationResolver` with object-local `SerialResolveState`.
All contract checks, permission failures, scope bodies and `finally` restoration
remain byte-identical after reversing those holder/import substitutions. The
locked source revision is `4d78aae1e337cd40f69baa865aed950fe807a775`.

Each compiler Worker runs one thread and accepts one compiler operation at a
time. The adapter preserves lazy initialization, explicit values (including a
nullable generic value), removal/reinitialization, and retry after a throwing
initializer. It does not expose a multi-thread implementation. Each resolver
owns its two holders; it cannot share or reset another resolver's state.

`prepareSerialResolveSources({ sourceRoot, outputRoot })` verifies the original
Git blob/SHA-256, reviewed patch and adapter hashes, applies/reverses the patch,
checks exact unchanged control flow, and returns the real patched FIR file and
common state holder. Root composition retains the actual resolution services.

Run the component comparison using the workspace private background-log
procedure:

```sh
node producer/kotlin-browser/compiler-port/serial-resolve/check.mjs
```

The observer lifts the exact scope/control bodies and original permission-error
class from the pinned source; it omits only the two abstract phase signatures.
It does not fabricate FIR declarations, sessions or compilation results. The
original JVM holder, common JVM holder and actual wasmJs execution on Node agree
on all 38 observations: nested scopes, combined flags, throwing callbacks,
non-local returns, permanently disabled checks, fresh resolvers, initializer
retry, and nullable/remove behavior. Actual source/observer/tool hashes and
commands are in [the receipt](evidence/state-differential.json). The process
exited 0; its restricted log is
`/home/seorii/logs/kotlin-serial-resolve-hp8s2gdl.log`.

Full FIR resolution and browser compilation are unrun by this component.
Node Wasm execution does not establish browser acceptance. Public Kotlin
readiness remains false.
