# JVM utility source profile

The real 3,524-source failed compiler invocation still included five utilities
whose twelve top-level declarations and two generated JVM facade names have no
incoming reference in its exact 3,532-source pre-disk selection:

- `KotlinNativePaths.kt`: Kotlin/Native installation discovery.
- `MapPsiToAsmDesc.kt`: IntelliJ PSI to JVM ASM descriptor conversion.
- `MemoryLeakDetector.kt`: kapt class-loader reflection and leak tracking.
- `LibraryUtils.kt`: JavaScript standard-library JAR/manifest discovery.
- `reflectionUtils.kt`: Java reflection `Constructor` parameter-type extensions.

This component excludes exactly those five complete files. It preserves their
full upstream bytes, including private helpers, and audits every Kotlin/Java
source in the pinned original closure. The original container `Cache.kt` does
use the reflection extension; that JVM dependency-injection source was already
excluded by the verified K1 container profile and is absent from this actual
selection. The generic `Constructor<*>` receiver
headers are projected solely for declaration inventory extraction; source
algorithms are never rewritten. No JVM utility implementation or browser
replacement is claimed.

`PathUtil.kt` and `KotlinPaths.kt` remain selected because the actual selected
`KotlinPathsFromHomeDir.kt` still uses that disk-path cluster. They are required
boundaries alongside the actual FIR builder, FIR-to-IR converter, Wasm lowering
phases, builtins loader and partial-linkage error rendering. The latter uses a
different `com.intellij.util.PathUtil`; it also remains intact.

`prepareJvmUtilitySourceProfile({ sourceRoot, outputRoot, retainedSources })`
runs after final assembly and before the disk/service profiles. It returns
`sourceSetExclusions`, an empty `commonSources`, the immutable receipt and its
external SHA-256. Every actual selected path, physical filename, size, digest
and ordering is recorded. The conservative scanner includes comments, aliases,
qualified and backtick names, Java facade names, Unicode escapes and split
literal spellings, including private declarations. Arbitrary runtime string
computation and compiler IR reachability are outside this proof.

`verifyJvmUtilityFinalSources({ outputRoot, retainedSources,
expectedReceiptSha256, klibDiskProfile? })` requires the original external
receipt digest, intact complete original snapshots, no excluded source or new
incoming reference, and unchanged required boundaries. Without downstream
composition, every other source must have identical owner, bytes and order.
With `klibDiskProfile: { outputRoot, expectedReceiptSha256,
serviceLoaderProfile? }`, the real disk final verifier first checks its complete
disk/service composition. Its immutable predecessor inventory must equal this
component's exact five-exclusion output; unverified later deletions or host
rewrites are refused.

`probe.mjs` binds the actual failed build receipt and compiler argument file,
rechecks all actual input hashes, recovers only the disk/service transformations
already recorded in that receipt, then executes the real utility, disk and
service preparation and final guards. The expected sequence is
3,532 → 3,527 → 3,520 → 3,519 sources. This proves source selection and integrity;
it is not a successful whole compiler build, runtime equivalence claim, or
language readiness claim.

Run the probe with `--source-root`, `--output` and `--frozen-build-root`.
Run `node --test prepare.test.mjs` with `KOTLIN_JVM_UTILITY_SOURCE_ROOT` pointing
to the genuine upstream source root and `KOTLIN_JVM_UTILITY_FIXTURE` pointing
to the probe's completed `fixture.json` for the actual graph mutation guards.
Completed run status, inputs and artifacts are bound in `evidence/`.
