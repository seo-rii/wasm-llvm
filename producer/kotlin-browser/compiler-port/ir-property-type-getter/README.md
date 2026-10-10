# IR property own type getter

`IrBasedPropertyDescriptor` owns a nonnull, virtual `getReturnType()` method.
The original Java `PropertyDescriptor` also refines the nullable base callable
contract. The generated common base `CallableDescriptor.returnType` extension
correctly remains nullable; reading that extension inside `getType()` therefore
produces a real common compilation error. This unit replaces exactly one
expression with `getReturnType()` and preserves the entire surrounding IR source,
the open property class, getter-before-field selection and live virtual dispatch.

Preparation verifies the complete CopyBuilder predecessor and its unchanged
three-chain descriptor-signature preparation. The one replaced IR output belongs
to `descriptorPlatformSignaturesReceipt`; the unchanged nullable base extension
is separately bound to the genuine complete `descriptorReceipt` owner, filename
and bytes. The prepared profile privately preserves all predecessor files and
source snapshots. Official original inputs and both metadata predecessors are
bound to the primary closure's exact source identity and hashes.

The selected guard records the actual IR class references and checks the open
class, getter implementation and nullable base alias. This is conservative
lexical evidence; arbitrary aliases, inheritance, reflection and interpolation
remain outside its proof. Final verification privately replays immutable canonical
bytes, then checks both actual IR and alias filenames, complete algorithm bodies
and vetted added imports. Only the verified IR replacement is rebound in its
predecessor view; every other actual input remains unchanged.

[Sealed evidence](evidence/differential.json) records a complete original and
complete common `IrBasedDescriptors.kt` JVM rebuild, 27 original Java descriptor
interfaces and 29 complete common generated interfaces. The common compilation
uses the actual ClassConstructor declaration and five genuine support files;
three unrelated Kotlin groups (builtin, type-alias and Error descriptors) are
excluded from this probe only. They remain selected compiler inputs. The IR source receives only the required property-alias import derived from its
verified actual dependency; both full algorithm bodies stay byte-exact. The exact
before graph fails with one nullable `getType()` error; the after graph compiles.
The initially rejected previous probe import discrepancy and its complete log,
status, source snapshot and artifacts are retained.

The same observer executes 448 raw original/common records using real built-ins,
module, file, class, property, getter, field and KotlinType payload objects. Getter
priority, live receiver mutation, genuine owner links and the original 32 missing
getter/field NPEs match. An observer-only subclass of the genuine open property
class checks that the actual virtual getter is invoked once per `getType()` call.
The actual original/common JVM `getType()` instructions also use the same
virtual own-getter call and return, with no added null check; only constant-pool
indices are normalized in that separate instruction comparison. Raw observer
output comparison is unnormalized. No fixture compiler class substitutes for
those algorithms. Remaining native
implementation bodies come from the verified bootstrap artifact, whose source
commit is unknown; this is a selected full-source JVM boundary, not a complete
common descriptor runtime or a Wasm execution claim.

Five integrity tests cover the exact span and actual in-place imports on five
outputs. Final checks run in reverse preparation order: IR getter, CopyBuilder,
then descriptor signatures. Their verified predecessor views preserve the strict
unchanged older final guards. Direct transform/invariant tests reject altered
spans, replacements, offsets, class references, openness and nullable alias
narrowing. They do not execute negative cases through the full public final
chain; body/import/filename checks are inspected separately, and the full public
chain is executed once on the actual assembled inputs. Original predecessor
files stay unchanged.

Call `prepareIrPropertyTypeGetter({ outputRoot, preparedCopyBuilder,
retainedSources })`, then `verifyIrPropertyTypeGetter(outputRoot)` before assembly.
After assembly, call `verifyFinalIrPropertyTypeGetter` with the actual selected
map and vetted imports. Pass its `predecessorRetainedSources` to CopyBuilder's
final verifier, and that verifier's view to the unchanged signature final guard.
Other component final guards continue to receive the actual selected map.

Run `node probe.mjs --runtime <new-out-root> <prepared-root>` for the source and
receiver proof. Set `IR_PROPERTY_PREPARATION=<prepared-root>` for
`node --test prepare.test.mjs`; `IR_PROPERTY_FINAL_OUTPUT=<new-out-root>` enables
the complete copied-profile final guard proof. Full descriptor-family runtime,
Wasm execution, a complete compiler build and public language readiness remain
false.
