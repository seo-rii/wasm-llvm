import assert from 'node:assert/strict';
import test from 'node:test';
import { units, cases, requiredCounts } from './weakref-fixtures.mjs';

const byId = new Map(units.map(unit => [unit.id, unit]));

test('complete weak-link matrix has unique units and explicit runtime or linker outcomes', () => {
  assert.equal(byId.size, 232);
  assert.equal(new Set(cases.map(fixture => fixture.id)).size, 528);
  assert.deepEqual(requiredCounts, { units: 232, cases: 528, runtimePasses: 480, linkRejections: 48 });
  assert.equal(cases.filter(fixture => fixture.expectedLinkRejection).length, 48);
  assert.equal(cases.filter(fixture => !fixture.expectedLinkRejection).length, 480);
  assert.equal(new Set(cases.flatMap(fixture => fixture.units)).size, units.length);
  for (const fixture of cases) {
    assert(fixture.units.every(id => byId.has(id)));
    assert.equal(fixture.stdin, '3\n');
    if (fixture.expectedLinkRejection) {
      assert.equal(fixture.stdout, null);
      assert.equal(fixture.requiredLinkDiagnostics.length, 2);
      assert(fixture.requiredLinkDiagnostics.every(value => /^(undefined|duplicate) symbol: /.test(value)));
    } else assert.equal(typeof fixture.stdout, 'string');
  }
});

test('ordinary weak and weakref consumers cover all three use sites and absent or mixed providers', () => {
  const consumers = units.filter(unit => unit.suite === 'core' && /^weak(ref)?-/.test(unit.profile));
  assert.equal(consumers.length, 48);
  for (const consumer of consumers) {
    const uses = cases.filter(fixture => fixture.units[0] === consumer.id);
    assert.equal(uses.length, 3);
    assert(uses.some(fixture => fixture.units.length === 1 && fixture.stdout === '0 0 -1 -1\n'));
    assert.deepEqual(new Set(uses.filter(fixture => fixture.units.length === 2)
      .map(fixture => byId.get(fixture.units[1]).compiler)), new Set(['gcc', 'clang']));
    assert(consumer.code.includes('volatile observed_f'));
    assert(consumer.code.includes('volatile observed_d'));
  }
});

test('strong overrides weak definitions for every compiler pair in both object orders', () => {
  const overrides = cases.filter(fixture => fixture.id.includes('-override-'));
  assert.equal(overrides.length, 64);
  for (const fixture of overrides) {
    assert.equal(fixture.stdout, '1 1 104 203\n');
    const providers = fixture.units.slice(1).map(id => byId.get(id));
    assert.deepEqual(providers.map(unit => unit.expectedMetadata.binding),
      fixture.id.endsWith('weak-first') ? ['weak', 'global'] : ['global', 'weak']);
    assert(providers.every(unit => !unit.expectedMetadata.undefined));
  }
});

test('strong encounter orders, weak-only declarations, unused refs and same-unit definitions remain distinct', () => {
  for (const unit of units.filter(unit => !unit.provider && unit.suite === 'boundaries')) {
    const expected = unit.expectedMetadata;
    if (['strong-first', 'weak-first'].includes(unit.profile)) {
      assert.equal(expected.binding, 'global');
      assert(cases.some(fixture => fixture.units[0] === unit.id && fixture.expectedLinkRejection));
    }
    if (unit.profile === 'declared-target-weak-only') assert.equal(expected.binding, 'weak');
    if (unit.profile === 'unused-weakrefs') assert.equal(expected.unused, true);
    if (unit.profile.startsWith('definition-')) {
      assert.equal(expected.undefined, false);
      assert.equal(expected.binding, 'global');
      assert(cases.some(fixture => fixture.units[0] === unit.id && fixture.units.length === 1
        && fixture.stdout === '1 1 14 23\n'));
    }
  }
});

test('defined-target local aliases are limited to the eight same-unit GCC consumers', () => {
  const local = units.filter(unit => unit.expectedLocalAliases.length);
  assert.equal(local.length, 8);
  for (const unit of local) {
    assert.equal(unit.compiler, 'gcc');
    assert.equal(unit.provider, false);
    assert.equal(unit.expectedMetadata.undefined, false);
    assert(['definition-before', 'definition-after'].includes(unit.profile));
    assert.deepEqual(unit.expectedLocalAliases, [{ name: 'ref_f', target: 'optf' }, { name: 'ref_d', target: 'optd' }]);
  }
});

test('named targets preserve distinct integer and double prototypes and explicit assembly names', () => {
  const overloads = units.filter(unit => unit.profile.includes('cpp-mangled-overloads'));
  assert.equal(overloads.length, 12);
  for (const unit of overloads) {
    assert.equal(unit.language, 'cpp');
    assert.deepEqual(unit.expectedMetadata.functions._ZN8Optional6targetEd, { params: ['f64'], results: ['f64'] });
    assert.deepEqual(unit.expectedMetadata.functions._ZN8Optional6targetEi, { params: ['i32'], results: ['i32'] });
  }
  for (const unit of units.filter(unit => !unit.provider && unit.profile.startsWith('asm-'))) {
    assert(unit.expectedMetadata.targets.includes('custom.optional.function'));
    assert(unit.forbiddenAliasNames.includes('custom.ref.function'));
    assert(unit.forbiddenAliasNames.includes('custom.ref.storage'));
  }
});

test('GNU consumers use real standard-library operations and both provider families', () => {
  const consumers = units.filter(unit => unit.gnuHeaders);
  assert.equal(consumers.length, 4);
  assert.equal(cases.filter(fixture => fixture.runtime === 'gnu').length, 12);
  for (const unit of consumers) {
    assert.equal(unit.compiler, 'gcc');
    assert(unit.code.includes('std::vector<int>'));
    assert(unit.code.includes('std::to_string'));
    const uses = cases.filter(fixture => fixture.units[0] === unit.id);
    assert.equal(uses.length, 3);
    assert(uses.every(fixture => fixture.stdout.startsWith('7 weak-3 ')));
  }
});
