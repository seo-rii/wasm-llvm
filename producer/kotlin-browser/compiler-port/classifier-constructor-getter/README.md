# Classifier constructor covariant getter

The official `ClassifierBasedTypeConstructor` overrides
`getDeclarationDescriptor(): ClassifierDescriptor` with a nonnull return. The
common property alias is declared on `TypeConstructor`, whose original Java
getter is nullable. Resolving the two own-receiver `declarationDescriptor`
expressions through that base alias loses the original covariant type, producing
three type errors in the selected compiler build.

This unit changes only `val descriptor = declarationDescriptor` and
`val myDescriptor = declarationDescriptor` to direct calls to the original own
getter. The public getter signatures and base property alias remain unchanged.
`other.declarationDescriptor ?: return false` retains its original nullable
behavior. The full hash cache, identity-token predecessor, parameter-count
checks, FqName ancestry comparison and classifier equality bodies remain
byte-identical outside those two bindings. No nonnull base alias or classifier
implementation is added.

`prepareClassifierConstructorGetter({ sourceRoot, outputRoot, preparedIdentity })`
returns one full source file at its original logical path, one checked generic
`identityReceipt` predecessor binding and that single `replacedOriginalPaths`
entry. It verifies both official source pins, the current identity recipe and
tools, exact predecessor content and filename, both sequential replacement
spans and the final complete output hash. `verifyClassifierConstructorGetter(root)`
reconstructs the receipt and output from immutable references and the separately
bound predecessor provenance. Integration belongs immediately after identity
preparation, before global import assembly.

The probe freshly generates and verifies the existing real common
`TypeConstructor.kt` and `TypeProperties.kt`. The unfixed full class must fail
with exactly the three recorded nullable argument errors; the fixed full class
then compiles against the same contracts. Full original and common class bodies
execute on genuine bootstrap `ClassTypeConstructorImpl`, class/module/package/
function descriptors, builtins, error and local descriptors. The bootstrap
artifact source commit is unpublished and is not assumed to equal the selected
source revision.

A separate isolated observer projects the exact complete class body into an
explicit descriptor/type payload boundary outside compiler namespaces. Its
original JVM receiver contract uses the pinned nullable Java getter and nonnull
parameter getter declarations with only payload return/generic types substituted.
Common JVM and Node Wasm use the nullable common receiver property shape.
Fixtures supply names, ancestry, error/local flags and FqName query values;
they are not shipping compiler contracts. This observes hash caching, zero-hash
recomputation, equal/hash relations, nullable other receivers, parameter counts,
name collisions, ancestry and descriptor mutation. Numeric identity hashes are
observed only through stability and equal-implies-equal-hash, never compared
across hosts. Full classifier/descriptor graph execution on Wasm and full browser
compiler acceptance remain separate gates.

```sh
node --test producer/kotlin-browser/compiler-port/classifier-constructor-getter/prepare.test.mjs
node producer/kotlin-browser/compiler-port/classifier-constructor-getter/probe.mjs out/fresh-classifier-getter-probe
```

Actual validation receipts, command outcomes and bounded raw observations are
preserved in [evidence/differential.json](evidence/differential.json). The three
expected before-fix errors were reproduced. All twelve following build/observer
commands exited 0: 2,311 full-class genuine JVM observations and 12,898 isolated
class-body records matched exactly across their stated hosts, without output
normalization. Four integrity guards passed with no skips. This does not claim
that the full compiler or its common classifier dependency graph built.
