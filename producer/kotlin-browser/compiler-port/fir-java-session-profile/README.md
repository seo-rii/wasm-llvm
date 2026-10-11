# Wasm FIR session selection

The compiler entry calls the actual `FirWasmSessionFactory.WasmWasi`. The selected
`ComponentsContainers.kt` also contains the JVM-only Java session registration.
This profile removes that one pinned contiguous declaration block and its unused
Java/JVM imports. Every byte of the common, CLI and resolve registrations remains
unchanged. The Wasm and abstract session factories are preserved in full.

Preparation checks all original Kotlin/Java files against the primary closure.
Only the already excluded JVM factory may reference the two removed declarations.
It also checks the actual selected graph, including the browser entry. The final
public guard repeats the reference check over the compiler's final source list,
requires the exact output owner, and compares the preserved factory bytes after
removing only recorded import blocks. Its preparation receipt must match the
externally bound digest; updating source metadata cannot bypass body checks.

`probe.mjs PRIOR_WHOLE_BUILD OUTPUT_ROOT` verifies the genuine failed build's
argument file and every selected source, rebinds only the original session source
for preparation, and checks the final replacement with the actual recorded import
prefix. Negative tests use that full selected inventory and restore all mutations.
The evidence describes this source-selection proof. It does not claim a resolved
FIR call graph, executed complete FIR session, successful compiler build, or public
Kotlin support. Those require the separate whole build and fresh browser execution.
