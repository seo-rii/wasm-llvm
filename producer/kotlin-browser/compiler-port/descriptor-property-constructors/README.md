This component ports the complete pinned Java property descriptor family: `VariableDescriptorWithInitializerImpl`, `PropertyAccessorDescriptorImpl`, `PropertyGetterDescriptorImpl`, `PropertySetterDescriptorImpl`, `PropertyDescriptorImpl`, and `ClassConstructorDescriptorImpl`. It preserves accessor flags and delegation, all property copy-builder methods, virtual substituted-copy dispatch, type parameters and receivers, projected-out substitutions, setter fallback to `Nothing`, overrides, fields, initial signatures, constant initializer factories and cache resets, and constructor initialization and copy restrictions.

Prepare after descriptor bases, functions, receivers and descriptor substitution, before the type-substitutor getter bridge:

```js
prepareDescriptorPropertyConstructors({ sourceRoot, outputRoot, retainedSources,
  preparedDescriptorBases, preparedFunctions, preparedReceivers,
  preparedDescriptorSubstitutor, preparedDescriptorContracts, preparedCopyBuilders,
  recordedPropertyImports: [] })
verifyDescriptorPropertyConstructors({ outputRoot, expectedReceiptSha256 })
verifyFinalDescriptorPropertyConstructors({ outputRoot, expectedReceiptSha256,
  retainedSources, recordedPropertyImports })
```

The preparation binds 17 canonical artifacts from six genuine predecessor receipts and the complete original Kotlin `FieldDescriptorImpl` consumer, including actual source owners and bodies. It returns eight source files: six additions and two replacements at the existing `VariableDescriptor.kt` and `PropertyDescriptor.kt` logical paths. The two replacements change only the return of the original unannotated `substitute` methods to nullable. Java property projection can return null, and that algorithm remains intact. Both complete canonical contracts are pinned and reversibly compared with their complete nullable outputs. `contractPredecessorRows` lets the build audit each layered replacement against its existing component owner.

Final verification requires the externally captured receipt SHA, complete source bodies with only recorded assembly imports, exact output and predecessor owners, and the absence of all six Java originals. Only after these checks does it remove the six additions and restore the two verified contract predecessor rows, preserving the order and all other selected files. Older descriptor guards then receive their original source view. No Kotlin source is excluded.

The completed JVM differential freshly compiles all six original Java classes and all six common classes. It also rebuilds genuine existing descriptor bases, functions, receiver implementations and `DescriptorFactory`, descriptor substitution and type parameters, `TypeSubstitutor`, the full value-parameter and context-receiver consumers, and all 30 generated contracts. Seven commands pass and produce 63 identical raw records. These exercise every property builder setter, genuine Java builder subclass virtual dispatch, all substitution variances, null projection and setter fallback, field and override copying, visitors, delayed getter and setter initialization, initializer factory calls and shared cache/reset behavior, initialized constructor copying, and assertion/error paths. The type system, builtins, storage, class descriptors, scopes and constants still use the hash-verified bootstrap compiler, whose source commit is unknown.

`ConstructorDescriptor.getReturnType()` remains the original annotated non-null contract. Constructor initialization still stores a null return type until `setReturnType`; an explicit covariant common getter follows that declared contract. Raw Java reads before return initialization yield null and permit a copy builder, while common reads and the corresponding premature copy builder throw `NullPointerException`. The proof records this unsupported boundary separately; legal constructor copying after `setReturnType` matches. Raw Java null arguments, arbitrary Java collection mutation, reflection/binary layout, full common-class Wasm execution, a complete compiler build, and browser language readiness remain unclaimed.

The actual historical 3,533-source compiler invocation supplies the integrity roster. Positive composition has 3,539 sources; negative guards reject missing/replaced/forged owners, changed bodies and snapshots, unrecorded imports, receipt tampering, original Java reinsertion, output reuse and overlapping roots. An additional early check verifies the 17 canonical predecessor artifacts and one pristine consumer without assembly imports. The other files remain historical final selections, so this boundary check does not claim an actual whole early invocation. Completed proof receipts and private execution provenance are sealed under `evidence/`.

Run focused proofs from the repository root with new output directories and persistent private background logs:

```sh
node producer/kotlin-browser/compiler-port/descriptor-property-constructors/probe.mjs out/NEW-jvm-proof
node producer/kotlin-browser/compiler-port/descriptor-property-constructors/integrity.mjs out/NEW-guards
node producer/kotlin-browser/compiler-port/descriptor-property-constructors/early.mjs out/NEW-early
```
