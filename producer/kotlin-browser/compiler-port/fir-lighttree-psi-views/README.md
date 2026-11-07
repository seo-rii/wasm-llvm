# FIR PSI views for the sealed LightTree source family

The [current foundation evidence](CURRENT_FOUNDATION.md) records the actual
whole compiler attempt, runtime boundaries, exact diagnostic drift, and restore
requirements.

This profile narrows the nullable PSI views used by the selected FIR-to-IR source
to their actual input domain. The selected `KtSourceElement` hierarchy is sealed
and has exactly one implementation, `KtLightSourceElement`; neither PSI source
elements nor PSI line mappings are part of that host.

Five complete upstream files are transformed: `fir/Utils.kt`,
`FirMetadataSource.kt`, `MetadataSource.kt`, `OffsetUtils.kt`, and
`Fir2IrConverter.kt`. No compiler source is added or excluded. The source lock
binds the complete, ordered 3,571-source input from the qualified foundation,
including all 18 JVM signature implementation sources and every physical source
owner. A changed source family, caller body, import, owner, or partial selection
requires a new review and lock update.

The `FirElement` views return `Nothing?` through an exhaustive `when (source)`.
This still evaluates the virtual source getter exactly once and propagates its
failure. Offset conversion retains its two distinct receivers: the local
`KtSourceElement?.psi` view and `FirElement.psi`. The compiled-element predicate
has only the original null input branch. The existing portable `LighterASTNode`
and `TokenSet` declarations are bound to their host and FIR-navigation receipts;
the LightTree keyword, comment, selector, fake-kind, and default-accessor
initializer algorithms remain intact.

File creation still evaluates `file.psi` before choosing the original line-start
mapping and path/name fallback. Synthetic and unsupported origins, IR file
construction and registration retain their original order. Metadata source,
name, constant flag, and symbol forwarding remain unchanged. Descriptor metadata
keeps its existing null views under the narrowed shared interface.

Preparation records the whole predecessor selection and a snapshot of each
changed body. Final verification inverts exactly those five rows, including
their complete metadata and order. The prior exception profile then verifies
that authenticated predecessor, preserving its existing `Utils.kt` exception
and attachment implementation. Earlier component guards receive the composed
inverse; native lexical checks, module reconstruction, and the compiler receive
the actual new selection.

`selection.lock.json` records the authentic earlier compiler receipt and argument
digests. Its actual invocation completed with 1,307 diagnostics. The new whole
invocation uses the same complete input vector after applying the five-file
inverse, the same compiler and library bytes, and equivalent flags. It completed
with 1,262 diagnostics; the five changed files went from 52 to 10. Both compiler
invocations exited 1, so this remains an incomplete compiler build.

Comparison preserves exact message multiplicity. Only the five changed files
may move line numbers; the other 3,566 files also require identical diagnostic
line and column. There are **nine raw new messages outside the profile**, all
at five byte-identical, already-failing PSI expressions in four files. The
reviewed drift comprises seven message replacements and two nullable cascades;
five old inference cascades disappear. Those five expressions therefore go from
26 to 23 diagnostics and remain unsupported. No newly failing expression is
waived, and no compiler source or symbol was changed to match diagnostics.

`diagnostic-drift.lock.json` binds the exact source SHA, expression, receiver,
existing unresolved `KtPsiSourceElement` marker, and complete before/after
diagnostic multiset at each site. The report retains raw new messages and
separately requires reviewed drift **9**, unreviewed new diagnostics **0**.
Additional, duplicate, moved, or changed diagnostics and source changes fail
closed; there is no broad message normalization or ignored line.

Focused source validation:

```sh
node --test producer/kotlin-browser/compiler-port/fir-lighttree-psi-views/prepare.test.mjs
node --test producer/kotlin-browser/compiler-port/fir-lighttree-psi-views/diagnostics.test.mjs
```

Restore the qualified baseline at its recorded absolute source and owner paths
if it is unavailable. `FIR_PSI_BASELINE_BUILD` selects the build root; it does not
relocate or rewrite immutable receipts, argument files, or owner paths.
Tests read that baseline and mutate only fresh outputs
under this worktree's `out/fir-psi-next/` directory. They reject missing sources,
reordered rows, removed JVM inputs, metadata loss, duplicate ownership, and
changes to getter evaluation, offset semantics, file paths, metadata, or the
previous exception implementation.

The separate runtime observer typechecks all five genuine original files on JVM
and compares actual Kotlin FIR/LightTree objects with explicit observation
payloads. It executes pinned method bodies and real file-entry, line-mapping,
tree, and token helpers on original JVM, common JVM, Node Wasm, and an offline
Chromium worker. This establishes **method-boundary agreement**. It does not
execute whole FIR-to-IR lowering, build the complete browser compiler, or enable
public Kotlin language support.
