This unit replaces the complete pinned `DescriptorSubstitutor.java`, `AbstractTypeParameterDescriptor.java`, and `TypeParameterDescriptorImpl.java` with common Kotlin. It retains the two-pass descriptor mapping, lazy type constructors and member scopes, upper-bound initialization guards, duplicate-bound behavior, recursive-bound approximation choice, cycle reporting, classifier equivalence, nullable substitution failure, partial results, and reference-sensitive change flag. `TypeParameterProperties.kt` supplies the real `isInitialized()` getter property used by `SpecialTypes.kt`.

Prepare after genuine descriptor bases, type implementations, and function implementations:

```js
prepareDescriptorSubstitutor({ sourceRoot, outputRoot, retainedSources,
  preparedDescriptorBases, preparedTypeImplementations, preparedFunctions,
  recordedPropertyImports: [] })
verifyDescriptorSubstitutor({ outputRoot, expectedReceiptSha256 })
verifyFinalDescriptorSubstitutor({ outputRoot, expectedReceiptSha256,
  retainedSources, recordedPropertyImports })
```

The public preparation checks seven canonical artifacts from three real predecessor receipts and four genuine Kotlin consumers, including their actual selected owners and bodies. The lock verifies source closure identity, original snapshots, complete common files, and preparation dependencies. Final verification requires the externally captured receipt SHA, exact owners, the full bodies with only recorded assembly imports, and the absence of all three Java originals. It removes only this unit's four verified additions from the predecessor view passed to older source-selection guards. No Kotlin source is excluded.

The completed JVM differential compiles all three original Java classes and all three common classes independently. The common build also freshly compiles the full existing `TypeSubstitutor` family, descriptor base and annotation implementations, and all 30 generated descriptor contracts. The same compiled observer produces 19 identical raw records. These include cached lazy initialization failure, repeated initialized-mutation errors, two-pass reindexing and remapping, approximation call counts, null substitution and retained partial state, the non-null overload's assertion, cycle callbacks, error-bound filtering, and duplicate-input map overwrite behavior. All five actual commands exit successfully. Type-system, builtins, storage, scope, and type-utility dependencies come from the hash-verified bootstrap compiler, whose source commit is unknown.

Eleven negative guards and restored positive checks pass on the actual historical 3,522-source compiler selection plus four additions. An additional early-boundary check verifies canonical predecessor bodies and cloned canonical consumers with no assembly imports. Its eleven relevant boundaries model production preparation; the rest of its roster remains historical, so it does not claim an actual whole early invocation.

Java platform nulls, arbitrary external mutations through Java collection APIs, non-null Java `Void` callback results, class reflection shape, cross-thread lazy publication, full common-class Wasm execution, a complete compiler build, and browser language readiness remain unclaimed. Java `Function1<KotlinType, Void>` becomes `((KotlinType) -> Nothing?)?`; callback invocation and null return are retained. Source-level subclasses cannot reach the original private constructors of the two concrete classes. Complete original references and machine-readable proof receipts remain available in the prepared output and `evidence/`.

Run the focused proofs from the repository root using new output directories:

```sh
node producer/kotlin-browser/compiler-port/descriptor-substitutor/probe.mjs out/NEW-jvm-proof
node producer/kotlin-browser/compiler-port/descriptor-substitutor/integrity.mjs out/NEW-guards
node producer/kotlin-browser/compiler-port/descriptor-substitutor/early.mjs out/NEW-early
```

Use persistent background execution with private logs and exit-status records according to the workspace rules.
