# Unreachable JVM service-loader source profile

This unit excludes exactly the selected original `ServiceLoaderLite.kt` after
all source assembly. Its original 5,134 bytes are preserved and verified. No
service-loading implementation, parser, FIR conversion, lowering, or provider
registry is replaced. The complete compiler remains unbuilt.

The preparation checks all 3,838 Kotlin/Java source pins in the primary closure,
including 3,417 compiler-selected Kotlin sources, 66 unselected Kotlin sources,
and 355 original Java sources. Neither `ServiceLoaderLite` nor its nested
`ServiceLoadingException` has an external reference in that inventory. The
other original `java.util.ServiceLoader` uses in `BuiltInsLoader`,
`DescriptorVisibilities`, and `OverridingUtil` are separate implementations and
remain untouched. Their original sources are included in the audit.

The actual assembled source list is checked independently. References include
qualified names, aliases, wildcard/static imports, backticks, comments, string
literals, interpolation, Unicode escapes, and conservative joined names.
Dynamic service/loader tokens are recorded for review. This is a conservative
source audit; arbitrary computed runtime names and a resolved IR call graph
are outside its claim.

Preparation requires exactly one target whose bytes are the primary original
plus only the already sealed compiler import prefixes. The final guard requires
the exact preceding logical paths, physical owners, ordering and bytes with
only that target removed. A new consumer, replacement copy, source mutation,
changed receipt or original, or missing parser/FIR2IR/Wasm lowering/builtins
boundary fails explicitly. No source rewrites are permitted between the two
guards. This strict placement avoids accepting arbitrary assembly drift.

Root composition calls `prepareServiceLoaderProfile` after all source mutations,
removes its single `sourceSetExclusions` entry, runs the other component final
guards, then calls `verifyServiceLoaderFinalSources` with the returned immutable
`receiptSha256` as `expectedReceiptSha256`.

`probe.mjs BUILD NEW_OUTPUT` binds the genuine compiler receipt and argument file,
checks their actual source bytes, prepares this profile, and exercises eight
public rejection cases plus ten focused spelling cases. It runs no compiler
and makes no claim that removing one unused JVM utility completes the port.
Use a private background log and status file under the workspace long-job rules.
