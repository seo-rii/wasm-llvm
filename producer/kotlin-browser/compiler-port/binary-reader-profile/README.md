# Emit-only Wasm binary reader source profile

The browser compiler emits a fresh wasmWasi program and rebuilds it fully. It
does not consume an input Wasm binary or deserialize incremental Wasm caches.
The complete original `WasmBinaryToIR.kt` is retained as a pinned reference,
while this profile excludes that one file from compilation only after verifying
every actual selected Kotlin input, including prepared sources and browser entry.

At the selected Kotlin revision, its four exported declarations are
`WasmBinaryToIR`, `MyByteReader`, `twoByteOpcodes` and `ByteReader`. Their only
external primary-source consumer is the incremental `WasmDeserializer` already
excluded by the whole-program backend profile. This profile rejects that
deserializer if it is selected again. It also rejects any exported reader name
in another selected source, including qualified imports, aliases, wildcard use,
comments and strings. The guard is conservative and may require review of an
unrelated name; it is not a resolved compiler call graph or a complete Gradle
variant closure.

No reader algorithm or success stub replaces the original. The source inventory,
every source byte, and the complete original reader are retained in the prepared
output. A compressed source snapshot allows independent receipt verification
after subsequent source composition. Changes to source pins, snapshots, exported
references, exclusion flags or readiness claims invalidate the receipt.

```js
const component = await prepareBinaryReaderProfile({
  sourceRoot, outputRoot,
  retainedSources: selectedInputs.map(({ path, filename, bytes, sha256 }) =>
    ({ path, filename, bytes, sha256 })),
});
await verifyBinaryReaderProfile(dirname(component.receiptPath));
// Disable component.sourceSetExclusions in the final compiler source map.
```

Compose this profile after all source ports and browser entries. Run its focused
guards with `node --test producer/kotlin-browser/compiler-port/binary-reader-profile/prepare.test.mjs`.
The guard tests and a recorded real selected-source scan establish this source
selection only. They do not establish a compiler KLIB, callable compiler binary,
fresh browser compilation or public Kotlin support.

The [executed source scan](evidence/source-scan.json) records six passing guards
and every one of the 3,445 actual source inputs from an exited compiler attempt,
including its browser entry and prepared variants. That compiler attempt failed
before this profile was introduced; its exit status is retained and is not
relabeled as a compiler pass. The independently replayed selection and receipt
verification exited 0. `probe.mjs` reproduces the scan with `--source-root`,
`--frozen-build-root` and a fresh `--output` directory under repository `out/`.
