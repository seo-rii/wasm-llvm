# Original common diagnostic renderers

This component restores three omitted official inputs from
`compiler/frontend.common-psi` at Kotlin
`4d78aae1e337cd40f69baa865aed950fe807a775`: `CommonRenderers`,
`LanguageFeatureMessageRenderer` and the generated feature-to-flag map.
All diagnostic renderers, conflicting-signature sorting/context algorithms and
feature messages remain selected. No PSI class or renderer stub is supplied.

The sole runtime host binding replaces JVM PrintWriter/StringWriter and
IntelliJ StringUtil with the actual common `Throwable.stackTraceToString()`.
It preserves the original truncation to 2,048 UTF-16 code units followed by
`...` for a longer trace. Each platform prints its own genuine stack frames;
JVM and Wasm traces are not promised to be identical. JVM annotations are
imported explicitly as official optional common annotations.

`sources.lock.json` pins each complete original file by Git blob, size and
SHA-256. `prepareDiagnosticCommonReferences()` fetches only their exact commit
URLs, verifies existing cache bytes and rejects symlinks. Preparation publishes
six verified original/common files and a receipt below a fresh
`compiler-port-diagnostic-common` directory. `verifyDiagnosticCommon(root)`
reconstructs the selected outputs against the original source and rejects
changed files or receipts.

```sh
node --test producer/kotlin-browser/compiler-port/diagnostic-common/prepare.test.mjs
node producer/kotlin-browser/compiler-port/diagnostic-common/build-probe.mjs \
  --output "$PWD/out/kotlin-diagnostic-common-new-run"
```

The focused probe extracts and executes the exact original and transformed
Throwable renderer bodies. It does not construct substitute compiler objects
or claim that the complete diagnostic tables executed. Original/common JVM raw
observations must match. Wasm must preserve its actual raw trace and the same
truncation contract, with its differing host frames retained as evidence.
The original IntelliJ helper is supplied by the verified bootstrap artifact;
its source identity remains unproven. The complete renderer class, language
feature messages, FIR, browser Worker and whole compiler acceptance remain
separate gates. Run compilation with private background logs and exit receipts.

The [executed trace receipt](evidence/trace-binding.json) records seven real
Throwable cases on original JVM, common JVM and Wasm, including empty/Unicode
messages, truncation boundaries and malformed UTF-16. JVM raw observations
match and each Wasm raw trace satisfies the original truncation contract.
Five source/integrity guards passed; the completed private log and exit receipt
are hashed in the evidence. Full renderer and compiler readiness remain false.
