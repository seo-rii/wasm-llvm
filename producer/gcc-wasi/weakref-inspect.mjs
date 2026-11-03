import assert from 'node:assert/strict';
import { inspectAliasObject } from './symbol-alias-inspect.mjs';
import { inspectObjectFunctionSignatures } from './inspect-vector-abi.mjs';

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function verifyWeakrefMetadata(inspection, signatures, unit) {
  const { expectedMetadata: expected } = unit;
  const byName = new Map();
  for (const symbol of inspection.symbols) {
    if (symbol.name === undefined) continue;
    assert(!byName.has(symbol.name), `Duplicate linking symbol: ${symbol.name}`);
    byName.set(symbol.name, symbol);
  }
  const targets = inspection.symbols.filter(symbol => expected.targets.includes(symbol.name));
  assert.equal(targets.length, expected.unused ? 0 : expected.targets.length, 'Target symbol count');
  for (const name of expected.unused ? [] : expected.targets) {
    const symbol = byName.get(name);
    assert(symbol, `Missing target symbol: ${name}`);
    const signature = expected.functions[name];
    assert.equal(symbol.kind, signature ? 'function' : 'data', `Target kind: ${name}`);
    assert.equal(symbol.binding, expected.binding, `Target binding: ${name}`);
    assert.equal(symbol.undefined, expected.undefined, `Target definition: ${name}`);
    assert.equal(symbol.visibility, unit.expectedVisibility, `Target visibility: ${name}`);
    if (signature) assert.deepEqual(signatures[name], signature, `Target signature: ${name}`);
  }
  const aliasTargets = new Map(), localAliases = [];
  for (const alias of unit.expectedLocalAliases) {
    assert(unit.compiler === 'gcc' && !unit.provider && !expected.undefined && !expected.unused
      && expected.binding === 'global', 'Local aliases require locally bound GCC definitions');
    assert(expected.targets.includes(alias.target), `Unexpected alias target: ${alias.target}`);
    assert(!aliasTargets.has(alias.name), `Duplicate local alias contract: ${alias.name}`);
    const symbol = byName.get(alias.name), target = byName.get(alias.target);
    assert(symbol && target, `Missing same-unit alias or target: ${alias.name}`);
    assert.equal(symbol.binding, 'local', `Local alias binding: ${alias.name}`);
    assert.equal(symbol.undefined, false, `Local alias definition: ${alias.name}`);
    assert.equal(symbol.visibility, 'default', `Local alias visibility: ${alias.name}`);
    assert.equal(symbol.kind, target.kind, `Local alias kind: ${alias.name}`);
    const location = value => value.kind === 'function' ? [value.entityIndex]
      : [value.segment, value.offset, value.size];
    assert(location(symbol).every(Number.isSafeInteger), `Missing local alias location: ${alias.name}`);
    // A shared function index also has one shared Wasm type. A forwarding body
    // or separately allocated data cannot satisfy this equality.
    assert.deepEqual(location(symbol), location(target), `Local alias body/storage: ${alias.name}`);
    aliasTargets.set(alias.name, alias.target);
    localAliases.push({ ...symbol, target: alias.target });
  }
  for (const name of unit.forbiddenAliasNames) {
    const localMangled = new RegExp(`^_ZL${name.length}${escape(name)}(?:[A-Za-z0-9_].*)?$`);
    assert(![...byName.keys()].some(symbol => !aliasTargets.has(symbol)
      && (symbol === name || localMangled.test(symbol))),
    `Weakref declaration became a linking symbol: ${name}`);
  }
  const relocationTarget = relocation => aliasTargets.get(relocation.symbol) || relocation.symbol;
  const relocations = inspection.relocations.filter(relocation => expected.targets.includes(relocationTarget(relocation)));
  if (expected.unused) {
    assert.equal(relocations.length, 0, 'Unused weakrefs emitted relocations');
    return { targets, localAliases, relocations, signatures: {} };
  }
  if (!unit.provider) {
    const globalPointers = unit.code.split('int main')[0].includes('volatile observed_f');
    for (const name of expected.targets) {
      assert(relocations.some(relocation => relocationTarget(relocation) === name),
        `Missing target relocation: ${name}`);
      const functionSymbol = Boolean(expected.functions[name]);
      const pointerType = globalPointers ? (functionSymbol ? 2 : 5) : (functionSymbol ? 1 : 4);
      assert(relocations.some(relocation => relocationTarget(relocation) === name && relocation.type === pointerType),
        `Missing ${globalPointers ? 'initialized' : 'local'} pointer relocation: ${name}`);
      if (functionSymbol && unit.profile.endsWith('-direct'))
        assert(relocations.some(relocation => relocationTarget(relocation) === name && relocation.type === 0),
          `Missing direct-call relocation: ${name}`);
    }
  }
  return { targets, localAliases, relocations,
    signatures: Object.fromEntries(Object.keys(expected.functions).map(name => [name, signatures[name]])) };
}

export function inspectWeakrefObject(bytes, unit) {
  const inspection = inspectAliasObject(bytes);
  const signatures = inspectObjectFunctionSignatures(bytes);
  return verifyWeakrefMetadata(inspection, signatures, unit);
}
