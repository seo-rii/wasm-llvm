# Audited diagnostic MessageFormat boundary

This unit ports the formatter used by the selected official Kotlin diagnostic renderers to
Kotlin common code. It keeps the pinned renderer bodies, typed parameters, context and factory
declarations. Three imports bind `java.text.MessageFormat` to `DiagnosticMessageFormat`.
The supplemental Web Common diagnostic table is copied unchanged at its original logical path.
It remains part of the real compiler source composition; this code never parses user Kotlin.

The supported profile is explicitly **en-US**. Actual parameter renderers return `String`;
exactly five diagnostic registrations pass an unrendered `Int` type-argument count. The port
supports the corresponding quoting, placeholders, integer grouping and choice/nested-choice
operations. Null/missing arguments retain the OpenJDK formatting behavior. Arbitrary objects,
other numeric types, date/time, currency, percent and custom decimal styles fail explicitly.
Locale provider selection, the full `java.text` API and JVM class identity are outside this unit.

`rendering.recipe.json` binds the Kotlin source revision, primary closure, supplemental Web
Common source pins, OpenJDK references, transformed output bytes and template inventory.
`templates.lock.json` records all selected real registrations, including renderer expressions,
factory types and the five raw `Int` cases. It is a source inventory, not execution evidence for
the actual diagnostic tables or resolved FIR.

## Preparation contract

`prepareDiagnosticRendering({ sourceRoot, additionalSourceRoot, outputRoot, referenceCache })`
returns `commonSources`, `replacedOriginalPaths`, `sourceSetExclusions`,
`supplementalOriginals`, `requiredDiagnosticProfile`, `receiptPath` and `receipt`.

- `sourceRoot`: unchanged primary Kotlin source cache matching `closure.lock.json`.
- `additionalSourceRoot`: unchanged same-revision supplementary source cache; default
  `out/kotlin-source-closure-reference/sources`.
- `referenceCache`: pinned JDK source files; default `out/kotlin-diagnostic-rendering-reference`.
- `outputRoot`: fresh directory below repository `out/`, outside both source caches.

Preparation verifies all source pins and the source-wide selected MessageFormat caller inventory
before publishing output. It rejects symlinks, source/output overlap, changed bytes and existing
output. It does not download sources or modify the input caches. Its five common source outputs
replace three primary renderer files and the supplemental Web Common renderer table, then add
the portable formatter. The supplemental generated factory belongs to source-closure preparation
and is not replaced here. Composition must remove the table's earlier output at its exact
`src/.../FirWebCommonErrorsDefaultMessages.kt` logical path to avoid duplicate declarations.

Prepare the six pinned JDK reference files separately when they are not already cached:

```sh
node --input-type=module -e "import('./producer/kotlin-browser/compiler-port/diagnostic-rendering/prepare.mjs').then(m => m.prepareDiagnosticRenderingReferences())"
```

## Focused validation

With the verified primary/supplemental source caches and bootstrap already present:

```sh
node --test producer/kotlin-browser/compiler-port/diagnostic-rendering/integrity.test.mjs
node producer/kotlin-browser/compiler-port/diagnostic-rendering/build-probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output out/kotlin-diagnostic-rendering-probe/my-fresh-run
node producer/kotlin-browser/compiler-port/diagnostic-rendering/browser-probe.mjs \
  --input out/kotlin-diagnostic-rendering-probe/my-fresh-run
```

The probe compiles the recipe-pinned OpenJDK `MessageFormat`, `ChoiceFormat`, `NumberFormat`
and `DecimalFormat` sources with `javac --patch-module`, then executes their actual implementations
on the recorded JDK 17. Host `java.lang.Integer` and locale provider data remain host JDK inputs;
this is not a complete OpenJDK rebuild. The original probe uses explicit en-US formatting,
including the static-vararg call shape, while varying the process default locale.

The same observer runs against the common port on JVM and compiled Wasm. It checks literal
parameterized patterns from the pinned tables plus quote/brace, nested choice, sign, Unicode
index, overflow, integer boundary, null/missing argument and adaptive-name fixtures. Expressions
requiring unresolved symbols, interpolation or raw-string methods are reported as deferred;
the probe does not evaluate invented substitutes for them. Simple diagnostic registrations bypass
MessageFormat and remain unchanged. Separate JVM/Wasm checks exercise the unsupported-profile
rejection contract. Receipts bind commands, bootstrap, observer bytes, output bytes and comparison
hashes, with explicit unexecuted diagnostic/FIR/full-compiler/browser acceptance fields.
The five raw Int base patterns also execute their original interpolation prefix over boundary
counts. Their LanguageFeature-dependent warning-suffix extension remains explicitly unexecuted.

The browser observer verifies the build receipt, observer sources and every output byte before
loading the exact Wasm in a Chromium Worker from locally fulfilled immutable assets. After module
initialization it sets the context offline and requires both identical JVM observations and zero
network requests. This establishes offline formatting after initialization, not offline application
installation/restart or source-to-program compiler acceptance.

The checked-in [JVM/common/Wasm receipt](evidence/jvm-common-wasm.json) records 2,649 identical
observations, 407 literal parameterized patterns and the five raw Int base patterns over 40
samples. The [Chromium offline receipt](evidence/chromium-offline.json) records the same
observations and rejection profile in a real Worker, with no external or offline requests.
Seven preparation/integrity tests passed. The 64 deferred complete pattern expressions and
warning suffixes remain listed in the JVM/common/Wasm receipt; base-pattern execution does not
claim those whole expressions or actual diagnostic tables executed.

The formatter retains Oracle, Taligent and IBM attribution, including the Integer.parseInt
copyright, and is licensed under GPL-2.0-only WITH Classpath-exception-2.0. The complete upstream
license is in `LICENSE.OpenJDK`. The original Kotlin diagnostic sources retain their Apache 2.0
headers. This component's differential result does not enable public Kotlin language support.
