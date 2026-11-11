import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile, rename, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { readCommonDequeInputs, inspectCommonDequeApiSelection } from './prepare.mjs';
import { TARGETS, RECIPES, transformCommonDequeApi, PARTIAL_LINKAGE, INCORPORATOR, TYPE_CHECKER } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const fixturePath = process.env.KOTLIN_COMMON_DEQUE_BASELINE ?? path.join(repository, 'out/continue-20261111/support/baseline-selection.json');
const originalRoot = process.env.KOTLIN_COMMON_DEQUE_SOURCE_ROOT ?? path.join(repository, 'out/kotlin-compiler-port/sources');

test('six complete official source adaptations retain exact inverses and the full selected graph', async t => {
  const input = await readCommonDequeInputs(), fixture = JSON.parse(await readRegular(fixturePath, 4 * 1024 * 1024));
  const before = fixture.retainedSources, priorBuildRoot = fixture.buildRoot ?? fixture.baselineRoot;
  const outputParent = path.join(repository, 'out/common-deque-api'); await mkdir(outputParent, { recursive: true });
  const outputRoot = await mkdtemp(path.join(outputParent, 'guards-'));
  const beforeOptions = { phase: 'before', outputRoot, priorBuildRoot }, afterOptions = { ...beforeOptions, phase: 'after' };
  await inspectCommonDequeApiSelection(before, input, beforeOptions);
  const replacements = new Map(), originals = new Map(), guardCases = [];
  for (const logical of TARGETS) {
    const pin = input.lock.files.find(row => row.path === logical), row = before.find(row => row.path === logical);
    const raw = verifyFile(await readRegular(path.join(originalRoot, logical)), pin.original);
    const predecessor = await readRegular(row.filename), transformed = transformCommonDequeApi(logical, predecessor);
    originals.set(logical, predecessor);
    const filename = path.join(outputRoot, logical); await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, transformed, { flag: 'wx', mode: 0o600 });
    replacements.set(logical, { ...row, filename, bytes: transformed.length, sha256: sha256(transformed) });
    await t.test('complete raw and assembled inverse: ' + logical, () => {
      const rawOutgoing = transformCommonDequeApi(logical, raw);
      assert.deepEqual(transformCommonDequeApi(logical, rawOutgoing, { reverse: true }), raw);
      assert.deepEqual(transformCommonDequeApi(logical, transformed, { reverse: true }), predecessor);
      assert.deepEqual({ bytes: transformed.length, sha256: sha256(transformed) },
        { bytes: pin.outgoing.bytes, sha256: pin.outgoing.sha256 });
      assert(transformed.includes(Buffer.from('import kotlin.collections.ArrayDeque\n')));
    });
  }
  const actual = before.map(row => structuredClone(replacements.get(row.path) ?? row));
  const verify = rows => inspectCommonDequeApiSelection(rows, input, afterOptions);
  const final = await verify(actual);
  await t.test('all 3571 sources and 18 JVM signature sources stay ordered and active', () => {
    assert.equal(final.sources.length, 3571); assert.equal(final.jvmSignatureSources, 18);
    assert.deepEqual(final.replacedPaths, TARGETS);
    const originalRows = new Map(before.map(row => [row.path, row]));
    const inverseRows = actual.map(row => TARGETS.includes(row.path) ? structuredClone(originalRows.get(row.path)) : row);
    assert.deepEqual(inverseRows, before);
    assert.equal(actual.filter((row, index) => row.filename !== before[index].filename).length, 6);
    assert.deepEqual(input.lock.sourceSetExclusions, []); assert.deepEqual(input.lock.addedSources, []);
    assert.equal(input.lock.userSourceRewritten, false); assert.equal(input.lock.fullCompilerBuilt, false);
  });
  await t.test('mixed head and tail traversal and the nullable nonlocal-return context remain explicit', async () => {
    for (const [logical, span] of [[INCORPORATOR, 'stack.add(projectedType.getArgument(argumentIndex))'],
      [TYPE_CHECKER, 'deque.add(newType)']]) {
      const outgoing = (await readRegular(replacements.get(logical).filename)).toString();
      assert(originals.get(logical).toString().includes(span)); assert(outgoing.includes(span));
    }
    const outgoing = (await readRegular(replacements.get(PARTIAL_LINKAGE).filename)).toString();
    assert(outgoing.includes('stack.firstOrNull()!!.scheduleForRemoval(this)'));
    assert(outgoing.includes('stack.firstOrNull() ?: ReturnTargetContext.Empty'));
    assert(outgoing.includes('if (newContext !== oldContext) assert(stack.removeFirst() == newContext)'));
  });
  async function rejects(name, rows, reason) {
    await t.test(name, async () => { await assert.rejects(() => verify(rows), reason); guardCases.push(name); });
  }
  await rejects('missing source rejected', actual.slice(1), /Complete 3571-source/);
  await rejects('signature-source removal rejected', actual.filter(row => !row.path.startsWith('compiler-port-jvm-descriptor-signatures/')), /Complete 3571-source/);
  await rejects('additional source rejected', [...actual, actual[0]], /Complete 3571-source/);
  const reversed = structuredClone(actual); [reversed[0], reversed[1]] = [reversed[1], reversed[0]];
  await rejects('source reordering rejected', reversed, /selection or order/);
  const missing = structuredClone(actual); delete missing[0].compile;
  await rejects('missing metadata rejected', missing, /metadata and key order/);
  const extra = structuredClone(actual); extra[0].waiver = true;
  await rejects('invented metadata rejected', extra, /metadata and key order/);
  const keyOrder = structuredClone(actual), first = keyOrder[0];
  keyOrder[0] = { filename: first.filename, path: first.path, bytes: first.bytes, sha256: first.sha256, compile: first.compile };
  await rejects('metadata key order drift rejected', keyOrder, /metadata and key order/);
  const inactive = structuredClone(actual); inactive[0].compile = false;
  await rejects('inactive source rejected', inactive, /Inactive common deque/);
  const duplicates = structuredClone(actual); duplicates[1].filename = duplicates[0].filename;
  await rejects('duplicate owner rejected', duplicates, /Duplicate common deque/);
  const unrelatedHash = structuredClone(actual); unrelatedHash.at(-1).sha256 = '0'.repeat(64);
  await rejects('unrelated final-row source digest pinned', unrelatedHash, /source body changed/);
  const oldTarget = structuredClone(actual), firstTargetIndex = oldTarget.findIndex(row => row.path === TARGETS[0]);
  oldTarget[firstTargetIndex] = structuredClone(before.find(row => row.path === TARGETS[0]));
  await rejects('old JVM deque source cannot remain selected', oldTarget, /Noncanonical common deque/);
  const alias = structuredClone(actual); alias[firstTargetIndex].filename = path.join(outputRoot, 'alias.kt');
  await writeFile(alias[firstTargetIndex].filename, await readRegular(actual[firstTargetIndex].filename), { flag: 'wx', mode: 0o600 });
  await rejects('same-byte alias owner rejected', alias, /Noncanonical common deque/);
  for (const logical of TARGETS) {
    const row = replacements.get(logical), original = await readRegular(row.filename);
    const changed = Buffer.from(original.toString().replace('import kotlin.collections.ArrayDeque', 'import kotlin.collections.ArrayList'));
    try {
      await writeFile(row.filename, changed);
      await rejects('actual selected bytes reopened: ' + logical, actual, /Selected common deque source bytes changed/);
      const updated = structuredClone(actual), target = updated.find(row => row.path === logical);
      target.bytes = changed.length; target.sha256 = sha256(changed);
      await rejects('caller-updated digest cannot bless changed source: ' + logical, updated, /Actual common deque source body changed/);
    } finally { await writeFile(row.filename, original); }
  }
  await t.test('symlink selected source rejected before following it', async () => {
    const row = replacements.get(TARGETS[0]), backup = row.filename + '.original';
    await rename(row.filename, backup);
    try {
      await symlink(backup, row.filename);
      await assert.rejects(() => verify(actual), /Symlink paths are not accepted/);
      guardCases.push('selected source symlink rejected');
    } finally { await unlink(row.filename); await rename(backup, row.filename); }
  });
  await t.test('wrong target, duplicate spans and partially applied transformations rejected', () => {
    const logical = TARGETS[0], original = originals.get(logical), recipe = RECIPES.find(row => row.path === logical);
    assert.throws(() => transformCommonDequeApi('user/Main.kt', original), /six complete compiler sources/);
    const span = recipe.changes[1].before;
    assert.throws(() => transformCommonDequeApi(logical, Buffer.from(original.toString() + '\n' + span)), /span\/count changed/);
    const partiallyApplied = original.toString().replace(recipe.changes[0].before, recipe.changes[0].after);
    assert.throws(() => transformCommonDequeApi(logical, Buffer.from(partiallyApplied)), /span\/count changed/);
    guardCases.push('wrong target, duplicate spans and partial adaptation rejected');
  });
  await t.test('foreign output owners rejected', async () => {
    await assert.rejects(() => inspectCommonDequeApiSelection(actual, input, { ...afterOptions, outputRoot: '/tmp/common-deque-foreign' }), /canonical owner/);
    await assert.rejects(() => inspectCommonDequeApiSelection(actual, input, { ...afterOptions, priorBuildRoot: '/tmp/common-deque-foreign' }), /canonical owner/);
    guardCases.push('foreign output owners rejected');
  });
  await verify(actual); await inspectCommonDequeApiSelection(before, input, beforeOptions);
  const finalInputs = await readCommonDequeInputs(); assert.deepEqual(finalInputs.lockBytes, input.lockBytes);
  const guardReceipt = path.join(outputRoot, 'guards.json');
  await writeFile(guardReceipt, JSON.stringify({ schemaVersion: 1, kind: 'common-deque-api-source-guards',
    sourceLockSha256: sha256(input.lockBytes), baselineSelectionSha256: input.lock.selection.sha256,
    cases: guardCases.map(name => ({ name, rejected: true })), actualSelectedSources: 3571,
    jvmSignatureSources: 18, replacedSources: 6, addedSources: 0, excludedSources: 0,
    baselineFilesUnmodified: true, mutationSourcesRestored: true, allSelectedBytesReopened: true,
    completeSixSourceInverse: true, originalSourceRoot: originalRoot, baselineFixture: fixturePath,
    predecessorProductionGuardsExecuted: false, compilerExecuted: false,
    fullCompilerBuilt: false, publicLanguageSupport: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ guardReceipt, rejected: guardCases.length, sources: actual.length }));
});
