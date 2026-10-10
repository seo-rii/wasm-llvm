# Selected descriptor platform signatures

The official Java descriptor interfaces leave `getUserData` keys and the four
reference arguments of five-argument `copy` as platform references. The initial
common generation made them nonnull, while genuine selected Kotlin overrides
include nullable implementations. Java collection mutability also admits
overrides that use either Kotlin read-only or mutable parameter declarations.

This unit replaces six generated contracts and five genuine Kotlin files at
their existing logical paths. Nineteen exact, reversible, source-pinned spans
encode nullable keys and copy arguments, preserve all original nullable bodies,
and retain thirteen ordered source-owner NPE checks for originally nonnull
concrete methods. Two Kotlin interface copy headers follow the nullable base.
Six unused IR collection parameters become read-only without changing their
empty-scope or unsupported-operation bodies. The builtin null-returning generic
implementation admits the original unannotated Java type parameter boundary.

CopyBuilder bounds, own getter aliases and the missing concrete Java descriptor
implementation family remain unchanged. Reflective generic metadata and
arbitrary external aliases are outside this selected compiler contract.

`prepareDescriptorPlatformSignatures({ sourceRoot, outputRoot,
preparedDescriptors, descriptorVisitorComponent, visitorVoidComponent,
retainedSources })` runs immediately after the Void visitor component and before
global imports. It reexecutes all three complete predecessor preparers in private
temporary roots using immutable source bytes, then strictly compares their
receipts and every current canonical output. Only known output-root strings and
raw hashes of already-verified preceding receipts are rebound in order.
Eight explicit predecessor bindings replace six generated files and two IR files;
the other three replacements are genuine original Kotlin inputs.

The strict pre-assembly verifier checks all eleven canonical output bytes. The
final verifier privately regenerates canonical predecessors from preserved
references and the exact incoming source snapshot, so it also works after root
assembly adds imports in place. It requires eleven actual selected filenames,
unchanged algorithm bytes, all canonical imports and only explicitly allowed
added imports. The selected declaration/caller inventory is conservative lexical
evidence. It cannot resolve arbitrary inheritance, aliases, reflection or string
interpolation; whole compiler typechecking remains required.

The JVM oracle uses genuine IR, deserialized type-alias, constructor and error
descriptors. Four complete shipping Kotlin files are compiled against the complete
pinned Java callable interfaces and verified bootstrap implementations whose
source commit is unpublished. The builtin's unported Java superclass cannot supply
the prior common `Nothing?` visitor contract. Its separate JVM group therefore
compiles the complete pinned original file with only this unit's one exact,
reversible signature span; the target span equals shipping bytes. Prior visitor
and Void protocols are excluded from that group. This boundary does not execute
all five complete shipping files or the entire generated common descriptor family.
Separate full generated-family typechecks use actual canonical shipping outputs
and retain remaining failures explicitly.
The common JVM/Node Wasm projection executes only thirteen exact entry checks
with standard `Any?` markers, compares genuine null messages, and invents no
compiler descriptor model. Compiler bodies after those checks are not projected.

[Sealed evidence](evidence/differential.json) binds 286 actual files, including
52 primary references, eleven shipping outputs, both raw observation streams,
command artifacts and private log/status hashes. All sixteen commands matched
their expected outcomes: fourteen succeeded and two complete generated-family
typechecks retained their expected failures. The 243 genuine JVM observations
match without normalization. The 194 entry-check observations match common JVM
and Node Wasm, including 91 null outcomes tied to genuine JVM receiver results.
All four integrity tests pass.

The full generated-family typecheck falls from 59 to 30 reported errors, with
direct signature errors falling from sixteen to one. The remaining nullable
collection-element override, CopyBuilder bounds, own getter alias and unported
Java superclass relationships remain visible in the original diagnostics; this
unit preserves them. The sealed inventory covers 3,513 actual selected sources,
fourteen declaration files and 200 lexical caller occurrences.

Run `node --test prepare.test.mjs` with `DESCRIPTOR_SIGNATURE_SEED`,
`DESCRIPTOR_SIGNATURE_PREPARED` and `DESCRIPTOR_SIGNATURE_GUARDS` set to the
existing verified fixture, preparation and private guard output roots recorded
in the evidence. `node probe.mjs --runtime <new-output-root> <prepared-root>`
rebuilds the runtime evidence against that preparation. The fixture is derived
from the recorded completed whole build; this is not a fresh-checkout whole
compiler acceptance probe. The whole compiler and public Kotlin readiness
remain false.
