import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRttiMetadata } from './rtti-inspect.mjs';

const fixture = () => ({ forbiddenRtti: false,
  expectedRttiSymbols: [{ name: '_ZTI1D', kind: 'data', binding: 'weak', undefined: false,
    visibility: 'default', relocationTypes: [4, 5] }],
  expectedFunctions: { __dynamic_cast: { params: ['i32', 'i32', 'i32', 'i32'], results: ['i32'] } } });
const object = () => ({ functionDefinitions: 1,
  symbols: [
    { name: '_ZTI1D', kind: 'data', binding: 'weak', visibility: 'default', undefined: false, segment: 0, offset: 0, size: 12 },
    { name: '__dynamic_cast', kind: 'function', binding: 'global', visibility: 'default', undefined: true },
  ], relocations: [{ symbol: '_ZTI1D', type: 4 }, { symbol: '__dynamic_cast', type: 0 }] });
const signatures = { __dynamic_cast: { params: ['i32', 'i32', 'i32', 'i32'], results: ['i32'] } };

test('accepts weak typeinfo with an actual typed dynamic_cast call', () => {
  const result = verifyRttiMetadata(object(), signatures, fixture());
  assert.equal(result.symbols.length, 2); assert.equal(result.relocations.length, 2);
});
test('rejects the pre-fix strong typeinfo definition and wrong definition state', () => {
  for (const changes of [{ binding: 'global' }, { binding: 'common' }, { undefined: true }]) {
    const value = object(); Object.assign(value.symbols[0], changes);
    assert.throws(() => verifyRttiMetadata(value, signatures, fixture()), /_ZTI1D/);
  }
});
test('requires both symbol references and the dynamic_cast ABI', () => {
  const value = object(); value.relocations = [];
  assert.throws(() => verifyRttiMetadata(value, signatures, fixture()), /relocation/);
  assert.throws(() => verifyRttiMetadata(object(), { __dynamic_cast: { params: ['i32'], results: ['i32'] } }, fixture()), /signature/);
});
test('distinguishes disabled RTTI from permitted virtual tables', () => {
  const unit = { forbiddenRtti: true, expectedRttiSymbols: [], expectedFunctions: {} };
  const value = { symbols: [{ name: '_ZTV1D', kind: 'data' }], relocations: [], functionDefinitions: 0 };
  assert.doesNotThrow(() => verifyRttiMetadata(value, {}, unit));
  value.symbols.push({ name: '_ZTI1D', kind: 'data' });
  assert.throws(() => verifyRttiMetadata(value, {}, unit), /RTTI-disabled/);
});
test('preserves ordinary C strong binding independently of one-only symbols', () => {
  const unit = { forbiddenRtti: true, expectedRttiSymbols: [{ name: 'ordinary', kind: 'data', binding: 'global',
    undefined: false, visibility: 'default', relocationTypes: [] }], expectedFunctions: {} };
  const value = { symbols: [{ name: 'ordinary', kind: 'data', binding: 'global', visibility: 'default',
    undefined: false, segment: 0, offset: 0, size: 4 }], relocations: [], functionDefinitions: 0 };
  assert.doesNotThrow(() => verifyRttiMetadata(value, {}, unit));
  value.symbols[0].binding = 'weak';
  assert.throws(() => verifyRttiMetadata(value, {}, unit), /ordinary: binding/);
});
test('checks exception dependency signatures without treating them as executed', () => {
  const unit = { forbiddenRtti: false, expectedRttiSymbols: [], expectedFunctions: {} };
  const value = { symbols: [{ name: '__cxa_bad_typeid' }], relocations: [], functionDefinitions: 0 };
  assert.throws(() => verifyRttiMetadata(value, { __cxa_bad_typeid: { params: ['i32'], results: [] } }, unit), /RTTI ABI/);
});
