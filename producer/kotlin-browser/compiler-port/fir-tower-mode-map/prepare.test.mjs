import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { actualPredecessor } from './fixture.mjs';
import { prepareFirTowerModeMap, verifyFirTowerModeMapFinalSources, verifyPsiPredecessor } from './prepare.mjs';
import { TARGET, TARGETS, MODES, transformTowerModeMap } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
test('actual post-PSI selection, complete one-file inverse and fail-closed tower guards', async t => {
  const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
  const selectionBytes = await readRegular(path.join(here, 'selection.lock.json'));
  const toolInputs = [];
  for (const filename of new Set(['prepare.test.mjs', 'sources.lock.json',
    ...lock.dependencies.map(pin => pin.path)].map(name => path.resolve(here, name)))) {
    const bytes = await readRegular(filename); toolInputs.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const before = await actualPredecessor();
  await mkdir(path.join(repository, 'out/fir-tower-mode-map'), { recursive: true });
  const parent = await mkdtemp(path.join(repository, 'out/fir-tower-mode-map/guard-fixture-'));
  const prepared = await prepareFirTowerModeMap({ ...before, outputRoot: path.join(parent, 'tower') });
  const after = prepared.receipt.files[0].after;
  const actual = before.retainedSources.map(row => structuredClone(row.path === TARGET ? after : row));
  const options = { sourceRoot: before.sourceRoot, outputRoot: prepared.outputRoot,
    expectedReceiptSha256: prepared.receiptSha256, recordedPropertyImports: before.recordedPropertyImports };
  const verify = retainedSources => verifyFirTowerModeMapFinalSources({ ...options, retainedSources });
  const result = await verify(actual);
  await t.test('all 3571 rows roundtrip into the unchanged PSI final verifier', async () => {
    assert.deepEqual(result.predecessorRetainedSources, before.retainedSources);
    for (const [index, row] of result.predecessorRetainedSources.entries()) {
      assert.deepEqual(Object.keys(row), Object.keys(before.retainedSources[index]));
    }
    assert.deepEqual(result.receipt.previousPsiFinalReceipt, before.receipt.firLightTreePsiViewsFinalReceipt);
    assert.deepEqual(prepared.replacedOriginalPaths, TARGETS);
    assert.deepEqual(prepared.sourceSetExclusions, []); assert.deepEqual(prepared.receipt.addedSources, []);
    assert.equal(result.receipt.actualSelectedSources, 3571); assert.equal(result.receipt.jvmSignatureSources, 18);
    assert.equal(actual.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
    assert.deepEqual(MODES, ['REGULAR', 'NESTED_CLASS', 'COMPANION_BLOCK', 'COMPANION_OBJECT', 'CONSTRUCTOR_HEADER', 'ENUM_ENTRY']);
    const bytes = await readRegular(after.filename), prior = before.retainedSources.find(row => row.path === TARGET);
    assert.deepEqual(transformTowerModeMap(TARGET, bytes, { reverse: true }), await readRegular(prior.filename));
    assert.equal(actual.filter((row, i) => row.filename !== before.retainedSources[i].filename).length, 1);
  });
  const rejected = [];
  async function rejects(name, rows, reason) {
    await t.test(name, async () => { await assert.rejects(() => verify(rows), reason); rejected.push(name); });
  }
  await rejects('partial selection rejected', actual.slice(1), /Complete 3571-source/);
  await rejects('JVM signature island cannot be removed', actual.filter(row => !row.path.startsWith('compiler-port-jvm-descriptor-signatures/')), /Complete 3571-source/);
  const reordered = structuredClone(actual); [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await rejects('source order preserved', reordered, /selection or order/);
  const extra = structuredClone(actual); extra.push(structuredClone(actual[0]));
  await rejects('extra source rejected', extra, /Complete 3571-source/);
  const absentMetadata = structuredClone(actual); delete absentMetadata[0].compile;
  await rejects('complete metadata required', absentMetadata, /metadata and key order/);
  const extraMetadata = structuredClone(actual); extraMetadata[0].owner = 'invented';
  await rejects('extra metadata rejected', extraMetadata, /metadata and key order/);
  const keyOrder = structuredClone(actual); keyOrder[0] = { filename: keyOrder[0].filename, path: keyOrder[0].path,
    bytes: keyOrder[0].bytes, sha256: keyOrder[0].sha256, compile: true };
  await rejects('metadata key order preserved', keyOrder, /metadata and key order/);
  const inactive = structuredClone(actual); inactive[0].compile = false;
  await rejects('inactive compiler source rejected', inactive, /Inactive tower/);
  const duplicate = structuredClone(actual); duplicate[1].filename = duplicate[0].filename;
  await rejects('duplicate physical owner rejected', duplicate, /Duplicate tower/);
  const wrongDigest = structuredClone(actual); wrongDigest.at(-1).sha256 = '0'.repeat(64);
  await rejects('last-row source digest remains pinned', wrongDigest, /Actual tower source body changed/);
  const aliasRows = structuredClone(actual), alias = aliasRows.find(row => row.path === TARGET);
  alias.filename = path.join(parent, 'aliased-tower.kt');
  await writeFile(alias.filename, await readRegular(after.filename), { flag: 'wx', mode: 0o600 });
  await rejects('same-byte target alias owner rejected', aliasRows, /Noncanonical tower source owner/);
  async function mutation(name, from, to, { updateMetadata = true } = {}) {
    const rows = structuredClone(actual), row = rows.find(row => row.path === TARGET), original = await readRegular(row.filename);
    const text = original.toString(); assert(text.includes(from), name);
    const changed = Buffer.from(text.replace(from, to));
    try {
      await writeFile(row.filename, changed);
      if (updateMetadata) { row.bytes = changed.length; row.sha256 = sha256(changed); }
      await rejects(name, rows, /Actual tower source body changed|Selected tower source bytes changed/);
    } finally { await writeFile(row.filename, original); }
  }
  await mutation('private map cannot escape', 'private val modeMap:', 'val modeMap:');
  await mutation('new map enumeration rejected', 'get() = modeMap[activeMode]', 'get() = modeMap.values.firstOrNull()');
  await mutation('nullable map value contract cannot narrow', 'MutableMap<FirTowerDataMode, FirTowerDataContext?>', 'MutableMap<FirTowerDataMode, FirTowerDataContext>');
  await mutation('six-mode population remains complete', 'modeMap[FirTowerDataMode.ENUM_ENTRY] = forEnumEntries', '// dropped ENUM_ENTRY');
  await mutation('companion object and block entries cannot be exchanged',
    'modeMap[FirTowerDataMode.COMPANION_OBJECT] = forCompanionObject', 'modeMap[FirTowerDataMode.COMPANION_BLOCK] = forCompanionObject');
  await mutation('replacement map copies the prior values', 'modeMap.putAll(this.modeMap)', '// removed copy');
  await mutation('mode switch shares the original map',
    'FirRegularTowerDataContexts(modeMap, primaryConstructorPureParametersScope, primaryConstructorAllParametersScope, newMode)',
    'FirRegularTowerDataContexts(modeMap.toMutableMap(), primaryConstructorPureParametersScope, primaryConstructorAllParametersScope, newMode)');
  await mutation('same mode returns this', 'if (newMode == activeMode) return this', '// lost same-mode identity');
  await mutation('scope forwarding cannot be exchanged',
    'return FirRegularTowerDataContexts(modeMap, primaryConstructorPureParametersScope, primaryConstructorAllParametersScope, activeMode)',
    'return FirRegularTowerDataContexts(modeMap, primaryConstructorAllParametersScope, primaryConstructorPureParametersScope, activeMode)');
  await mutation('companion block keeps its original regular-only construction',
    'FirRegularTowerDataContexts(regular = it)', 'replaceAndSetActiveRegularContext(it)');
  await mutation('missing companion block returns this', '} ?: this', '} ?: FirRegularTowerDataContexts(regular = currentContext!!)');
  await mutation('new Java imports rejected', 'import org.jetbrains.kotlin.fir.scopes.impl.FirLocalScope',
    'import org.jetbrains.kotlin.fir.scopes.impl.FirLocalScope\nimport java.util.*');
  await mutation('actual file bytes reopened even with unchanged metadata', 'get() = modeMap[activeMode]', 'get() = null', { updateMetadata: false });
  await t.test('changed raw original rejected before preparation', async () => {
    const sourceRoot = path.join(parent, 'changed-original'), filename = path.join(sourceRoot, TARGET);
    const original = await readRegular(path.join(before.sourceRoot, TARGET));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, Buffer.from(original.toString().replace('private val modeMap:', 'val modeMap:')), { flag: 'wx', mode: 0o600 });
    await assert.rejects(() => prepareFirTowerModeMap({ ...before, sourceRoot, outputRoot: path.join(parent, 'rejected-original') }), /Pinned source content mismatch/);
    rejected.push('changed raw original rejected');
  });
  await t.test('previous PSI receipt and source-root identity stay bound', async () => {
    await assert.rejects(() => prepareFirTowerModeMap({ ...before, outputRoot: path.join(parent, 'rejected-psi'),
      preparedPsiViewsProfile: { ...before.preparedPsiViewsProfile, expectedReceiptSha256: '0'.repeat(64) } }), /Previous PSI receipt changed/);
    await assert.rejects(() => prepareFirTowerModeMap({ ...before, outputRoot: path.join(parent, 'rejected-psi-source'),
      preparedPsiViewsProfile: { ...before.preparedPsiViewsProfile, sourceRoot: path.join(parent, 'foreign-source') } }));
    rejected.push('previous PSI receipt and source-root identity stay bound');
  });
  await t.test('foreign PSI module owner cannot be selected', async () => {
    await assert.rejects(() => verifyPsiPredecessor({ ...before.preparedPsiViewsProfile,
      outputRoot: '/tmp/unqualified-psi/out/build/components/firLightTreePsiViewsReceipt', retainedSources: before.retainedSources,
      recordedPropertyImports: before.recordedPropertyImports, psiSourceLockSha256: lock.psiSourceLockSha256 }), /Only the exact qualified historical PSI output owner/);
    rejected.push('foreign PSI module owner rejected');
  });
  await t.test('tower receipt cannot change even with a caller-updated digest', async () => {
    const bytes = await readRegular(prepared.receiptPath, 32 * 1024 * 1024), changed = JSON.parse(bytes);
    changed.mapPrivateAndUnenumerated = false;
    const changedBytes = Buffer.from(JSON.stringify(changed, null, 2) + '\n');
    try {
      await writeFile(prepared.receiptPath, changedBytes);
      await assert.rejects(() => verify(actual), /Tower preparation receipt changed/);
      await assert.rejects(() => verifyFirTowerModeMapFinalSources({ ...options,
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
  await writeFile(guardReceipt, JSON.stringify({ schemaVersion: 1, kind: 'fir-tower-mode-map-source-mutation-guards',
    cases: rejected.map(name => ({ name, rejected: true })), restoredSourceState: true, actualSources: actual.length,
    sourceLockSha256: sha256(lockBytes), selectionLockSha256: sha256(selectionBytes), toolInputs, toolInputsUnchanged: true,
    exactPreviousPsiInverse: true, replacedSources: 1, addedSources: 0, excludedSources: 0, jvmSignatureSources: 18,
    fullFirToIrWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ guardReceipt, rejected: rejected.length, sources: actual.length }));
});
