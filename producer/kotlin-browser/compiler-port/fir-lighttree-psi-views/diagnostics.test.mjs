import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { readPsiDiagnosticBuild, qualifyPsiDiagnosticDrift, newPsiDiagnostics } from './diagnostics.mjs';
import { TARGETS } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
test('exact five-site diagnostic drift rejects unrelated or changed failures', async t => {
  const lockBytes = await readRegular(path.join(here, 'diagnostic-drift.lock.json')), lock = JSON.parse(lockBytes);
  const toolInputs = [];
  for (const name of ['diagnostics.test.mjs', 'diagnostics.mjs', 'diagnostic-drift.lock.json', 'transform.mjs',
    'sources.lock.json', 'selection.lock.json', '../../scripts/source.mjs']) {
    const filename = path.resolve(here, name), bytes = await readRegular(filename);
    toolInputs.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const previous = JSON.parse(await readRegular(path.join(here, '../compiler-exception-attachment-profile/evidence/current-foundation-v4.json')));
  const launch = JSON.parse(await readRegular(path.join(repository, 'out/fir-psi-next/whole-v1-launch.json')));
  const baseline = await readPsiDiagnosticBuild(previous.build.buildRoot, previous.build.log.filename);
  const current = await readPsiDiagnosticBuild(launch.output, launch.log);
  assert.deepEqual(baseline.receipt, lock.baselineBuildReceipt); assert.deepEqual(current.receipt, lock.currentBuildReceipt);
  const sources = [];
  for (const pin of lock.sources) sources.push({ path: pin.path,
    before: await readRegular(baseline.sources.find(row => row.path === pin.path).filename),
    after: await readRegular(current.sources.find(row => row.path === pin.path).filename) });
  const input = { baseline: baseline.entries, current: current.entries, sources, lock };
  function gate(value) {
    const result = qualifyPsiDiagnosticDrift(value);
    assert.deepEqual(result.unreviewedNewDiagnosticEntries, [], 'Unreviewed diagnostic remains');
    assert.equal(result.reviewedNewDiagnosticEntries.length, 9); return result;
  }
  const accepted = gate(input), cases = [];
  await t.test('actual raw9 remains visible and reviewed9/unreviewed0', () => {
    assert.equal(newPsiDiagnostics(baseline.entries, current.entries).length, 9);
    assert.equal(accepted.messageReplacements, 7); assert.equal(accepted.additionalNullableCascades, 2);
    assert.equal(accepted.removedInferenceCascades, 5);
  });
  async function rejected(name, mutate, reason) {
    await t.test(name, () => {
      const value = { baseline: structuredClone(input.baseline), current: structuredClone(input.current), lock: structuredClone(lock),
        sources: sources.map(row => ({ path: row.path, before: Buffer.from(row.before), after: Buffer.from(row.after) })) };
      mutate(value); assert.throws(() => gate(value), reason); cases.push({ name, rejected: true, reasonMatched: true });
    });
  }
  const first = lock.sites[0], candidate = value => value.current.find(row => row.source === first.source && row.line === first.line && row.column === 35);
  await rejected('additional message at the same site', value => value.current.push({ ...candidate(value), message: 'new unrelated diagnostic' }), /site diagnostic/);
  await rejected('duplicate message multiplicity', value => value.current.push({ ...candidate(value) }), /site diagnostic/);
  await rejected('approved message moved to another line', value => { candidate(value).line++; }, /site diagnostic/);
  await rejected('approved message moved to another column', value => { candidate(value).column++; }, /site diagnostic/);
  await rejected('old PSI failure marker disappeared', value => {
    const site = lock.sites[2]; value.current = value.current.filter(row => !(row.source === site.source &&
      row.line === site.existingPsiFailure.line && row.column === site.existingPsiFailure.column));
  }, /failure marker/);
  await rejected('current source body changed', value => { value.sources[0].after = Buffer.concat([value.sources[0].after, Buffer.from('\n')]); }, /source bytes changed/);
  await rejected('source SHA changed', value => { value.lock.sources[0].sha256 = '0'.repeat(64); }, /source SHA changed/);
  await rejected('reviewed expression changed', value => { value.lock.sites[0].expression += ' changed'; }, /source expression changed/);
  await rejected('receiver expression changed', value => { value.lock.sites[1].receiver.expression = 'differentReceiver'; }, /receiver expression changed/);
  await rejected('baseline multiplicity changed', value => { value.baseline.push({ ...value.baseline.find(row => row.source === first.source && row.line === first.line) }); }, /Baseline site/);
  await rejected('identical message at an additional site', value => { value.current.push({ ...candidate(value), line: first.line + 10 }); }, /Unreviewed diagnostic/);
  await rejected('unmodified non-profile failure moved to another line', value => {
    const prior = new Set(value.baseline.map(row => JSON.stringify(row)));
    const row = value.current.find(row => !TARGETS.includes(row.source) && prior.has(JSON.stringify(row)) &&
      !lock.sites.some(site => site.source === row.source && (site.line === row.line || site.existingPsiFailure.line === row.line)));
    assert(row); row.line += 10000;
  }, /Unreviewed diagnostic/);
  for (const pin of toolInputs) { const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
  const outputRoot = await mkdtemp(path.join(repository, 'out/fir-psi-next/diagnostic-guards-'));
  const receiptPath = path.join(outputRoot, 'guards.json');
  const receipt = { kind: 'fir-psi-diagnostic-drift-guards', result: 'pass', toolInputs, toolInputsUnchanged: true,
    driftLockSha256: sha256(lockBytes), sourceLockSha256: lock.sourceLockSha256,
    buildReceipts: { baseline: baseline.receipt, current: current.receipt }, inputs: [...baseline.inputs, ...current.inputs],
    rawNewOther: 9, reviewed: 9, unreviewed: 0, cases, originalsAndLogsUnmodified: true };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ diagnosticGuardReceipt: receiptPath, negativeCases: cases.length }));
});
