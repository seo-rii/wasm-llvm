import assert from 'node:assert/strict';
import { inspectAliasObject } from './symbol-alias-inspect.mjs';
import { inspectObjectFunctionSignatures } from './inspect-vector-abi.mjs';

const runtimeSignatures = {
  __dynamic_cast: { params: ['i32', 'i32', 'i32', 'i32'], results: ['i32'] },
  __cxa_bad_cast: { params: [], results: [] },
  __cxa_bad_typeid: { params: [], results: [] },
};

export function verifyRttiMetadata(inspection, signatures, unit) {
  const byName = new Map();
  for (const symbol of inspection.symbols) if (symbol.name !== undefined) {
    assert(!byName.has(symbol.name), `Duplicate linking symbol: ${symbol.name}`);
    byName.set(symbol.name, symbol);
  }
  if (unit.forbiddenRtti) {
    assert(!inspection.symbols.some(symbol => /^_ZT[IS]/.test(symbol.name || '')),
      'RTTI-disabled unit emitted typeinfo or typeinfo names');
    assert(!byName.has('__dynamic_cast'), 'RTTI-disabled unit calls the RTTI runtime');
  }
  for (const expected of unit.expectedRttiSymbols) {
    const actual = byName.get(expected.name);
    assert(actual, `Missing RTTI/control symbol: ${expected.name}`);
    for (const field of ['kind', 'binding', 'undefined', 'visibility'])
      assert.equal(actual[field], expected[field], `${expected.name}: ${field}`);
    if (!actual.undefined) {
      for (const field of ['segment', 'offset', 'size'])
        assert(Number.isSafeInteger(actual[field]) && actual[field] >= 0, `${expected.name}: ${field}`);
      assert(actual.size > 0, `Empty RTTI/control storage: ${expected.name}`);
    }
    if (expected.relocationTypes.length) assert(inspection.relocations.some(relocation =>
      relocation.symbol === expected.name && expected.relocationTypes.includes(relocation.type)),
    `Missing RTTI/control relocation: ${expected.name}`);
  }
  for (const [name, signature] of Object.entries(unit.expectedFunctions)) {
    const actual = byName.get(name);
    assert(actual, `Missing runtime function: ${name}`);
    assert.equal(actual.kind, 'function', `Runtime function kind: ${name}`);
    assert.equal(actual.binding, 'global', `Runtime function binding: ${name}`);
    assert.equal(actual.undefined, true, `Runtime function import: ${name}`);
    assert.deepEqual(signatures[name], signature, `Runtime function signature: ${name}`);
    assert(inspection.relocations.some(relocation => relocation.symbol === name && relocation.type === 0),
      `Missing runtime call relocation: ${name}`);
  }
  // Successful pointer casts can still contain an untaken bad_typeid branch.
  // Its signature is checked without claiming exception failure execution.
  for (const [name, signature] of Object.entries(runtimeSignatures)) if (byName.has(name))
    assert.deepEqual(signatures[name], signature, `RTTI ABI signature: ${name}`);
  const selected = name => /^_ZT[ISV]/.test(name || '') || name in runtimeSignatures
    || name in unit.expectedFunctions || unit.expectedRttiSymbols.some(symbol => symbol.name === name);
  return {
    symbols: inspection.symbols.filter(symbol => selected(symbol.name)),
    relocations: inspection.relocations.filter(relocation => selected(relocation.symbol)),
    signatures: Object.fromEntries(Object.entries(signatures).filter(([name]) => selected(name))),
    functionDefinitions: inspection.functionDefinitions,
  };
}

export function inspectRttiObject(bytes, unit) {
  return verifyRttiMetadata(inspectAliasObject(bytes), inspectObjectFunctionSignatures(bytes), unit);
}
