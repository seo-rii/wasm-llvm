import assert from 'node:assert/strict';
import path from 'node:path';
import { readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { readPsiDiagnosticBuild } from '../fir-lighttree-psi-views/diagnostics.mjs';
import { TARGET } from './transform.mjs';

// Declared before compilation. Removing the artificial entry gate must preserve
// every compiler-port diagnostic; this change does not fix those diagnostics.
export const EXPECTED_MAIN_DIAGNOSTICS = Object.freeze({
  sources: 3571, baselineTotal: 1250, currentTotal: 1250, baselineTarget: 0, currentTarget: 0,
});
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const sourceIdentity = row => ({ bytes: row.bytes, sha256: row.sha256 });
const exactKey = row => JSON.stringify([row.source, row.line, row.column, row.message]);

function validateSources(rows, label) {
  assert(Array.isArray(rows), label + ' sources must be an array');
  assert.equal(rows.length, EXPECTED_MAIN_DIAGNOSTICS.sources, label + ' must retain all 3571 compiler sources');
  const logical = new Set(), owners = new Set();
  for (const row of rows) {
    relativePath(row.path);
    assert(!logical.has(row.path), label + ' contains a duplicate logical source: ' + row.path);
    logical.add(row.path);
    assert(typeof row.filename === 'string' && path.isAbsolute(row.filename) && row.filename === path.resolve(row.filename),
      label + ' requires canonical absolute compiler owners');
    assert(!owners.has(row.filename), label + ' contains a duplicate compiler owner: ' + row.filename);
    owners.add(row.filename);
    assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256 ?? ''),
      label + ' contains an invalid source identity: ' + row.path);
  }
  assert(logical.has(TARGET), label + ' must select the complete production entry');
  return logical;
}

function validateEntries(rows, sources, label) {
  assert(Array.isArray(rows), label + ' diagnostics must be an array');
  for (const row of rows) {
    assert(row.source === '<compiler>' || sources.has(row.source), label + ' diagnostic has an unselected source: ' + row.source);
    assert(Number.isSafeInteger(row.line) && Number.isSafeInteger(row.column) &&
      (row.source === '<compiler>' ? row.line === 0 && row.column === 0 : row.line > 0 && row.column > 0),
    label + ' diagnostic has an invalid position');
    assert(typeof row.message === 'string' && row.message.length > 0, label + ' diagnostic requires an exact message');
  }
}

function additions(before, after) {
  const remaining = new Map(), added = [];
  for (const row of before) { const key = exactKey(row); remaining.set(key, (remaining.get(key) ?? 0) + 1); }
  for (const row of after) {
    const key = exactKey(row), count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1); else added.push(row);
  }
  return added;
}

/** Pure comparison of authenticated inventories; compareMainDiagnostics also reopens every actual source. */
export function qualifyMainDiagnostics({ baseline, current, baselineSources, currentSources }) {
  const beforePaths = validateSources(baselineSources, 'Baseline'), afterPaths = validateSources(currentSources, 'Current');
  for (const [index, row] of currentSources.entries()) {
    const prior = baselineSources[index];
    assert.equal(row.path, prior.path, 'Complete source selection/order changed at row ' + index);
    if (row.path !== TARGET) assert.deepEqual(sourceIdentity(row), sourceIdentity(prior),
      'Untouched diagnostic source bytes changed: ' + row.path);
    else assert.notDeepEqual(sourceIdentity(row), sourceIdentity(prior), 'Production entry was not replaced');
  }
  validateEntries(baseline, beforePaths, 'Baseline'); validateEntries(current, afterPaths, 'Current');
  const baselineProfileEntries = baseline.filter(row => row.source === TARGET);
  const currentProfileEntries = current.filter(row => row.source === TARGET);
  assert.equal(baseline.length, EXPECTED_MAIN_DIAGNOSTICS.baselineTotal, 'Expected exactly 1250 baseline diagnostics');
  assert.equal(baselineProfileEntries.length, EXPECTED_MAIN_DIAGNOSTICS.baselineTarget, 'Expected zero baseline entry diagnostics');
  assert.equal(currentProfileEntries.length, EXPECTED_MAIN_DIAGNOSTICS.currentTarget, 'Production entry must have zero diagnostics');
  const beforeOther = baseline.filter(row => row.source !== TARGET), afterOther = current.filter(row => row.source !== TARGET);
  const newOtherDiagnosticEntries = additions(beforeOther, afterOther), removedOtherDiagnosticEntries = additions(afterOther, beforeOther);
  assert(newOtherDiagnosticEntries.length === 0 && removedOtherDiagnosticEntries.length === 0,
    'Unchanged-source diagnostic source/line/column/message/multiplicity changed: ' + JSON.stringify({
      addedCount: newOtherDiagnosticEntries.length, removedCount: removedOtherDiagnosticEntries.length,
      added: newOtherDiagnosticEntries.slice(0, 5), removed: removedOtherDiagnosticEntries.slice(0, 5),
    }));
  assert.equal(current.length, EXPECTED_MAIN_DIAGNOSTICS.currentTotal, 'Expected exactly 1250 current diagnostics');
  return {
    expected: { ...EXPECTED_MAIN_DIAGNOSTICS }, baselineTotal: baseline.length, currentTotal: current.length,
    baselineProfileEntries, currentProfileEntries, newProfileDiagnosticEntries: [],
    newOtherDiagnosticEntries, removedOtherDiagnosticEntries, unchangedSourceCount: currentSources.length - 1,
    sourceSelectionAndOrderPreserved: true, otherSourceIdentitiesUnchanged: true,
    otherDiagnosticMultisetUnchanged: true, diagnosticWaivers: [],
  };
}

export async function compareMainDiagnostics(currentBuild, currentLog, baselineBuild, baselineLog) {
  // The shared reader requires an actual exit-1 compiler invocation, argument-file SHA,
  // 3571 actual compiler owners, mapped diagnostics and absence of compiler-crash markers.
  const current = await readPsiDiagnosticBuild(currentBuild, currentLog), baseline = await readPsiDiagnosticBuild(baselineBuild, baselineLog);
  const comparison = qualifyMainDiagnostics({ baseline: baseline.entries, current: current.entries,
    baselineSources: baseline.sources, currentSources: current.sources });
  const sourceInputs = [];
  for (let offset = 0; offset < current.sources.length; offset += 12) {
    const batch = await Promise.allSettled(current.sources.slice(offset, offset + 12).map(async (row, index) => {
      const prior = baseline.sources[offset + index], before = await readRegular(prior.filename), after = await readRegular(row.filename);
      const beforeIdentity = identity(before), afterIdentity = identity(after);
      assert.deepEqual(beforeIdentity, sourceIdentity(prior), 'Actual baseline compiler source differs from receipt: ' + prior.path);
      assert.deepEqual(afterIdentity, sourceIdentity(row), 'Actual current compiler source differs from receipt: ' + row.path);
      if (row.path !== TARGET) assert(before.equals(after), 'Actual untouched compiler source bytes changed: ' + row.path);
      return [{ filename: prior.filename, ...beforeIdentity }, { filename: row.filename, ...afterIdentity }];
    }));
    for (const result of batch) {
      if (result.status !== 'fulfilled') throw result.reason;
      sourceInputs.push(...result.value);
    }
  }
  return { kind: 'official-main-entry-exact-diagnostic-comparison', result: 'pass',
    currentBuild, currentLog, baselineBuild, baselineLog,
    inputs: [...baseline.inputs, ...current.inputs, ...sourceInputs],
    buildReceipts: { baseline: baseline.receipt, current: current.receipt }, ...comparison,
    actualSourceFilesReopened: sourceInputs.length, otherSourceBytesIdentical: true,
    comparisonPolicy: 'All 1250 diagnostics retain their logical source, line, column, message and multiplicity. No diagnostic waiver or normalization.',
    interpretation: 'Official entry dispatch replaces the artificial gate. The whole compiler still exits 1 with 1250 diagnostics; this is not a built browser compiler or public Kotlin support.',
  };
}
