# Genuine class descriptor implementation port

This component preserves all eight pinned Java class bodies from Kotlin commit
`4d78aae1e337cd40f69baa865aed950fe807a775`: `AbstractClassDescriptor`,
`ClassDescriptorBase`, `ClassDescriptorImpl`, `LazySubstitutingClassDescriptor`,
`EnumEntrySyntheticClassDescriptor`, `LazyClassReceiverParameterDescriptor`,
`AbstractClassTypeConstructor`, and `ClassTypeConstructorImpl`. The concrete
classes and reachable overrides remain open wherever Java permits subclassing.
The lazy default type/refinement callback, receivers, scope overloads, constructor
copies, substituted type parameters, graph neighbours, enum fake overrides and
memoized name/descriptors sets retain their algorithms and evaluation order.

Java can invoke the protected argument-list scope overload on another
`ModuleAwareClassDescriptor` in its package. Kotlin needs explicit access. The
complete pinned Kotlin source gets one internal companion bridge and one public
extension forwarding directly to that genuine protected overload. Neither the
argument list nor the refiner is converted. `transform.mjs` verifies and reverses
those exact insertions; every original method body and interface contract stays
intact.

The complete genuine `ErrorClassDescriptor.kt` initializes a constructor through
Java's writable synthetic `returnType` property. A narrowly typed extension for
`ClassConstructorDescriptorImpl` forwards its getter and setter to the existing
virtual methods. The same helper preserves the reached writable `CallableMemberDescriptor`
`overriddenDescriptors` property used by the complete genuine OverridingStrategy.
Two full consumer source overlays add only their exact explicit property
imports from `org.jetbrains.kotlin.portable.classdescriptors`. These local imports
select the writable virtual boundaries over older read-only wildcard aliases
without changing the global import list. Their original bodies remain intact. The annotated non-null
constructor getter remains unchanged; nullable delayed backing state stays in
the implementation.

Preparation requires nine genuine predecessor receipts and checks 28 full
canonical artifacts against their exact selected owners. It also binds seven
complete genuine Kotlin consumers. All 12 outputs are verified by externally
captured receipt SHA, exact body/import assembly, and selected owner. Final
verification removes only the nine additions and restores the three pinned
predecessor rows for the complete ModuleAware and writable-property consumers,
preserving the prior selection's
order and body for older guards. Historical builds are never modified.

The focused JVM proof compiles the complete original Java family and the complete
common Kotlin family, with the genuine ErrorClassDescriptor and other class
consumers. Real refiner callbacks exercise the null-descriptor cache, protected
class scope, type-alias expansion and classifier fallback branches. The alias
fixture extends the genuine initialized bootstrap AbstractTypeAliasDescriptor,
whose common closure is also outside this proof. Its genuine compiler bootstrap remains a scoped dependency, including
`OverridingUtil`, `DescriptorUtils`, builtins, storage, checker/refiner and graph
scopes. That bootstrap's source commit is unknown and its artifacts are hashed;
this proof does not establish common closure for those algorithms. No fake
compiler-package classes or projected shipping class bodies are used.

Raw Java null values before an annotated non-null initialization boundary are
measured separately. They are unsupported Kotlin interoperability states, not
claimed equivalent legal descriptor behavior. Java reflective field layout,
external Java mutation of read-only Kotlin collections, and cross-runtime
object hash values are also outside the claim. The measured Java attempt to
clear the returned supertypes view throws in the original and succeeds in the
common JVM carrier; both preserve the input carrier alias before lazy evaluation.
Real Wasm execution of this
family, a complete compiler build and offline browser language readiness remain
unproved. Final completed runtime/selection/canonical evidence is recorded under
`evidence/` only after successful frozen runs.
