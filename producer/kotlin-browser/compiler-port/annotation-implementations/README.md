# Genuine annotation implementation carriers

This unit ports complete `AnnotatedImpl.java` and `AnnotationDescriptorImpl.java`
from Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`. Both retain their
open class and virtual getter contracts. The annotations, argument map, type and
source retain their original references. `fqName` delegates to the actual
`AnnotationDescriptor` default implementation, including virtual `type` lookup;
`toString` calls the actual `DescriptorRenderer.FQ_NAMES_IN_TYPES` renderer.
There are no substitute descriptor, type or renderer implementations.

The common constructors implement the original declared `@NotNull` input
contract. Raw javac output accepts Java null constructor arguments, whereas the
common Kotlin constructors reject them. The proof records all four differences
as out-of-contract observations. It does not claim raw Java null-construction,
reflective field layout, or compiler-host exception-stack parity.

`prepareAnnotationImplementations({sourceRoot, outputRoot})` verifies both Java
originals and the complete genuine `AnnotationDescriptor.kt` and `Annotations.kt`
interfaces and their genuine `AnnotationsImpl.kt` factory dependency against the primary closure. It emits one common source and immutable
reference copies. `verifyAnnotationImplementations(outputRoot)` independently
replays the references, local tools, common source and full preparation receipt.
The composer must select the emitted source once and exclude the two Java inputs.
No previously generated source is superseded and no caller body is changed.

`probe.mjs` rebuilds both complete Kotlin interfaces and the factory implementation, the original Java carriers
and the common Kotlin carriers. A single Java observer runs against each set of
classes before the verified bootstrap on the classpath. Real builtin/error types,
constant values, annotations, default interface methods and renderer are used.
Bootstrap implementation source commit is unpublished; its exact artifact pins
are retained. Stateful maps test aliasing and removal; Java subclasses test open
getter dispatch and renderer/default-interface call order. All valid observations
are compared without normalization. The four raw invalid-null outcomes remain
separate. This is full-carrier JVM evidence, not full descriptor-family or Wasm
execution. The whole compiler and public language readiness remain false.

The sealed proof has 1,052 identical full-carrier JVM observations, six successful
commands and four integrity tests. The initial missing factory source failure is
retained; the final observer rebuilds its complete genuine implementation.
Run `node producer/kotlin-browser/compiler-port/annotation-implementations/verify.mjs`
to recheck the evidence, actual artifacts, bootstrap and raw records.
