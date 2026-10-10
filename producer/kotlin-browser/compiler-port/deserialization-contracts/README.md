# Genuine deserialization contracts

This unit ports the complete original `ClassDataFinder.java` and
`ErrorReporter.java` from the pinned Kotlin compiler source. Class lookup keeps
its nonnull `ClassId` input and nullable `ClassData` result. The common fun
interface retains SAM construction. Error reporting keeps both methods and the
single `DO_NOTHING` object; that object neither reads nor changes its arguments.
The unannotated Java list element type remains nullable in the common interface;
the actual nonnull caller list remains assignable through covariance. This does
not claim arbitrary external Kotlin override source compatibility.
The public field annotation preserves genuine Java observer access on JVM.

The common declarations implement the original declared nonnull argument
contract. Raw javac bytecode lets the no-op reporter accept null arguments;
Kotlin rejects those invalid arguments. Three raw differences are retained
separately. Arbitrary Java reflection and anonymous class names are not claimed
equivalent.

Preparation verifies both originals and the complete actual `ClassData.kt` and
`ProtoBasedClassDataFinder.kt` consumer against the primary source closure. It
emits one common source and immutable reference copies. No existing generated
source is replaced and no caller algorithm changes. The composer selects the
common source once and excludes the two original Java inputs.

The JVM proof rebuilds both real consumers for each interface version and runs
one Java observer compiled against the originals. Genuine metadata protos,
name resolution, class identifiers, binary versions and builtin descriptors
exercise lookup, duplicate-key winner, callback identity/order/failure, nullable
results, SAM dispatch, nullable element calls compiled against each contract, aliased reporter lists and no-op behavior. Bootstrap
implementation source commit is unpublished and its exact artifacts are pinned.
This proves the finite complete-source JVM contract profile; it does not execute
the whole common descriptor family or compiler on Wasm.

The sealed run has 524 matching observations, six successful commands and three
separate raw null-argument differences. There is no result normalization.

Run `node probe.mjs <new-repository-out-directory>` for a fresh runtime proof and
`node verify.mjs` to recheck sealed evidence and actual artifacts. Full compiler
and public Kotlin readiness remain false.
