# Genuine function descriptor implementations

This component translates the complete pinned `FunctionDescriptorImpl.java` and
`SimpleFunctionDescriptorImpl.java` to common Kotlin. It includes the original initialization,
virtual methods, all copy-builder operations, type substitution and its failure
paths, receivers, parameter and destructuring copies, original/source propagation,
flags, initial signatures, lazy override calculation, and user-data merge order.
The measured common non-null getter limits below remain part of this contract.
The one-entry published user-data map remains immutable through an explicit common
map adapter; writes still throw `UnsupportedOperationException`.

`FunctionDescriptorProperties.kt` supplies seven typed writable property bridges
used by genuine `FunctionInvokeDescriptor` and `MemberDeserializer` assignments.
The existing global property file is unchanged; every bridge calls the real
virtual getter/setter.

## Composition

`prepareDescriptorFunctionImplementations` takes `sourceRoot`, `outputRoot`, the
actual `retainedSources`, `preparedDescriptorBases`, `preparedCopyBuilderPlatform`,
and `preparedTypeImplementations`. Optional `recordedPropertyImports` defaults to
`[]` for preparation before global import assembly. Pass the actual nested type
implementation output root, whose `receipt.json` and `common/` are immediate
children. The returned `commonSources` contains three new files under
`compiler-port-descriptor-functions/`; `replacedOriginalPaths` names the two Java
classes, which were already absent from the common selection. No old Kotlin owner
is replaced.

The preparation binds all eleven genuine base, builder, and type outputs, their
receipt hashes and exact owners, and both complete Kotlin flag consumers. Original
consumer owners are taken from the verified selection, including cloned sources
outside the canonical cache. The source lock pins the upstream closure, full
originals, common files, and preparation dependencies.

Call `verifyDescriptorFunctionImplementations({outputRoot, expectedReceiptSha256})`
before later assembly. Call `verifyFinalDescriptorFunctionImplementations` on the
actual final roster with the same externally saved receipt hash and the recorded
property import list. It verifies exact bodies, imports and owners, then returns
`{receipt, predecessorRetainedSources}`. Only the three verified new sources are
removed from that view. Feed it to the existing base → IR getter → CopyBuilder →
platform-signature final guards, whose older lexical inventories do not include
these newly ported class declarations.

## Evidence and limits

The executable `probe.mjs` compiles the full original Java classes, the original
descriptor interfaces, the complete common classes, and generated real contracts
with the existing signature/CopyBuilder recipes. A single compiled Java observer
runs against each implementation with genuine compiler types and descriptors.
The genuine complete `FunctionInvokeDescriptor.kt` consumer is also rebuilt in
both variants. The 32 equal records cover flags, source/original relationships, parameter storage,
copy and type substitution, all three receiver kinds, destructuring lazy capture,
override lazy caching and null elements, user-data merging/immutability, failure
paths, and typed Kotlin flag assignments.

The proof still uses verified bootstrap implementations of DescriptorFactory,
DescriptorSubstitutor, receiver classes, SmartList and the remaining type system.
PropertyDescriptorImpl and DescriptorFactory are not ported by this unit. Full
common-class Wasm execution and full compiler completion remain **false**.

Three Java getters return raw null before initialization despite their `@NotNull`
contracts; the common non-null getters throw instead. The observer records each
boundary separately. `getReturnType` and builder return-type storage remain nullable: initializing
returnType=null and then supplying it through builder.setReturnType is verified. Raw Java null argument and
null builder-return parity is not claimed. In addition, the formally permitted
`initialize(modality=null)` followed by `newCopyBuilder().setModality(FINAL)` or
`copy(..., FINAL, ...)` **differs**: original Java succeeds; common throws at the
virtual non-null `getModality()` call before the replacement setter. Both failures
are measured in separate boundary rows. Preserving this workflow would require a
separate common getter-contract change; this unit neither changes that contract
nor bypasses the virtual getter. The original volatile publication order
is retained for one serial compiler Worker; cross-thread volatile semantics are
not claimed. Java protected/private inner storage is visible to the enclosing
common algorithm via fields; binary field-visibility parity is not claimed.

`prepare.test.mjs` uses the completed whole compiler invocation's selected source
inventory and argfile. It tests source/owner/import/receipt tampering and invokes
the existing public final guard chain after the exact reverse view. These checks
establish composition integrity, not successful compilation of the whole compiler.

The separate `early.test.mjs` verifies eleven canonical dependency files from
fresh genuine base/type preparations and a verified pristine CopyBuilder
predecessor, with both canonical consumers cloned outside the source cache. Other
roster rows remain historical; this is a bounded early-boundary proof, not a claim
to have captured a complete early compiler invocation.

`evidence.mjs` accepts the three completed launcher job JSON files, rehashes proof
inputs/artifacts and live source dependencies, and saves exact runtime, integrity
and early receipts plus execution/log/status pins under `evidence/`.

Run the proof scripts with a fresh absolute or repository-relative output directory
under `out/`. Keep stdout/stderr in private background logs and wait for the final
status before inspecting them. `seal.mjs` reproduces the component source lock;
it does not create runtime acceptance evidence.
