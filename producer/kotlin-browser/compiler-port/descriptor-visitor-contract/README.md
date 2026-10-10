# Descriptor visitor null dispatch

The pinned Java DeclarationDescriptor visitor parameters are unannotated platform
references. The selected genuine Kotlin sources contain 29 nullable overrides,
12 nonnull generic accept overrides and three nonnull acceptVoid overrides.
A common nullable base cannot accept the original nonnull override headers.

This unit keeps both generated interfaces unchanged. Only the 12 nonnull generic
headers become nullable; an immediate NullPointerException check retains the
original source method's observed JVM message before its original body/return.
Expression bodies become blocks returning the same expression. Reversing the
12 sealed substitutions reconstructs every original file byte for byte. All 29
already-nullable declarations/bodies and every Void declaration/body stay exact.

The oracle compiles full originals with the pinned official 2.5.0-dev-10106 JVM
compiler, language/API 2.5, target 17, modern default mode enable, with parameter
assertions enabled. Actual source-compiled ModuleDescriptorImpl reaches the
actual interface default body. The real older bootstrap receiver instead enters
a DefaultImpls bridge and reports that bridge's method name. This raw negative
is retained; universal mixed-version bridge messages and stack frames are not
part of the portable profile.

## Preparation

prepareDescriptorVisitorContracts({ sourceRoot, outputRoot, preparedDescriptors,
retainedSources }) replays the entire existing descriptor preparer, tools,
sources, index and receipts. Both canonical generated interfaces must remain
selected once; neither is replaced. The 13 visitor-bearing Kotlin inputs must
equal pinned originals before root's global host import binding.

The result has ten commonSources at their **same original logical paths directly
under outputRoot**, ten replacedOriginalPaths, and no predecessorBindings.
Root replaces these originals once, then applies its normal host imports.
Preserved base and Visitor bindings record component keys, canonical filenames,
bytes, hashes and replayed receipt hash. Original references, copyright headers
and Apache 2.0 provenance remain preserved.

verifyDescriptorVisitorContracts({ ...inputs, profileRoot }) replays all inputs,
outputs and claims. The guard binds all 44 known override spans and rejects
missing sources, unrecorded overrides (including multiline/renamed parameters
and direct import aliases), altered nullable behavior and direct unreviewed
visitor type aliases. Literal, typed and inferred nullable platform callers
remain admitted. This lexical guard does not prove arbitrary aliases,
inheritance, reflective callers or code hidden inside string interpolation;
actual compiler typechecking remains necessary.

## Evidence and open boundaries

check.mjs NEW_OUTPUT_ROOT verifies the exited 3,515-source compiler argument
selection and every actual input hash. The preparation input projection rebinds
exactly the 13 originals and two generated contracts to their verified canonical
versions before global host import insertion.

The full JVM differential compiles all 13 visitor-bearing originals, actual
ModuleDescriptorImpl and EmptyPackageFragmentDescriptor, and both complete Java
interfaces. Twelve real receivers are built using actual descriptor/IR/metadata
constructors and factories. Two genuine nullable FIR receivers retain their
different null behavior. Tests cover null entry, nullable data/results, boxed
generics, side effects, visitor exceptions, actual interface default dispatch
and unchanged nullable Void behavior. The full common-source JVM variant uses
the original Java platform interfaces; it is not a portable graph typecheck.

The actual generated Visitor has 15 methods returning R, not R?. A separate
projection compiles each exact checked generic body as an extension on its real
receiver type with both entire generated interfaces and the full actual Module
interface. It executes on those same real receivers and compares raw records.
No descriptor or visitor classes are invented.

The following actual failures remain negative evidence: full source files with
the generated Visitor reject original D=Void calls passing null; actual
ModuleImpl source with the nullable generated base cannot implement its
Nothing?-encoded acceptVoid through its genuine Java Void base. Every diagnostic
is retained. The isolated generic projection neither fixes these failures nor
proves portable ModuleImpl acceptance. No Void method is removed or cast.

Only the twelve exact shipping NPE statements execute in a common JVM/Node Wasm
projection. Null outcomes compare directly with original real receivers through
the common KClass.simpleName/message API. Nonnull standard Any markers exercise
the check's other branch; they model no compiler objects. Full forwarding and
the nullable descriptor graph do not execute on Wasm.

The full original/common/generated-interface JVM comparisons agree on 813 raw
records. The common JVM/Node Wasm statement projection agrees on 24 raw records,
including twelve null outcomes checked directly against the original receivers.
Projection fixtures invoke the verified same twelve owners in the original
observer order; output strings are never sorted or normalized.

Eight integrity guards test preparation and replay. verify.mjs checks the final
source/status/artifact seal. Bootstrap dependencies do not publish their source
commit. Browser execution, portable Void mapping, the whole compiler and public
Kotlin readiness remain false.
