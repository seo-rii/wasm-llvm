import assert from 'node:assert/strict';
import test from 'node:test';
import { units } from './weakref-fixtures.mjs';
import { verifyWeakrefMetadata } from './weakref-inspect.mjs';

function fixture(profile = 'weakref-address', suite = 'core', compiler = 'gcc') {
  return structuredClone(units.find(unit => unit.profile === profile && unit.suite === suite
    && unit.compiler === compiler && unit.optimization === 0));
}
function metadata(unit) {
  const expected = unit.expectedMetadata, global = unit.code.split('int main')[0].includes('volatile observed_f');
  const symbols = expected.unused ? [] : expected.targets.map((name, index) => ({ name,
    kind: expected.functions[name] ? 'function' : 'data', binding: expected.binding,
    undefined: expected.undefined, visibility: unit.expectedVisibility,
    ...(expected.functions[name] ? { entityIndex: index + 2 } : { segment: 0, offset: 0, size: 4 }) }));
  const relocations = unit.provider || expected.unused ? [] : expected.targets.flatMap(name => {
    const functionSymbol = Boolean(expected.functions[name]);
    const pointer = { symbol: name, type: global ? (functionSymbol ? 2 : 5) : (functionSymbol ? 1 : 4) };
    return functionSymbol && unit.profile.endsWith('-direct') ? [pointer, { symbol: name, type: 0 }] : [pointer];
  });
  for (const alias of unit.expectedLocalAliases) {
    symbols.push({ ...symbols.find(symbol => symbol.name === alias.target), name: alias.name, binding: 'local' });
    for (const relocation of relocations) if (relocation.symbol === alias.target) relocation.symbol = alias.name;
  }
  return { inspection: { symbols, relocations }, signatures: structuredClone(expected.functions) };
}
const verify = (unit, value) => verifyWeakrefMetadata(value.inspection, value.signatures, unit);

test('weak function and data imports preserve target names, types and address relocations', () => {
  const unit = fixture(), value = metadata(unit), result = verify(unit, value);
  assert.equal(result.targets.length, 2);
  assert.deepEqual(result.relocations.map(relocation => relocation.type), [1, 4]);
});

test('weak binding, global binding and definition status cannot substitute for each other', () => {
  const unit = fixture();
  for (const field of ['binding', 'undefined']) {
    const value = metadata(unit); value.inspection.symbols[0][field] = field === 'binding' ? 'global' : false;
    assert.throws(() => verify(unit, value), field === 'binding' ? /binding/ : /definition/);
  }
  const provider = fixture('provider-weak', 'core', 'clang'), value = metadata(provider);
  assert.doesNotThrow(() => verify(provider, value));
  value.inspection.symbols[0].visibility = 'default';
  assert.throws(() => verify(provider, value), /visibility/);
});

test('a strong use dominates weakrefs in either encounter order', () => {
  for (const profile of ['strong-first', 'weak-first']) {
    const unit = fixture(profile, 'boundaries'), value = metadata(unit);
    assert.doesNotThrow(() => verify(unit, value));
    value.inspection.symbols[0].binding = 'weak';
    assert.throws(() => verify(unit, value), /binding/);
  }
});

test('same-unit definitions cannot acquire phantom imports, and unused refs cannot acquire symbols', () => {
  const unit = fixture('definition-before', 'boundaries'), value = metadata(unit);
  value.inspection.symbols[1].undefined = true;
  assert.throws(() => verify(unit, value), /definition/);
  const unused = fixture('unused-weakrefs', 'boundaries'), empty = metadata(unused);
  assert.doesNotThrow(() => verify(unused, empty));
  empty.inspection.symbols.push({ name: 'optf' });
  assert.throws(() => verify(unused, empty), /symbol count/);
});

test('weakref aliases cannot survive as ordinary, C++ local or explicitly renamed symbols', () => {
  const unit = fixture(), value = metadata(unit);
  for (const name of ['ref_f', '_ZL5ref_fi']) {
    const bad = structuredClone(value); bad.inspection.symbols.push({ name });
    assert.throws(() => verify(unit, bad), /became a linking symbol/);
  }
  const named = fixture('asm-names', 'boundaries'), bad = metadata(named);
  bad.inspection.symbols.push({ name: 'custom.ref.function' });
  assert.throws(() => verify(named, bad), /became a linking symbol/);
});

test('only GCC same-unit definitions permit local aliases sharing a body and storage', () => {
  for (const profile of ['definition-before', 'definition-after']) {
    const unit = fixture(profile, 'boundaries'), value = metadata(unit), result = verify(unit, value);
    assert.deepEqual(result.localAliases.map(alias => [alias.name, alias.target]), [['ref_f', 'optf'], ['ref_d', 'optd']]);
    // Preserve which linking symbol each actual relocation selected.
    assert.deepEqual(result.relocations.map(relocation => [relocation.symbol, relocation.type]), [['ref_f', 2], ['ref_d', 5]]);
    const clang = fixture(profile, 'boundaries', 'clang'), direct = metadata(clang);
    assert.deepEqual(verify(clang, direct).localAliases, []);
    direct.inspection.symbols.push(value.inspection.symbols.find(symbol => symbol.name === 'ref_f'));
    assert.throws(() => verify(clang, direct), /became a linking symbol/);
  }
});

test('same-unit aliases reject forwarding bodies, separate storage and nonlocal binding', () => {
  const unit = fixture('definition-before', 'boundaries');
  for (const [name, field, replacement, error] of [
    ['ref_f', 'entityIndex', 90, /body\/storage/],
    ['ref_d', 'segment', 1, /body\/storage/],
    ['ref_d', 'offset', 4, /body\/storage/],
    ['ref_d', 'size', 8, /body\/storage/],
    ['ref_f', 'binding', 'weak', /binding/],
    ['ref_d', 'binding', 'global', /binding/],
    ['ref_f', 'undefined', true, /definition/],
    ['ref_d', 'visibility', 'hidden', /visibility/],
    ['ref_f', 'kind', 'data', /kind/],
  ]) {
    const value = metadata(unit); value.inspection.symbols.find(symbol => symbol.name === name)[field] = replacement;
    assert.throws(() => verify(unit, value), error);
  }
  const missing = metadata(unit); missing.inspection.symbols.pop();
  assert.throws(() => verify(unit, missing), /Missing same-unit alias/);
  const badContract = structuredClone(unit); badContract.expectedLocalAliases[0].target = 'unrelated';
  assert.throws(() => verify(badContract, metadata(unit)), /Unexpected alias target/);
});

test('same-unit alias allowance cannot extend to an external optional reference', () => {
  const unit = fixture(), value = metadata(unit);
  unit.expectedLocalAliases = [{ name: 'ref_f', target: 'optf' }];
  assert.throws(() => verify(unit, value), /locally bound GCC definitions/);
});

test('overloaded weak targets retain independent i32 and f64 signatures', () => {
  const unit = fixture('cpp-mangled-overloads', 'boundaries'), value = metadata(unit);
  assert.doesNotThrow(() => verify(unit, value));
  value.signatures._ZN8Optional6targetEd = { params: ['i32'], results: ['i32'] };
  assert.throws(() => verify(unit, value), /signature/);
});

test('direct calls and initialized pointers require their actual relocation classes', () => {
  const direct = fixture('weakref-direct'), value = metadata(direct);
  value.inspection.relocations = value.inspection.relocations.filter(relocation => relocation.type !== 0);
  assert.throws(() => verify(direct, value), /direct-call relocation/);
  const initialized = fixture('weakref-initialized'), bad = metadata(initialized);
  bad.inspection.relocations[0].type = 1;
  assert.throws(() => verify(initialized, bad), /initialized pointer relocation/);
});

test('missing, duplicate or wrong-kind targets and absent data relocations are rejected', () => {
  const unit = fixture();
  let value = metadata(unit); value.inspection.symbols.pop();
  assert.throws(() => verify(unit, value), /symbol count/);
  value = metadata(unit); value.inspection.symbols.push(value.inspection.symbols[0]);
  assert.throws(() => verify(unit, value), /Duplicate linking symbol/);
  value = metadata(unit); value.inspection.symbols[1].kind = 'global';
  assert.throws(() => verify(unit, value), /kind/);
  value = metadata(unit); value.inspection.relocations.pop();
  assert.throws(() => verify(unit, value), /target relocation/);
});
