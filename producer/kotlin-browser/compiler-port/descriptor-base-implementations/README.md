# Genuine descriptor base implementations

This unit supplies all methods of the pinned Java `DeclarationDescriptorImpl`,
`DeclarationDescriptorNonRootImpl` and `VariableDescriptorImpl` as common Kotlin.
The original annotation superclass, descriptor interfaces, renderer and type
algorithms remain real dependencies. Stored object references, open getters,
virtual return-type lookup, superclass original casts, source/owner forwarding,
validation forwarding, empty collections and enabled invariant checks are retained.
The protected `outType` field uses the existing common-source JVM annotation mode.

The original diagnostic `toString` still invokes `DescriptorRenderer.DEBUG_TEXT`.
Its required `DescriptorDebugHost` reports the actual runtime class simple name and
reference-identity hash, in the original evaluation order. The unsigned hexadecimal
conversion retains negative 32-bit identity values. Renderer or host failure enters
the original fallback; failure of that fallback still escapes. There is no default
reporter, descriptor `equals`/`hashCode` substitution or identity cache.
`withDescriptorDebugHost(host, block)` restores the previous host on normal and
exceptional return, including nested calls. This is a synchronous, serial Worker
contract, not a thread-local implementation.

The full existing visitor-owned `ValueParameterDescriptorImpl` needs two explicit
virtual getter calls when its Java superclass becomes Kotlin: `original.getOriginal()`
and `getContainingDeclaration()`. Both reverse exactly to the incoming source;
all other bytes, including the existing nullable visitor check, remain unchanged.

`prepareDescriptorBaseImplementations({sourceRoot, outputRoot,
descriptorVisitorComponent, retainedSources})` checks primary source pins, the
complete local class files and the actual selected visitor owner. It reconstructs
that owner's complete value-parameter source using the pinned original and existing
visitor recipe. Three outputs replace three excluded Java sources and one earlier
Kotlin owner through an explicit predecessor binding. The binding seals the prior
receipt, source lock, canonical filename and bytes; it does not independently replay
unrelated visitor outputs. The existing composer performs that earlier verification.

`verifyDescriptorBaseImplementations(outputRoot)` replays preparation evidence.
`verifyFinalDescriptorBaseImplementations({outputRoot, retainedSources,
recordedPropertyImports})` requires all three actual output owners and exact bytes
after the permitted prefix import blocks. It restores the pristine unselected
visitor output and removes the two new common files in `predecessorRetainedSources`,
which then passes through the unchanged IR, CopyBuilder and signature verifiers.
No existing generated interface or nullable getter alias is edited.

The JVM proof compiles 27 complete original Java interfaces, all three Java bases,
the full original Kotlin value-parameter source, 29 complete common contracts,
all three common bases, the annotation carrier implementation and the full common
value-parameter source. The existing six platform-signature recipes are applied to
their real generated interfaces. A Kotlin observer subclass exercises real getter
dispatch; the Java observer drives genuine builtin, error, function and parameter
objects. The verified bootstrap supplies remaining genuine dependencies; its source
commit is unpublished. Thirty-eight behavior records match exactly, including the
original-chain and overridden-parameter getter calls. Numeric identity suffixes are
validated against the actual object's `System.identityHashCode` within each run;
process-local numbers are not compared between runs. Five additional common records
exercise nested host restoration and host failure order.

Java's declared nonnull contracts and the existing null-only Void profile apply.
Reading a deliberately uninitialized variable type returns null in raw javac output
and throws in the common nonnull getter; both observations are retained. The genuine
Kotlin value-parameter constructor rejects its null type identically in both runs.
Raw Java base null-construction parity, reflection layout parity, disabled assertions,
nonnull Void values and diagnostic stack-frame parity are not claimed.

Ten preparation/final integrity tests pass. The late-chain proof reads all 3,525
actual inputs of the completed compiler attempt, binds the value-parameter input to
this unit's genuine canonical visitor fixture, inserts the actual three outputs and
recorded import blocks, and invokes the public base → IR → CopyBuilder → signature
verifiers. It rechecks every historical file after execution. This proves source
selection compatibility, not a new full compiler build.

Run `node probe.mjs <unused-out-directory>`,
`DESCRIPTOR_BASE_GUARDS=<unused-out-directory> node --test prepare.test.mjs`, and
`node chain.mjs <unused-out-directory>`. `DESCRIPTOR_BASE_VISITOR` optionally points
the two fixtures at another genuine unchanged visitor preparation. `verify.mjs`
checks the sealed commands, artifacts and evidence without recompilation.
The full descriptor classes have not executed on Wasm. The browser compiler and
public Kotlin readiness remain false.
