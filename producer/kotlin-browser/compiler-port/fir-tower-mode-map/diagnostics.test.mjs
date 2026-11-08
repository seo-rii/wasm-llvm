import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { EXPECTED_TOWER_DIAGNOSTICS, qualifyTowerDiagnostics } from './diagnostics.mjs';
import { TARGET } from './transform.mjs';

// Synthetic unit data exercises the gate only; it is not an actual compiler result.
function fixture() {
  const baselineSources = Array.from({ length: 3571 }, (_, index) => {
    const path = index === 17 ? TARGET : 'unit-source/' + index + '.kt';
    const bytes = Buffer.from('unit source ' + index);
    return { path, filename: '/unit-baseline/' + path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const currentSources = baselineSources.map(row => ({ ...row, filename: '/unit-current/' + row.path }));
  const changed = Buffer.from('unit replacement tower source');
  Object.assign(currentSources[17], { bytes: changed.length, sha256: sha256(changed) });
  const current = Array.from({ length: 1250 }, (_, index) => ({
    source: baselineSources[index + 100].path, line: index + 1, column: 9, message: "unresolved reference 'Unit" + index + "'.",
  }));
  // A duplicate in both inventories must remain a duplicate, not become a set.
  current[current.length - 1] = { ...current[0] };
  const baseline = [...structuredClone(current), ...Array.from({ length: 12 }, (_, index) => ({
    source: TARGET, line: index + 85, column: 8, message: "unresolved reference 'EnumMap' unit " + index,
  }))];
  return { baseline, current, baselineSources, currentSources };
}

test('fixed tower diagnostic qualification accepts only the exact synthetic unit delta', () => {
  assert.deepEqual(EXPECTED_TOWER_DIAGNOSTICS, {
    sources: 3571, baselineTotal: 1262, currentTotal: 1250, baselineTarget: 12, currentTarget: 0,
  });
  assert(Object.isFrozen(EXPECTED_TOWER_DIAGNOSTICS));
  const input = fixture(), saved = structuredClone(input), result = qualifyTowerDiagnostics(input);
  assert.deepEqual(input, saved, 'Pure qualification must not change its inputs');
  assert.equal(result.baselineTotal, 1262); assert.equal(result.currentTotal, 1250);
  assert.equal(result.baselineProfileEntries.length, 12); assert.deepEqual(result.currentProfileEntries, []);
  assert.equal(result.unchangedSourceCount, 3570); assert.equal(result.otherDiagnosticMultisetUnchanged, true);
  assert.deepEqual(result.newOtherDiagnosticEntries, []); assert.deepEqual(result.removedOtherDiagnosticEntries, []);
  assert.deepEqual(result.diagnosticWaivers, []);
});

test('diagnostic emission order may change while exact multiplicity is retained', () => {
  const input = fixture(); input.current.reverse();
  assert.equal(qualifyTowerDiagnostics(input).otherDiagnosticMultisetUnchanged, true);
});

const cases = [
  ['new other message at an existing position', value => { value.current[1].message = 'new unsupported operation'; }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['extra other diagnostic', value => { value.current.push({ ...value.current[1], message: 'additional failure' }); }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['duplicate replacing a different diagnostic with total unchanged', value => { value.current[1] = { ...value.current[0] }; }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['duplicate diagnostic appended', value => { value.current.push({ ...value.current[0] }); }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['other diagnostic moved to another source', value => { value.current[1].source = value.current[2].source; }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['other diagnostic moved to another line', value => { value.current[1].line++; }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['other diagnostic moved to another column', value => { value.current[1].column++; }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['other diagnostic disappeared', value => { value.current.splice(1, 1); }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['one of two identical diagnostics disappeared', value => { value.current.pop(); }, /diagnostic source\/line\/column\/message\/multiplicity changed/],
  ['tower diagnostic remains despite unchanged total', value => { value.current[1] = { ...value.baseline.at(-1) }; }, /zero remaining diagnostics/],
  ['baseline has fewer tower diagnostics despite unchanged total', value => { value.baseline[value.baseline.length - 1] = { ...value.baseline[1] }; }, /exactly 12 baseline tower/],
  ['baseline total changed', value => { value.baseline.pop(); }, /exactly 1262 baseline/],
  ['other source byte changed without changing length', value => {
    const changed = Buffer.from('Unit source 0');
    assert.equal(changed.length, value.currentSources[0].bytes);
    value.currentSources[0].sha256 = sha256(changed);
  }, /Untouched diagnostic source bytes changed/],
  ['other source byte length changed', value => { value.currentSources[0].bytes++; }, /Untouched diagnostic source bytes changed/],
  ['compiler source order changed', value => { [value.currentSources[0], value.currentSources[1]] = [value.currentSources[1], value.currentSources[0]]; }, /source selection\/order changed/],
  ['compiler source omitted', value => { value.currentSources.pop(); }, /retain all 3571/],
  ['duplicate logical source with distinct physical owners', value => {
    for (const rows of [value.baselineSources, value.currentSources]) rows[1].path = rows[0].path;
  }, /duplicate logical source/],
  ['duplicate compiler owner', value => { value.currentSources[1].filename = value.currentSources[0].filename; }, /duplicate compiler owner/],
  ['relative compiler owner', value => { value.currentSources[0].filename = 'relative.kt'; }, /canonical absolute compiler owners/],
  ['tower source removed from both inventories', value => {
    for (const rows of [value.baselineSources, value.currentSources]) rows[17].path = 'unit-source/not-the-tower.kt';
  }, /select the complete tower source/],
  ['unchanged tower source cannot qualify a new diagnostic reduction', value => {
    value.currentSources[17].bytes = value.baselineSources[17].bytes;
    value.currentSources[17].sha256 = value.baselineSources[17].sha256;
  }, /Tower source was not replaced/],
  ['diagnostic attributed to an unselected source', value => { value.current[1].source = 'not-selected.kt'; }, /unselected source/],
  ['invalid diagnostic position', value => { value.current[1].column = 0; }, /invalid position/],
  ['invalid source hash', value => { value.currentSources[0].sha256 = 'not-a-sha256'; }, /invalid source identity/],
];
for (const [name, mutate, reason] of cases) test('rejects ' + name, () => {
  const input = fixture(); mutate(input); assert.throws(() => qualifyTowerDiagnostics(input), reason);
});
