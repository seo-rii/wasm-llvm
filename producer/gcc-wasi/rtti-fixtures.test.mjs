import assert from 'node:assert/strict';
import test from 'node:test';
import { units, cases, diagnostics, exceptionBoundaries, requiredCounts, profiles } from './rtti-fixtures.mjs';

test('matrix has unique safe identities and complete referenced units', () => {
  assert.deepEqual({ units: units.length, cases: cases.length,
    runtimePasses: cases.filter(value => !value.expectedLinkRejection).length,
    linkRejections: cases.filter(value => value.expectedLinkRejection).length,
    exceptionBoundaries: exceptionBoundaries.length, diagnostics: diagnostics.length }, requiredCounts);
  for (const entries of [units, cases, diagnostics, exceptionBoundaries]) {
    assert.equal(new Set(entries.map(value => value.id)).size, entries.length);
    assert(entries.every(value => /^[a-zA-Z0-9:-]+$/.test(value.id)));
  }
  const ids = new Set(units.map(unit => unit.id)), used = new Set();
  for (const value of [...cases, ...exceptionBoundaries]) for (const id of value.units) { assert(ids.has(id)); used.add(id); }
  assert.deepEqual([...used].sort(), [...ids].sort());
});
test('every hierarchy compares all compiler pairings at both optimizations and runtime inputs', () => {
  for (const profile of profiles) for (const optimization of [0, 2]) for (const provider of ['gcc', 'clang'])
    for (const consumer of ['gcc', 'clang']) {
      const prefix = `${profile.id}:O${optimization}:${provider}-provider:${consumer}-consumer:`;
      const selected = cases.filter(value => value.id.startsWith(prefix));
      if (profile.id === 'gnu-base' && provider === 'clang') {
        assert.equal(selected.length, 1); assert(selected[0].expectedLinkRejection);
        assert(selected[0].requiredLinkDiagnostics.includes('function signature mismatch: _ZNSt9exceptionD2Ev'));
      } else {
        assert.deepEqual(selected.map(value => ({ stdin: value.stdin, stdout: value.stdout })), profile.inputs);
        assert(selected.every(value => !value.expectedLinkRejection));
      }
    }
});
test('inline typeinfo is shared across three TUs and every compiler requires weak definitions', () => {
  const selected = units.filter(unit => unit.profile === 'weak-typeinfo');
  assert.equal(selected.length, 12);
  for (const unit of selected) {
    const names = unit.expectedRttiSymbols.filter(symbol => /^_ZT[IS]/.test(symbol.name));
    assert.equal(names.length, 6);
    assert(names.every(symbol => symbol.binding === 'weak' && !symbol.undefined));
  }
  assert(cases.filter(value => value.profile === 'weak-typeinfo').every(value => value.units.length === 3));
});
test('native flag omission and explicit disabled profiles are distinct', () => {
  for (const compiler of ['gcc', 'clang']) for (const optimization of [0, 2])
    assert.deepEqual(units.filter(unit => unit.suite === 'frontend-profile' && unit.compiler === compiler
      && unit.optimization === optimization).map(unit => unit.rtti), ['enabled', 'disabled', 'default']);
  assert(units.filter(unit => unit.language === 'c').every(unit => unit.rtti === 'none' && unit.runtime === 'c'));
});
test('exception failures remain unexecuted boundaries and disabled expressions must be rejected', () => {
  const ids = new Set(exceptionBoundaries.flatMap(value => value.units));
  assert(cases.every(value => value.units.every(id => !ids.has(id))));
  assert(exceptionBoundaries.every(value => value.execution.startsWith('not executed:')));
  assert(diagnostics.every(value => value.rtti === 'disabled' && value.requiredDiagnostics.length === 2));
});
