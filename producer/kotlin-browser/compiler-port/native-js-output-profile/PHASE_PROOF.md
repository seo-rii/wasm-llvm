# Current phase composition proof

Use the current read-only evidence verifier:

```sh
node producer/kotlin-browser/compiler-port/native-js-output-profile/verify-phase.mjs
```

The current focused proof used the exact 3,550-source roster from the failed
whole preparation, whose compiler command list is empty. It checked all six
current phase outputs, the two overlapping JS/Wasm callers, all 21 native
boundaries and four existing splits. Three positive checks and 13 negatives
passed. Every rejection matched its intended reason, and all mutations used
private outputs or supplied row metadata. The actual historical files were
rehash-checked before and after execution and remained unchanged.

The recorded early native receipt was reinspected with current tools and exact
old-tool lineage. Its original selection semantics were verified unchanged.
This does not claim fresh whole preparation, IR execution, compiler execution,
or browser language readiness. The existing module proof binds the same actual
complete roster used by the positive native guard.

The original `evidence/receipt.json` and `evidence/integrity.json` remain
byte-for-byte historical evidence for the 3,525-source, 37-negative-check run.
The original `verify.mjs` command shown in `README.md` verifies that historical
source snapshot and intentionally rejects changed current shipping bytes.
It is not the current proof command. `verify-phase.mjs` checks the legacy proof
against its exact archived 11-file native unit, including the original nine
unit pins, and verifies all old execution artifacts and evidence. It then
verifies the separately sealed current proof against current shipping inputs.
No fresh 37-check execution or backward compatibility of the old CLI is claimed.

The old snapshot and both execution lineages are pinned in
`evidence/phase-composition-execution.json`; the current focused observations
are in `evidence/phase-composition.json`.
