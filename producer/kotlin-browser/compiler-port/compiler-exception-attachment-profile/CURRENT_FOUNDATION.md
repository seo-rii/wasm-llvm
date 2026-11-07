# Current foundation integration

This qualification keeps the shipping recipe's complete 3,571-source graph,
including all eighteen JVM descriptor/signature sources. The FIR storage guard
recognizes only the six canonical portable `JvmClassName` declaration/use files
through their pinned signature source lock, exact component owner and content.
It still rejects additional facade-island consumers, aliases or changed imports,
wrong owners, and incomplete portable selections. The original storage transform
and its six exact exclusions are unchanged.

The recorded current build completed preparation and invoked the real
`KotlinWasmCompiler` for 109.146 seconds; its exact predecessor control invoked
the same compiler for 99.282 seconds. Both compiler processes exited 1 with no
signal, retaining 3,571 sources and all eighteen signature sources. Error entries
fell from 1,421 to 1,307. Profile/request-entry/helper errors fell from 74 to five
existing FIR PSI errors, with zero new profile errors and zero new errors in other
files. All 6,400 frozen source/cache input files remained unchanged.

The new source snapshot is separate from the earlier failed current-foundation
attempt and the 3,553-source baseline variant. Those records and archives remain
immutable historical evidence. In particular, the historical variant's omitted
eighteen sources are never used to qualify the current foundation.

The current verification entry point is:

```sh
node producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile/verify-current-foundation.mjs
```

The verifier opens `evidence/current-foundation-v4.json`, checks the frozen source
inventory, requires the shipping FIR preparation source and lock to match the
actual new snapshot, and reopens all actual current input files. It replays the
exception inverse, the current FIR storage final guard, and the actual source
graph bindings used by the native lexical and module checks.

The control invocation is produced by `current-foundation-control.mjs CONFIG`.
Its configuration contains the authenticated current `build` descriptor and a
fresh `outputRoot` under that snapshot's `out/`. It uses all 3,571 predecessor rows
returned by the exception inverse, preserving their metadata and order. The
eighteen signature sources remain identical in both selections. Both positional
source arguments and `-Xcommon-sources` are replaced together; the compiler,
classpath, libraries, flags and heap remain the same. Only the destination for
compiler output changes. Both actual compiler subprocesses, their exit results,
arguments, selected bytes and logical diagnostic comparison are retained.

The JVM/common-JVM/Node Wasm and Chromium component measurements are reused only
after verifying their immutable input pins against the unchanged implementations.
They cover 12 raw String records, 57 complete exception records, five genuine
JVM policy cases, eight request-host contracts and three Chromium Module Workers.
They do not execute the complete browser compiler. The new current source guard
probe independently verifies mutations against the actual 3,571-source selection.

Full compiler build and browser compiler execution remain separate claims. A
qualified change with no newly emitted diagnostics can still have pre-existing
whole-compiler errors; `fullCompilerBuilt` and `browserCompilerExecuted` remain
false in this evidence.

Focused checks:

```sh
node --test \
  producer/kotlin-browser/compiler-port/fir-storage-source-profile/entry-bindings.test.mjs \
  producer/kotlin-browser/compiler-port/fir-storage-source-profile/prepare.test.mjs \
  producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile/current-foundation-control.test.mjs
```

Preserve the permanent validation snapshot and its recorded input/output
inventories while this evidence refers to them. Do not overwrite old evidence,
rewrite historical receipts, or remove sources to obtain a passing comparison.
