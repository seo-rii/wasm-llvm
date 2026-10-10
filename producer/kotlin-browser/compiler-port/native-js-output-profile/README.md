# One-file native JavaScript output source profile

This component excludes only pinned `CompilationOutputs.kt` from the existing
full-rebuild Wasm source selection. Its entire original file stays verbatim as a
non-compiling reference: seven top-level declarations and 50 member/local headers.
No filesystem, replacement compiler class or runtime algorithm is implemented.

The existing backend profile's 21 exclusions and four declaration splits stay
unchanged. Early inputs must contain the original target and four pristine,
canonically owned split outputs. Both 3,417 pinned primary sources and the actual
selected graph are checked for incoming references. The original inventory has
12 conservative edges, all in already excluded or split native JS/IC code; the
retained primary graph has none.

The late guard reads the actual post-assembly source list and reruns closure for
both this target and the prior excluded/split declarations. It rejects new
consumers, reintroduced classes/files, duplicate logical/physical sources,
symlinks, missing split keys/boundaries, changed receipts and changed source bytes.
Required boundaries total **21**: the existing 19 (including nine Wasm-used JS
lowerings), plus genuine WebArtifactConfiguration and TypeScript printer sources.
Their early bytes are verified against primary pins, including the original
JsIrProgramFragment before serializer/comment/module transformations.

Twenty late boundary owners remain exact. Only the exact recorded assembly
import prefix blocks may be removed for comparison; raw string blank lines and
all other bytes remain significant. EnumClassLowering additionally permits its
one pinned PRIVATE→Companion.PRIVATE import binding. The fragment's later owner
must be the canonical module component with its exact sealed output and helper;
`verifiedModuleBoundary.final` must be the already verified module reconstruction
and bind every path, filename, byte count and SHA in the same actual graph. It is
not a blanket exception for a filename or body change. The four split logical
keys remain; later proven components may own their genuine implementations, so
actual bindings and closure are checked instead of stale original filenames.

The reference reader conservatively scans raw text and a Kotlin lexical spelling
view: qualified names, package/import aliases, wildcard/member imports, tabs, form-feed,
indentation, semicolon directives, backtick identifiers, spaced dots, nested
comments and executable string interpolation. Comments and strings are retained
as conservative edges. This is not resolved IR, complete reflection analysis,
Gradle closure, native JS output support or an accepted complete browser compiler.

The proof uses the completed **failed** 3,525-input compiler assembly, rebuilds
and strictly verifies the genuine backend/profile, and reconstructs early primary
boundaries in private copies. After early verification it installs actual late
bytes and the independently sealed genuine module/comment ancestry. The added
module helper and removed target leave 3,525 final inputs. Four comment owner
grafts require exact canonical bytes before ownership rebinding. No prior proof
file is modified. The module late guard is executed on this whole selected map.

The corrected integrity sweep has 37 mutations, each matched to its intended
failure reason, separate write-once final outputs, zero skips, and a restored
positive final pass. Earlier positive evidence and the initial failed guard run
are preserved with their original tool snapshot. That initial negative run is
explicitly invalidated: an output EEXIST collision could be counted by its generic
rejection helper, so its partial rejection results prove no guards. The current
sweep also covers legal lexical spellings, raw-string blank-line mutation and
actual module-owner/proof mismatch. Four generic assertion categories additionally check the exact mutated target
values, and private mutation restoration covers setup failures. An intermediate
positive check was stopped at 194.11 s before these known corrections; its code
snapshot and exit -15 remain separate evidence. No JVM/Wasm runtime differential is claimed
for this source-selection-only unit.

```js
const options = { sourceRoot, outputRoot, preparedBackendProfile, retainedSources };
const component = await prepareNativeJsOutputProfile(options);
await verifyNativeJsOutputProfile({ ...options, receiptPath: component.receiptPath });
// Retain the exact verified component object until assembly completes.
const final = await verifyNativeJsOutputFinalSources({
  ...options, receiptPath: component.receiptPath, preparedProfile: component,
  retainedSources: actualFinalSelectedSources, allowedAddedImports,
  verifiedModuleBoundary: { outputRoot: moduleOptions.outputRoot, final: moduleFinal },
});
```

`commonSources` is empty and `sourceSetExclusions` contains only the target's key.
Prepare immediately after backendProfile; execute the late guard after the
module final guard and all host bindings. A repeated diagnostic call must choose
a new nested `finalOutputRoot`; receipts use write-once outputs deliberately.

```sh
node producer/kotlin-browser/compiler-port/native-js-output-profile/probe.mjs
node producer/kotlin-browser/compiler-port/native-js-output-profile/guards.mjs
node producer/kotlin-browser/compiler-port/native-js-output-profile/verify.mjs
```

Sealed evidence binds final logs/statuses, every generated artifact, unit bytes,
actual assembly/module references and the explicitly invalid historical run.
Filesystem, readiness, new runtime execution and complete compiler flags are false.
