# Compiler exception and attachment boundary

Current-foundation integration uses the complete 3,571-source shipping recipe,
including all eighteen JVM signature sources. The current verification command
and its separate evidence are described in [CURRENT_FOUNDATION.md](CURRENT_FOUNDATION.md).
The preserved `evidence/selection.json` and baseline-variant instructions below
describe the earlier 3,553-source validation; they do not qualify the later source set.

This profile verifies transformations of five complete pinned compiler files: AnalysisExceptions, the
legacy and current attachment exception classes, platformExceptionUtils, and FIR
Utils. It preserves throw/unwrapping, message/quote, LightTree containment,
attachment creation/copy/null/prefix, and constructor algorithms. The sealed
source host contains only KtLightSourceElement. Unreachable PSI branches and two
unused PSI utility files are removed only after original and actual incoming
reference checks.

Only the two fatal-wrapper expressions change in FIR Utils. Its other PSI helper
dependencies remain outside this profile; retaining those pre-existing diagnostics
does not mean that its exception policy has silently gained a fallback.

The sixth replacement binds a required `CompilerExceptionHost` constructor
argument around the complete `BrowserCompilerPipeline.compile` request with
`withCompilerExceptionHost`. The scope includes installation of the other request
hosts and restores the previous host in `finally`, including when a callback or
compilation throws. The exact original pipeline is restored for earlier source
verifiers. No existing constructor call is omitted: the selected graph currently
contains the pipeline declaration, while BrowserCompiler.kt defines its frontend.
The full pipeline has not run in a browser.

The caller must supply actual fatal/control-flow/index classifications and an
external attachment decoder. This port does not invent a browser taxonomy or
silently classify every exception as nonfatal. Cancellation keeps the genuine
common standard-library binding. One synchronous request runs in one Worker;
host callbacks must not suspend or reenter compilation.

Two portable sources implement the selected attachment contract. String-owned
attachments preserve path, display text, fresh byte arrays, and Java's observed
`?` replacement of each unpaired UTF16 surrogate. External implementations,
including attachments entering through a Throwable, require the installed decoder
before their bytes are read. There is no general binary, malformed UTF8,
temporary-file, or file-backed attachment parity claim.

Preparation runs after source selection and global import assembly. It replaces
six complete rows, excludes two PSI rows, and appends two helpers with
`compile:true`. Final verification authenticates full rows, owner paths, hashes,
and order, then reverses exactly eight predecessor rows and removes its helpers.
Native lexical and module audits retain the actual new graph; only earlier exact
source verifiers receive the authenticated predecessor.

Validation executes the genuine bootstrap JVM classes, their common JVM port,
and actual Node Wasm modules. Twelve raw String records and 57 records from four
complete retained exception classes agree without output normalization. Platform
policy compares five genuine JVM cases. Eight request-host contracts cover
classification dispatch, cancellation short-circuiting, external decoding,
nested scope restoration, thrown callback/body identity, and rejection before
external byte access when no request host exists. The same modules and all six
probe exports also pass in three Chromium Module Workers. Cause stack traces are
checked locally; their raw bytes are not compared across platforms. These are
component executions, not a browser compiler.

The earlier source and native/module composition proof, negative guards, actual
whole compiler invocation, and diagnostic comparison remain in `evidence/selection.json`.
Its `verify.mjs` validator bound the then-current source pins, including the old
FIR guard. That historical binding must not be substituted for the new current
foundation proof, which reopens the new inputs and actual compiler invocation.
Whole-compiler blockers outside this profile do not become successful compilation
or public Kotlin support.

The initial attempt on foundation `31b83cf` stopped before this exception profile
and before the compiler ran: its FIR storage guard rejected `JvmClassName` in
`SignatureBuildingComponents.kt`. That failed attempt is preserved separately.
The repaired guard distinguishes the six exact portable declaration/use files
from the private PSI/JVM facade island, without allowing unknown consumers or
changing the excluded storage spans. The shipping recipe retains all eighteen
signature sources.

The earlier whole-source qualification used an explicit validation variant:
baseline `4b6f787` (the last actual 3,553-source compiler invocation) plus this
exception delta. `baseline-variant.mjs` authenticates the two original build
recipes, reverses exactly the three JVM signature additions, and requires the
result to reproduce the baseline recipe byte for byte. The same exact inverse
is applied only to a separate snapshot of the shipping recipe. It preserves all
remaining exception changes, including the authenticated predecessor graph.
Final verification also matches that predecessor's ordered source identities
against the actual original 3,553-input receipt. A passing baseline variant
does not qualify the current foundation or produce a complete compiler.

The recorded variant completed source preparation and invoked the real Wasm
compiler with 3,553 inputs. It exited 1 with 1,308 cascading error entries, compared
with 1,422 in the authentic baseline. Exception-profile entries fall from 74 to
five existing FIR PSI errors; there are no newly emitted diagnostics in the
profile, request entry, helpers, or other files. These counts locate remaining
blockers and are not a language correctness score.

```sh
KOTLIN_PROFILE_BASE_BUILD=/path/to/recorded/base-build node --test \
  producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile/prepare.test.mjs
node producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile/measure-runtime.mjs \
  out/new-exception-runtime /path/to/pinned/kotlin/sources
node producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile/measure-browser.mjs \
  out/new-exception-runtime out/new-exception-browser.json /path/to/playwright/package.json
node producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile/verify-current-foundation.mjs
```

Runtime measurements require the existing locked bootstrap cache. Whole-source
builds use the compiler-port build command and all of its declared/reference
inputs. Keep historical artifacts immutable and preserve the final validation
snapshot (or its verified archive) while its evidence refers to that snapshot.

To reproduce the historical variant, first restore its pinned producer revision
in a separate complete producer snapshot and
populate its locked/reference inputs as described by the compiler-port build
instructions. Run `prepare-baseline-variant.mjs SNAPSHOT_ROOT
SNAPSHOT_ROOT/out/baseline-variant` from this profile, then run that snapshot's
`compiler-port/build.mjs`. The preparation command refuses to edit the shipping
checkout and writes the authentic original recipes and projection proof. Record
the actual compiler job's log, exit status, and `projection` path. The sealing
configuration also requires the independent `currentFoundationJob`, component
`runtime`, `browser`, `guards`, `baselineRepository`, and `diagnosticsOutput`;
both build outcomes remain explicit in the final evidence.
