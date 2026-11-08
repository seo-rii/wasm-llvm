import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { actualPredecessor } from './fixture.mjs';
import { prepareOfficialMainEntry, verifyOfficialMainEntryFinalSources, verifyTowerPredecessor } from './prepare.mjs';
import { TARGET, TARGETS, RECIPE, OFFICIAL_LINKAGE, OFFICIAL_PHASE_TAIL, transformOfficialMainEntry } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
test('actual 1250-diagnostic predecessor, full entry inverse and fail-closed composition guards', async t => {
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
  const selectionBytes = await readRegular(path.join(here, 'selection.lock.json'));
  const toolInputs = [];
  for (const filename of new Set(['prepare.test.mjs', 'sources.lock.json',
    ...lock.dependencies.map(pin => pin.path)].map(name => path.resolve(here, name)))) {
    const bytes = await readRegular(filename); toolInputs.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const before = await actualPredecessor();
  await mkdir(path.join(repository, 'out/official-main-entry'), { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(path.join(repository, 'out/official-main-entry/guard-fixture-'));
  const prepared = await prepareOfficialMainEntry({ ...before, outputRoot: path.join(parent, 'entry') });
  const after = prepared.receipt.files[0].after;
  const actual = before.retainedSources.map(row => structuredClone(row.path === TARGET ? after : row));
  const options = { sourceRoot: before.sourceRoot, outputRoot: prepared.outputRoot,
    expectedReceiptSha256: prepared.receiptSha256, recordedPropertyImports: before.recordedPropertyImports };
  const verify = retainedSources => verifyOfficialMainEntryFinalSources({ ...options, retainedSources });
  const result = await verify(actual);
  const targetBytes = await readRegular(after.filename), originalTarget = before.retainedSources.find(row => row.path === TARGET);
  await t.test('complete 3571 rows inverse into unchanged tower, PSI and exception guards', async () => {
    assert.deepEqual(result.predecessorRetainedSources, before.retainedSources);
    for (const [index, row] of result.predecessorRetainedSources.entries()) {
      assert.deepEqual(Object.keys(row), Object.keys(before.retainedSources[index]));
    }
    assert.deepEqual(result.receipt.previousTowerFinalReceipt, before.receipt.firTowerModeMapFinalReceipt);
    assert.deepEqual(prepared.replacedOriginalPaths, TARGETS);
    assert.deepEqual(prepared.sourceSetExclusions, []); assert.deepEqual(prepared.receipt.addedSources, []);
    assert.equal(result.receipt.actualSelectedSources, 3571); assert.equal(result.receipt.jvmSignatureSources, 18);
    assert.equal(actual.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
    assert.deepEqual(transformOfficialMainEntry(TARGET, targetBytes, { reverse: true }), await readRegular(originalTarget.filename));
    assert.equal(actual.filter((row, i) => row.filename !== before.retainedSources[i].filename).length, 1);
    assert.equal(result.receipt.fullCompilerBuilt, false); assert.equal(result.receipt.publicLanguageSupport, false);
  });
  await t.test('entry delegates to unchanged official phases and preserves the request exception scope', async () => {
    const incoming = (await readRegular(originalTarget.filename)).toString(), outgoing = targetBytes.toString();
    for (const span of [OFFICIAL_LINKAGE, OFFICIAL_PHASE_TAIL]) {
      assert.equal(incoming.split(span).length, 2); assert.equal(outgoing.split(span).length, 2);
    }
    assert(outgoing.includes(OFFICIAL_LINKAGE + OFFICIAL_PHASE_TAIL));
    for (const token of ['JsMainFunctionDetector', 'KotlinEntryRejected', 'CONSOLE_ENTRY_COUNT', 'CONSOLE_ENTRY_SIGNATURE']) {
      assert(!outgoing.includes(token));
    }
    const host = '        withCompilerExceptionHost(compilerExceptionHost) {\n        withDescriptorDebugHost(descriptorDebugHost) {';
    assert(incoming.includes(host)); assert(outgoing.includes(host));
    assert.equal(prepared.commonSources.length, 1); assert.equal(prepared.commonSources[0], after.filename);
    const raw = verifyFile(await readRegular(path.resolve(here, lock.rawTemplate.path)), lock.rawTemplate);
    assert(raw.toString().includes('CONSOLE_ENTRY_SIGNATURE'), 'Historical template stays unchanged');
    assert.deepEqual(await readRegular(path.join(prepared.outputRoot, 'raw-template', TARGET)), raw);
  });
  const rejected = [];
  async function rejects(name, rows, reason) {
    await t.test(name, async () => { await assert.rejects(() => verify(rows), reason); rejected.push(name); });
  }
  await rejects('partial selection rejected', actual.slice(1), /Complete 3571-source/);
  await rejects('signature island cannot be removed', actual.filter(row => !row.path.startsWith('compiler-port-jvm-descriptor-signatures/')), /Complete 3571-source/);
  const reordered = structuredClone(actual); [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await rejects('source order preserved', reordered, /selection or order/);
  await rejects('extra source rejected', [...structuredClone(actual), structuredClone(actual[0])], /Complete 3571-source/);
  const missing = structuredClone(actual); delete missing[0].compile;
  await rejects('complete metadata required', missing, /metadata and key order/);
  const extra = structuredClone(actual); extra[0].owner = 'invented';
  await rejects('extra metadata rejected', extra, /metadata and key order/);
  const keyOrder = structuredClone(actual); keyOrder[0] = { filename: keyOrder[0].filename, path: keyOrder[0].path,
    bytes: keyOrder[0].bytes, sha256: keyOrder[0].sha256, compile: true };
  await rejects('metadata key order preserved', keyOrder, /metadata and key order/);
  const inactive = structuredClone(actual); inactive[0].compile = false;
  await rejects('inactive compiler source rejected', inactive, /Inactive official main/);
  const duplicate = structuredClone(actual); duplicate[1].filename = duplicate[0].filename;
  await rejects('duplicate physical owner rejected', duplicate, /Duplicate official main/);
  const wrongDigest = structuredClone(actual); wrongDigest.at(-1).sha256 = '0'.repeat(64);
  await rejects('unrelated last-row source digest pinned', wrongDigest, /Actual official main source body changed/);
  const oldEntry = actual.map(row => structuredClone(row.path === TARGET ? originalTarget : row));
  await rejects('raw previous gated entry cannot remain in actual compiler inputs', oldEntry, /Noncanonical official main source owner/);
  const aliasRows = structuredClone(actual), alias = aliasRows.find(row => row.path === TARGET);
  alias.filename = path.join(parent, 'aliased-entry.kt');
  await writeFile(alias.filename, targetBytes, { flag: 'wx', mode: 0o600 });
  await rejects('same-byte target alias owner rejected', aliasRows, /Noncanonical official main source owner/);
  async function mutation(name, from, to, { updateMetadata = true } = {}) {
    const rows = structuredClone(actual), row = rows.find(row => row.path === TARGET), original = await readRegular(row.filename);
    const text = original.toString(); assert(text.includes(from), name);
    const changed = Buffer.from(text.replace(from, to));
    try {
      await writeFile(row.filename, changed);
      if (updateMetadata) { row.bytes = changed.length; row.sha256 = sha256(changed); }
      await rejects(name, rows, /Actual official main source body changed|Selected official main source bytes changed/);
    } finally { await writeFile(row.filename, original); }
  }
  await mutation('official lowering cannot be skipped',
    'compileToLoweredIr(configuration, linker, modules, context)', 'loweredPlaceholder()');
  await mutation('official DCE cannot be removed',
    'if (configuration.dce) eliminateDeadDeclarations(lowered.loweredIr, context, DceDumpNameCache())', '// skipped DCE');
  await mutation('official linked-program conversion cannot be replaced',
    'compileWholeProgramModeToWasmIr(configuration, factory, lowered)', 'handwrittenProgram()');
  await mutation('actual program binary export preserved',
    'writeBrowserProgramBinary(wasmIr, maximumArtifactBytes)', 'emptyProgramBinary()');
  await mutation('official dependency graph retained',
    'val modules = dependencies.allDependencies', 'val modules = listOf(loadedIr.module)');
  await mutation('linker postprocess order retained',
    'linker.postProcess(loadedIr.bultins, inOrAfterLinkageStep = true)', 'linker.postProcess(loadedIr.bultins, inOrAfterLinkageStep = false)');
  await mutation('whole-program mode retained', 'configuration.wasmDisableCrossFileOptimisations = false', 'configuration.wasmDisableCrossFileOptimisations = true');
  await mutation('complete official FIR metadata retained', 'firOutputs = frontend.output.outputs,', 'firOutputs = emptyList(),');
  await mutation('request exception host cannot be removed', 'withCompilerExceptionHost(compilerExceptionHost)', 'run');
  await mutation('request source content cannot be replaced', 'it.first.getContentsAsText()', '"fun main() {}"');
  await mutation('custom main-count restriction cannot be reintroduced',
    RECIPE[2].after, '        require(loadedIr.module.files.size == 1)\n' + RECIPE[2].after);
  await mutation('custom signature restriction cannot be reintroduced',
    RECIPE[2].after, '        require(entries.single().parameters.isEmpty())\n' + RECIPE[2].after);
  await mutation('actual file bytes reopened with unchanged caller metadata',
    'return artifact', 'return emptyProgramBinary()', { updateMetadata: false });
  await t.test('exact transform rejects phase drift and wrong target without relying on a row digest', () => {
    assert.throws(() => transformOfficialMainEntry('compiler-port-entry/Other.kt', targetBytes, { reverse: true }), /only the complete production entry/);
    assert.throws(() => transformOfficialMainEntry(TARGET, Buffer.from(targetBytes.toString().replace('if (configuration.dce)', 'if (false)')),
      { reverse: true }), /official linkage\/lowering\/DCE\/link\/export span changed/);
    const original = transformOfficialMainEntry(TARGET, targetBytes, { reverse: true });
    assert.throws(() => transformOfficialMainEntry(TARGET, Buffer.from(original.toString().replace('entries.size != 1', 'entries.size > 1'))),
      /Exact official-main transform span changed/);
    rejected.push('transform phase, target and removed gate drift rejected');
  });
  await t.test('recorded imports cannot be changed', async () => {
    await assert.rejects(() => verifyOfficialMainEntryFinalSources({ ...options, retainedSources: actual,
      recordedPropertyImports: [...before.recordedPropertyImports, 'invented.entry.main'] }));
    rejected.push('recorded imports changed');
  });
  await t.test('previous tower receipt and source root stay bound', async () => {
    await assert.rejects(() => prepareOfficialMainEntry({ ...before, outputRoot: path.join(parent, 'rejected-tower'),
      preparedTowerModeMapProfile: { ...before.preparedTowerModeMapProfile, expectedReceiptSha256: '0'.repeat(64) } }), /Previous tower receipt changed/);
    await assert.rejects(() => prepareOfficialMainEntry({ ...before, outputRoot: path.join(parent, 'rejected-tower-source'),
      preparedTowerModeMapProfile: { ...before.preparedTowerModeMapProfile, sourceRoot: path.join(parent, 'foreign-source') } }));
    rejected.push('previous tower receipt and source root stay bound');
  });
  await t.test('foreign historical tower module cannot be selected', async () => {
    await assert.rejects(() => verifyTowerPredecessor({ ...before.preparedTowerModeMapProfile,
      outputRoot: '/tmp/unqualified-tower/out/build/components/firTowerModeMapReceipt', retainedSources: before.retainedSources,
      recordedPropertyImports: before.recordedPropertyImports, towerSourceLockSha256: lock.towerSourceLockSha256 }),
    /Only the exact qualified historical tower output owner/);
    rejected.push('foreign historical tower owner rejected');
  });
  await t.test('canonical predecessor snapshot is reopened', async () => {
    const filename = path.join(prepared.outputRoot, 'predecessor', TARGET), bytes = await readRegular(filename);
    try {
      await writeFile(filename, Buffer.from(bytes.toString().replace('val detector =', 'var detector =')));
      await assert.rejects(() => verify(actual), /Official main predecessor snapshot changed/);
      rejected.push('predecessor snapshot mutation rejected');
    } finally { await writeFile(filename, bytes); }
  });
  await t.test('entry receipt cannot change even with a caller-updated digest', async () => {
    const bytes = await readRegular(prepared.receiptPath, 32 * 1024 * 1024), changed = JSON.parse(bytes);
    changed.officialPhaseBodiesAndOrderPreserved = false;
    const changedBytes = Buffer.from(JSON.stringify(changed, null, 2) + '\n');
    try {
      await writeFile(prepared.receiptPath, changedBytes);
      await assert.rejects(() => verify(actual), /Official main preparation receipt changed/);
      await assert.rejects(() => verifyOfficialMainEntryFinalSources({ ...options,
        expectedReceiptSha256: sha256(changedBytes), retainedSources: actual }));
      rejected.push('changed preparation receipt rejected');
    } finally { await writeFile(prepared.receiptPath, bytes); }
  });
  await verify(actual);
  for (const pin of toolInputs) {
    const bytes = await readRegular(pin.filename);
    assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, { bytes: pin.bytes, sha256: pin.sha256 });
  }
  const guardReceipt = path.join(parent, 'guards.json');
  await writeFile(guardReceipt, JSON.stringify({ schemaVersion: 1, kind: 'official-main-entry-source-mutation-guards',
    cases: rejected.map(name => ({ name, rejected: true })), restoredSourceState: true, actualSources: actual.length,
    sourceLockSha256: sha256(lockBytes), selectionLockSha256: sha256(selectionBytes), toolInputs, toolInputsUnchanged: true,
    exactPreviousTowerInverse: true, replacedSources: 1, addedSources: 0, excludedSources: 0, jvmSignatureSources: 18,
    baselineDiagnosticCount: 1250, officialPhaseBodiesAndOrderPreserved: true, existingRequestExceptionHostPreserved: true,
    rawHistoricalTemplateUnchanged: true, handwrittenEntrySelectorOrWrapperAdded: false,
    compilerExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ guardReceipt, rejected: rejected.length, sources: actual.length }));
});
