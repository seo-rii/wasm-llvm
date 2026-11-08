# Official main entry composition

This final source profile removes the private pre-lowering main count and
signature gate from the complete `BrowserCompilerPipeline.kt`. It adds no
entry selector, main wrapper, parser, language translation or execution stub.
The existing official linkage, lowering, DCE, whole-program link and binary
export calls retain their exact bodies and order. Entry selection and wrappers
belong to the pinned upstream phases, including their argument and suspend
handling; this profile does not reproduce those algorithms.

The raw `../entry/BrowserCompilerPipeline.kt` remains an immutable historical
input to earlier source locks and evidence. It still contains the old gate.
The actual final compiler input is the **entire transformed file** produced by
this profile after the existing exception-host, PSI and tower compositions.
The old template is not selected as a second compiler source. The existing
request exception scope and all preceding frontend/KLIB/linker code remain
unchanged.

`selection.lock.json` comes from the qualified post-tower whole compilation:
3,571 ordered sources, including all 18 JVM descriptor signature sources, and
compiler exit 1 with 1,250 diagnostics. Recipe generation authenticates that
build receipt, exact argument vector, diagnostic comparison and committed
qualification before reopening the selected source graph. No compiler source
is added or excluded. Exactly one source owner/body changes; every other row
retains its logical path, owner relative to the build, bytes, digest, active
status and metadata order.

`prepareOfficialMainEntry` consumes the complete retained-source vector and the
previous `preparedTowerModeMapProfile`. Its final verifier reopens every actual
source and snapshot, reverses all three exact deletions in the complete entry,
and returns the entire `predecessorRetainedSources` vector. The unchanged tower,
PSI and exception verifiers receive that restored vector. Current production
outputs use the current pinned predecessor module; the only external module
owner accepted is the exact authenticated historical qualification snapshot.

Regenerate the two locks only against the exact restored predecessor build:

```sh
node producer/kotlin-browser/compiler-port/official-main-entry/update-recipe.mjs /absolute/qualified/tower-build
node --test producer/kotlin-browser/compiler-port/official-main-entry/prepare.test.mjs
```

The source guards reject selection, metadata, owner, byte, import, receipt and
predecessor drift; removal/reordering/replacement of official phases; returning
to the gated entry; and a new private count/signature check. They prove exact
source composition and inversion, not execution of the whole compiler or
language equivalence. Compiler/runtime observations are separate evidence.
The baseline compiler is still incomplete, and this profile alone establishes
neither a built browser compiler nor public Kotlin support. The consumer's
zero-argument Wasm `_start` ABI and the separate request entry metadata contract
are unchanged.
