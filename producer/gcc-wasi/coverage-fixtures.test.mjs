import assert from 'node:assert/strict';
import test from 'node:test';
import { units, cases, metadataControls, diagnostics, requiredCounts } from './coverage-fixtures.mjs';

test('coverage matrix binds unique original units, independent counts and all run modes', () => {
  assert.deepEqual({ units: units.length, cases: cases.length,
    coverage: cases.filter(value => value.mode === 'coverage').length,
    controls: cases.filter(value => value.mode === 'normal').length,
    nativeExecutions: cases.reduce((total, value) => total + value.runs, 0),
    profileExecutions: cases.filter(value => value.mode === 'coverage').reduce((total, value) => total + value.runs, 0),
    metadataControls: metadataControls.length, diagnostics: diagnostics.length }, requiredCounts);
  for (const values of [units, cases, metadataControls, diagnostics])
    assert.equal(new Set(values.map(value => value.id)).size, values.length);
  for (const value of cases) {
    assert.equal(value.expected.length, value.units.length);
    assert(value.units.every(id => units.some(unit => unit.id === id)));
    assert.equal(value.request.coverage, value.mode === 'coverage');
    if (value.scenario === 'multiple') assert.deepEqual(value.units.map(id =>
      units.find(unit => unit.id === id).gcovStem), ['program', 'program.1']);
  }
});
test('plain controls compile the exact same source as coverage without injected dump calls', () => {
  for (const value of cases.filter(value => value.mode === 'normal')) {
    const covered = cases.find(other => other.id === value.id.replace(/-normal$/, '-coverage'));
    assert(covered); assert.equal(value.request.code, covered.request.code);
    assert.deepEqual(value.request.files, covered.request.files);
  }
  assert(units.every(unit => !/__gcov|__cyg_profile/.test(unit.code)));
  for (const language of ['c', 'cpp']) for (const optimization of ['0', '2'])
    assert(cases.some(value => value.language === language && value.optimization === optimization
      && value.scenario === 'core' && value.mode === 'coverage' && value.runs === 2));
});
