# Genuine lazy and mutable descriptor implementations

This component preserves the complete pinned Java bodies of
`AbstractLazyTypeParameterDescriptor` and `MutableClassDescriptor`. The former
forwards its constructor and prints its name without forcing upper-bound or
default-type lazies. The latter preserves initialization, defensive parameter
copying, supertype filtering and carrier aliasing, class flags, member scopes,
virtual setters and constructor-return initialization. Assertions remain enabled.
Java-visible non-final methods remain overridable.

The complete original `suspendFunctionTypes.kt` gets two explicit imports for
narrowly typed writable `modality` and `visibility` properties. Both accessors
forward to the genuine virtual methods. Preparation keeps the unchanged complete
`DeserializedTypeParameterDescriptor.kt` as the other direct consumer. No global
property alias is added. The exact import recipe reverses to the pinned original.

Four outputs add three sources and replace one Kotlin owner. Preparation binds
the complete genuine class-family outputs and the reached type-parameter,
property/constructor and TypeUtils outputs to their immutable receipts, bodies
and selected owners. Final verification removes only the three additions and
restores the recorded suspend-function predecessor before the older descriptor
final guards. Historical builds and evidence remain immutable.

The focused JVM proof compiles all five original Java lazy/mutable/type-parameter
implementation bodies, both complete genuine Kotlin consumers, and the complete
common lazy/mutable sources. It reuses the prior successful complete common
class-family artifact only after independently rehashing every recorded parent
input and artifact. Those parents are not claimed rebuilt by this proof. The
genuine DefaultBuiltIns loader instantiates the rebuilt deserialized type
parameter consumer, and the genuine suspend-function consumer initializes the
real continuation class. Observer subclasses outside compiler packages check
virtual dispatch, lazy evaluation, defensive copies, live supertype carriers and
constructor-return initialization. The real descriptor debug host is installed
before builtins initialization and restored by its request-scoped boundary.

The JVM consumers need only the reached genuine descriptor getter aliases; the
separate integrity proof checks the complete recorded shipping import assembly.
Neither proof projects production source bodies. The source commit of genuine
bootstrap dependencies remains unknown. Deserialization context/metadata,
builtins, storage, OverridingUtil, DescriptorUtils and checker/refiner closure are
outside this component's common execution claim. Raw Java null values before
annotated non-null initialization, Java collection mutation, host-specific class
diagnostic rendering and cross-runtime identity hashes are disclosed separately.
Full common Wasm execution, a complete compiler build and offline browser
readiness remain unproved by this component.
