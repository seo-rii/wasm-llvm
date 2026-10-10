# Sourced diagnostic delegate metadata variant

The source-free DSL is a separate prepared compiler input. This unit supplies
the remaining official typed diagnostic helpers and providers, plus the six
actual retained backend diagnostic containers that call them. It reuses the
locked complete official DSL reference at Kotlin commit
`4d78aae1e337cd40f69baa865aed950fe807a775`; it does not change or duplicate the
source-free declarations.

The prepared DSL removes exactly the metadata type parameter `P : PsiElement`,
its `P::class` argument, and the ten providers' `psiType` fields and forwarding
arguments. Every helper payload type, context parameter, `KProperty.name`,
`DummyDelegate`, positioning strategy, deprecation feature, severity and renderer
selection remains intact. It calls the real existing common
`KtDiagnosticFactory0`–`4` and deprecation factories whose matching PSI metadata
was removed by the diagnostic-factories component.

The prepared containers are `CommonBackendErrors`, `IrActualizationErrors`,
`IrInlinerErrors`, `SerializationErrors`, `JsKlibErrors` and `WasmKlibErrors`.
Only their first `PsiElement` generic argument and its unused import are
removed. Their actual typed payloads, renderers, helper functions, mapping
tables and algorithms stay intact. There are 31 metadata type argument sites
and 34 sourced property bindings: the real Wasm export-clash helper is used by
four diagnostic properties. All original eight files, all removed spans and
their exact hashes are preserved; six primary container pins are checked
against the primary closure. The source-free declaration spans are recorded
as belonging to the separate source-free DSL unit.

```js
await prepareDiagnosticSourceDslReferences();
const component = await prepareDiagnosticSourceDsl({
  sourceRoot,
  outputRoot,
  retainedSources: finalInputs.map(({ path, filename, bytes, sha256 }) =>
    ({ path, filename, bytes, sha256 })),
});
await verifyDiagnosticSourceDsl(dirname(component.receiptPath));
// Disable component.replacedOriginalPaths, then add its seven commonSources.
```

Compose after the actual backend/legacy source selection and include every
remaining input in the caller guard. The guard requires precisely the six
original typed-helper callers, rejects unknown callers and alias imports, and
hashes every actual selected source byte. It retains comments and strings, so
an ambiguous unrelated name conservatively fails. This is a lexical source
selection guard, not a resolved FIR call graph. A compressed full input
snapshot lets independent verification repeat it after later composition.
Each selected container body must also equal its pinned original, allowing only
import lines and the package-header newline gap to differ. A prior algorithm
change cannot be silently replaced even when its delegate call count is equal.
The root composer must apply its official optional `kotlin.jvm` annotation
import binding to the new files as it does to the other compiler sources.

Integrity checks reject unexpected PSI body uses, changed generic grammar,
payload changes, source/output overlap, symlinks, reused outputs, source pins,
modified prepared files and altered receipts or completion claims. Run them
with `node --test producer/kotlin-browser/compiler-port/diagnostic-source-dsl/prepare.test.mjs`.
The actual differential requires a completed compiler input snapshot:

```sh
node producer/kotlin-browser/compiler-port/diagnostic-source-dsl/probe.mjs \
  --output out/<fresh-directory> \
  --frozen-build-root out/kotlin-compiler-port/builds/<completed-build>
```

[The captured differential receipt](evidence/differential.json) records six
passing final integrity guards with no skips, a guard over all 3,445 actual inputs,
and 154 equal original/common JVM observations. Both variants compile complete
official DSL/factory/container source files and the real diagnostic report
helper that chooses deprecation factories. The observer exercises all 17 typed
helpers, every provider arity, actual key/type/severity/identity, explicit and
default positioning strategies, ten original/custom deprecation pairs with
enabled and disabled features, actual renderer messages and global registration.
It checks genuine PSI class metadata on the original variant and its absence
on the common variant. The receipt includes the equal observation bytes,
compiler artifacts, exact metadata spans, tools and completed log/status hashes.
The regression test first failed because the previous preparer accepted a prior
body change. The strengthened guard now rejects it. Its fresh seal records the current
preparer hash and exact selected body hashes. The seven output/span pins remain
identical to the original passed JVM differential, whose historical runtime
receipt is retained without another compiler runtime run.

The JVM oracle uses genuine verified bootstrap diagnostic/configuration/IR and
renderer support whose source commit is unknown. Its PSI imports bind to that
bootstrap's actual relocated IntelliJ classes without changing bodies. No
fixture compiler class, payload type, PSI implementation or success stub is
supplied. The source-free DSL's separate Wasm registration evidence does not
prove this sourced diagnostic graph. Actual Wasm source/context/positioning and
IR payload runtime remain a separate whole-compiler target gate. This unit
claims no Wasm runtime parity, offline browser execution or Kotlin readiness.
