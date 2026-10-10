# Genuine null constant type

The final upstream `NullValue` class passes the literal `null` to its covariant
`ConstantValue` superclass. This unit changes only that declaration's
`Void?` type argument to common Kotlin `Nothing?`. Every original constant
class, constructor and method body remains byte-for-byte unchanged.

The complete constant source and the original Java annotation visitor are
pinned to the primary Kotlin source closure. Preparation verifies both inputs,
the one exact declaration replacement and the complete resulting source.
Verification independently replays the immutable originals and full receipt.
No Java `Void` facade or replacement compiler receiver is introduced.

The bounded JVM observer compiles each complete original/common constant file
against the verified compiler bootstrap and executes genuine `NullValue`,
`IntValue`, builtins and module objects. A JVM proxy implements the genuine
visitor interface solely to observe receiver/data identity and dispatch count.
It compares values, widening, boxing, equality (including upstream's surprising
equality with null/non-constant objects), hashing, map lookup, type identity and
visitor results. Bootstrap source identity remains unknown; these are component
observations, not compiler acceptance.

The adaptation does not preserve the JVM reflective generic signature or allow
unsafe reflective mutation of the inherited value. Full constant-family Wasm
execution and browser compiler readiness remain unverified.

```sh
node --test producer/kotlin-browser/compiler-port/null-constant-value-profile/integrity.test.mjs
node producer/kotlin-browser/compiler-port/null-constant-value-profile/probe.mjs out/kotlin-null-constant-proof-unique
```
