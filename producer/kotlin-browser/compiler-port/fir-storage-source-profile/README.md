# FIR storage source profile for the browser Klib entry

This unit removes one private PSI/JVM source-facade island from the genuine
prepared `Fir2IrDeclarationStorage.kt`: the 655-byte private facade class, the
1,950-byte PSI-only branch, and four unused imports totaling 207 bytes. Every
remaining storage byte is preserved from `firStorageReceipt`, including its
serial cache changes, provider selection, existing file-cache return, package
fallback and all other FIR2IR algorithms. No checker, phase, public FIR type or
throwing replacement is introduced.

The proof is specific to the selected browser entry. Its complete pinned body
uses `Fir2IrConfiguration.forKlibCompilation`, whose complete upstream source
sets `allowNonCachedDeclarations=false`. The constructor is private; the
selected source graph contains no Analysis API or other configuration factory
consumer. Independently, the genuine `sourceHostReceipt` contains the sealed
`KtSourceElement` family with only its LightTree implementation. `FirElement`
uses that source type, and the exact upstream `FirElement.psi` getter is a pure
nullable PSI cast. These conditions make the excluded branch unreachable in
this selected profile. JVM/IDE source-facade behavior is outside this profile;
the upstream reference bytes and excluded span hashes remain available.

`prepareFirStorageSourceProfile({ sourceRoot, outputRoot, preparedFirStorage,
preparedHost, retainedSources, forwardSources })` verifies the primary source
closure identity and every official source/Gradle pin, both genuine predecessor
tools and receipts, and the selected source bodies. Early assembly must pass the
two explicitly pinned repository entry files in `forwardSources`, with logical
paths `compiler-port-entry/BrowserCompiler.kt` and
`compiler-port-entry/BrowserCompilerPipeline.kt` plus their actual filenames,
sizes and hashes. They are part of the immutable selected snapshot before the
global assembly imports are added. Duplicate or missing entry bindings fail.
The returned single `predecessorBindings` entry supersedes the exact
`firStorageReceipt` source; `sourceHostBinding` is verification evidence and
does not publish a second host source.

`verifyFirStorageSourceProfile(outputRoot)` is strict before assembly.
`verifyFinalFirStorageSourceProfile({ profileRoot, retainedSources,
allowedAddedImports })` replays canonical bytes privately from immutable
references and predecessors, then checks the actual final storage source,
filename, entry bodies, getter/configuration/source-family bodies and complete
selected lexical closure. It allows only explicitly declared assembly import
additions and otherwise preserves canonical imports. The guard is conservative
lexical analysis with exact body pins, not a resolved whole FIR call graph.

The [sealed proof](evidence/differential.json) binds the actual failed
3,509-source whole compilation and its source inventory. The bounded JVM
observer executes the complete pinned configuration class and the exact pure
PSI getter on real `CompilerConfiguration`, `KtLightSourceElement` and
`FirImportImpl` objects. Carrier fixtures implement the actual IntelliJ
interfaces. It checks Klib non-cached/skip-bodies/serialization settings and PSI
null for real, fake-kind and absent LightTree sources. It does not execute the
complete storage class or claim a Wasm FIR storage runtime. Six integrity tests
cover preserved bytes, changed source/configuration/cache/getter bodies,
additional source-family and facade consumers, entry drift, predecessor pins,
mutable final output and imports. Full compiler and public language readiness
remain false.

Reproduction (fresh output):

```sh
node --test producer/kotlin-browser/compiler-port/fir-storage-source-profile/prepare.test.mjs
node producer/kotlin-browser/compiler-port/fir-storage-source-profile/probe.mjs out/kotlin-storage-profile-proof-unique
```
