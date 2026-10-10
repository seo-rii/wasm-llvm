The selected Wasm stdlib exposes `assert` as an internal code-generation intrinsic.
The compiler's own common sources call its public JVM spelling, so that boundary
cannot be imported unchanged into a wasmJs compiler build.

`CompilerAssertions.kt` retains both exact official Wasm assertion bodies under
a public common host name. This compiler profile enables invariant checks.
The original JVM reference runs with `-ea`. A false condition evaluates its lazy
message once and throws `AssertionError`; a true condition never evaluates it.
Condition, message and rendering failures propagate unchanged.

The preparation verifies the pinned original stdlib Git blob, portable source
hash and both complete check/message/throw bodies. The compiler build adds the
explicit host import only to verified compiler source inputs. It does not change
the bodies or user sources, and a qualified call requires a separately reviewed
binding. These flags and imports belong to the compiler host profile.

Run the differential from wasm-llvm with the verified bootstrap and stdlib source
snapshot, following the workspace private background-log rule:

```sh
node producer/kotlin-browser/compiler-port/assertions/check.mjs
```

The checked-in receipt records 16 observations from enabled original JVM,
portable JVM and actual wasmJs execution through Node. The outputs agree,
including lazy evaluation, exception identity, Unicode messages, ordering,
object rendering and inline non-local return. This verifies a compiler host
helper. The full browser compiler is not built, and this test does not compile
user Kotlin in a browser.
