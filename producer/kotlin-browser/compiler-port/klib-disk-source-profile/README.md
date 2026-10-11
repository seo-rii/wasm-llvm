# Guarded KLIB disk source selection

The completed combined compiler attempt still selected seven filesystem sources
after the genuine KLIB readers, writers, loader, and signature index had acquired
memory hosts. This profile excludes those exact files only after verifying that
the actual selected Kotlin/Java code has no remaining references to their public
or internal declarations:

- `compiler/util-io/.../io/ZipFileSystemUtils.kt`
- `compiler/util-io/.../io/ZipFileSystemAccessor.kt`
- `compiler/util-klib/.../library/KlibLayoutReader.kt`
- `compiler/util-klib/.../library/KlibFormat.kt`
- `compiler/util-klib/.../library/KlibSizeInfo.kt`
- `compiler/util-klib/.../library/impl/KlibMetadataComponentImpl.kt`
- `compiler/ir/serialization.common/.../backend/common/loadMetadataKlibs.kt`

Three reversible spans remove only the ZIP accessor import, configuration key,
and extension property from `KlibConfigurationKeys.kt`. All other configuration
code stays byte-identical, including its existing assembly imports. The eight
complete originals are retained under the preparation output's `original/`.
There is no ZIP implementation, replacement stub, or general filesystem API in
this profile.

The original audit checks all 3,838 pinned Kotlin/Java files, including Java and
other noncompiled primary sources. Their original references remain recorded;
they are not asserted to be absent. The actual prepared selection must have
zero remaining references after the seven exclusions and three config spans.
Checks cover qualified and imported names, aliases, backticks, literal strings,
Unicode escapes, interpolation, and conservatively joined literal names.
Recorded dynamic-loading tokens are an audit aid. Arbitrary runtime-computed
names and a resolved compiler IR call graph are outside this lexical proof.

The checked inventory contains 15 public/internal declarations from the seven
files and two removed configuration symbols. Nine helpers in the original
top-level declaration inventories are private: `expandSymlinks`, `newEntry`,
`DEFAULT_ZERO_FILE_TIMESTAMP`, `collectTopLevelElements`, `entries`,
`cumulativeSize`, `buildElement`, `buildIrElement`, and `normalizeEntryName`.
Their complete original source bytes and declaration inventories are pinned.
They are not treated as callable declarations from other selected files.

Twelve complete memory algorithm boundaries must remain present and match their
existing KLIB/linker/signature-index pins. These include the actual byte readers
and writers, KLIB interfaces/components, memory output/loader/Web entry, and all
three signature-index outputs. The signature-index public final guard also
checks their real owners and assembled bodies. This preserves the required
metadata, IR, serialization, and library algorithms while removing an unused
disk host selection.

```js
const disk = await prepareKlibDiskSourceProfile({
  sourceRoot, outputRoot, retainedSources, preparedKlibSignatureIndex,
  recordedPropertyImports,
});
// Replace exactly disk.commonSources and remove disk.sourceSetExclusions.
// Prepare/remove ServiceLoaderLite next, using the resulting actual graph.
await verifyKlibDiskFinalSources({
  outputRoot: disk.outputRoot,
  expectedReceiptSha256: disk.receiptSha256,
  retainedSources: actualFinalSources,
  serviceLoaderProfile: {
    outputRoot: service.outputRoot,
    expectedReceiptSha256: service.receiptSha256,
  },
});
```

Preparation runs after all other source mutations and before the service-loader
profile. The final guard independently invokes the existing public service
guard, verifies that its input was exactly the disk profile's output graph, and
accepts only that one subsequent deletion. Every other path, physical owner,
byte digest, and position must remain identical. Without a later service
profile, omit `serviceLoaderProfile`; no additional deletion is allowed.
This unit reduces the selected source count by exactly seven.

The proof reconstructs the completed 3,527-source compiler attempt, restores its
historical service-loader source, and applies the genuine signature-index
overlay with recorded assembly imports. The recovered sequence is
3,528 → 3,529 → 3,522 → 3,521 sources. It runs the public preparation/final APIs
and the actual subsequent service profile. This is a focused recovered-source
composition proof, not another full compiler build.

```sh
node producer/kotlin-browser/compiler-port/klib-disk-source-profile/probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output out/kotlin-klib-disk-reproduction \
  --frozen-build-root out/kotlin-compiler-port/builds/disk-retry-whole-1791692102097271136

KOTLIN_KLIB_DISK_FIXTURE=out/kotlin-klib-disk-reproduction/fixture.json \
  node --test producer/kotlin-browser/compiler-port/klib-disk-source-profile/prepare.test.mjs
```

Use private background logs for these operations. The fixture-backed test runs
eight focused public guard rejections and a restored positive final check;
without the fixture, only the small lexical test runs. Evidence records the
actual artifact paths and exit statuses. Full compiler readiness remains false.
