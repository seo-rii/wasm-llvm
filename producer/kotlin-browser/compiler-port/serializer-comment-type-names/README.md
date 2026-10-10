# Serializer comment type-name boundary

This unit preserves the genuine open `JsComment` protocol and replaces the
Serializer's one JVM-only unknown-comment type-name lookup with a required
caller-owned `JsCommentTypeNameReporter`. It adds no default implementation or
type-name table. An arbitrary comment implementation still reaches the same
fallback error after its text has been read and written.

The exact three predecessor sources come from `serializer-output-bindings`.
`inventory.json` binds five Serializer spans, two shared carrier spans, and
three fragment spans: imports, required parameter declarations and forwarding,
the private Serializer constructor, and the single interpolation expression.
The two original standard-comment type tests, error prefix, complete Serializer
body, nullable getter checks, and transport operations remain unchanged. The
original Kotlin commit, full predecessor pins, and original notices are retained.

The required host API is:

```kotlin
fun interface JsCommentTypeNameReporter {
    fun report(comment: JsComment): String
}
```

The same reporter is forwarded through `IrICProgramFragments.serialize`, the
genuine `JsIrProgramFragments` override, `serializeTo`, and the private
Serializer. It is called once only for an unknown implementation. Standard
comments and an exception from `comment.text` do not call it. Reporter exceptions
propagate at that exact expression, after the same partial bytes were written.

The JVM observer supplies the actual `Object.getClass().getName()` result and
compares complete genuine original/common Serializer objects. It covers 88
cases: both genuine standard classes, seven external implementations (generic,
nested, inner, Unicode, local, and anonymous), six text inputs including NUL,
unpaired surrogates and a buffer boundary, getter failures, and comments before
and after genuine AST statements. It compares raw exception names/messages,
all four writer buffers, map sizes, and text-getter order. A separate 88-case
caller-exception run verifies unchanged partial state and receiver identity.

The Wasm observer executes the exact complete `DataWriter`, `writeComment`, and
`withComments` bodies against all 113 genuine common AST sources. The observer
container and fixed `writeInt(123456)` inner callback are projections, not a
replacement compiler or a full Serializer Wasm run. Its caller supplies the
actual public `comment::class.toString()` result. Raw JVM/Wasm diagnostic strings
are retained: 63 normal unknown-comment messages differ by the genuine host
representation. The other fields, failure types, callback counts, identical
receiver, getter order, and partial bytes agree across 352 raw records. No
string normalization or Java binary-name parity is claimed.

The existing registry already enables and tests `-Xwasm-kclass-fqn`. This unit
adds no flag or reflection capability. Serializer metadata `qualifiedName`
expressions are unchanged and outside this comment boundary.

## Preparation and final selection

```js
const options = {
  sourceRoot, outputRoot,
  preparedSerializerOutput,
  serializerOutputOptions, // preserved exact options used by that preparer
  retainedSources,        // actual selected pins before this layer
};
const component = await prepareSerializerCommentTypeNames(options);
await verifySerializerCommentTypeNames(options);
```

Use an immutable original `sourceRoot`, not the build mirror after global
imports. Every selected pin is `{path, filename, bytes, sha256}` with an absolute
filename. The preparer performs the complete earlier preparation replay, binds
its exact receipt and canonical three outputs, saves their original bytes under
`reference/`, and returns four `commonSources`, three `predecessorBindings`
owned by `serializerOutputReceipt`, and the same three replacement logical keys.
The helper logical key is
`compiler-port-serializer-comment-type-names/org/jetbrains/kotlin/js/portable/JsCommentTypeNameReporter.kt`.

Before late build imports, retain the preparation options and bind the new
receipt's SHA. At final selection, call
`reconstructSerializerCommentTypeNamePredecessorSelection` with the actual final
selected pins. It verifies the real four sources and exact transformations
before constructing an explicit earlier view: remove this helper and substitute
the authentic three prior output files. The unchanged old Serializer final
guard runs on that view. Root composition must compare the previously bound
receipt SHA before calling this guard. The prior files are disabled by this
layer and must retain their genuine bytes.

The final guard checks the exact three preserved references and canonical prior
receipt/outputs. It does not replay early preparation options or reopen early
selected filenames after the build changes them. The early complete ancestry
verification is bound by the raw new receipt SHA. Final sources are checked
against the precise transformation after removing only the recorded 74 alias
imports and the existing assertion/JVM annotation imports. An unrecorded class
import is rejected. A positive guard overwrites a genuine early
`FirElementSerializer` mirror and all four new files with those exact late
imports; early replay rejects that changed snapshot while final verification
passes with the original receipt SHA.

Both phases reject a new serializer/hierarchy/reporter consumer, changed known
consumer, duplicate logical source, missing or noncanonical output, and any of
the prior backend profile's 21 excluded native IC sources. The same seven known
hierarchy consumers and four reporter consumers are bound. An additional
external comment class without a new reporter/hierarchy call remains permitted.
These are conservative textual consumer guards, not a semantic whole-program
reachability proof; comments and strings can cause rejection.

The standalone fixture reuses the recorded genuine 3,515-source selection and
substitutes the three verified predecessor outputs, then adds the helper. It
does not claim that the final compiler graph was rebuilt. Preparation, runtime,
projection, negative guards, bootstrap, and local artifact pins are sealed and
rechecked by `verifySerializerCommentTypeNameEvidence`.

The verifier additionally pins the real 3,520-source selection recorded by the
latest source-map final guard before a preparation failure. It verifies the
unchanged failed receipt (`commands: []`), substitutes this unit's three outputs
and helper for an independent 3,521-source final guard replay, and retains the
actual other source filenames and hashes. This is a selection guard proof, not
a compiler invocation or a rebuilt graph.

`fullSerializerWasmExecuted`, `fullCompilerBuilt`, and `languageReadiness` remain
false. No public language support is enabled by this unit.
