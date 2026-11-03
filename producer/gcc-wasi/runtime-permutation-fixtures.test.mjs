import assert from 'node:assert/strict';
import test from 'node:test';
import { cases, disabledCases, defaultCases, runtimePermutationModes } from './runtime-permutation-fixtures.mjs';
import { cases as extendedCases, disabledCases as extendedDisabledCases } from './simd-extended-fixtures.mjs';

const all = [...cases, ...disabledCases, ...defaultCases];
const runtime = all.filter(fixture => fixture.semanticKind === 'scalar-runtime-permutation');

test('all six lane modes retain the full C/C++ O0/O2 runtime matrix', () => {
  assert.equal(cases.length, 108);
  assert.equal(disabledCases.length, 98);
  assert.equal(defaultCases.length, 96);
  assert.equal(new Set(all.map(fixture => fixture.id)).size, 302);
  assert.equal(runtime.length, 288);
  for (const mode of runtimePermutationModes) for (const arity of [1, 2]) for (const signedMask of [true, false])
    for (const language of ['c', 'cpp']) for (const optimization of ['0', '2']) for (const feature of ['enabled', 'disabled', 'default'])
      assert.equal(runtime.filter(fixture => fixture.mode === mode.name && fixture.arity === arity && fixture.signedMask === signedMask
        && fixture.request.language === language && fixture.request.optimization === optimization && fixture.feature === feature).length, 1);
});

test('default requests omit the SIMD property and preserve the feature guard', () => {
  for (const fixture of defaultCases) {
    assert.equal(Object.hasOwn(fixture.request, 'simd'), false);
    assert.match(fixture.request.code, /#ifdef __wasm_simd128__/);
  }
  assert(cases.every(fixture => fixture.request.simd === true));
  assert(disabledCases.every(fixture => fixture.request.simd === false));
});

test('runtime selectors cover defined negative and wide boundary values without losing integer precision', () => {
  for (const fixture of runtime) {
    const bits = BigInt(fixture.bits), n = BigInt(fixture.lanes);
    const values = fixture.masks.flat().map(BigInt);
    const low = fixture.signedMask ? -(1n << (bits - 1n)) : 0n;
    const high = (1n << (bits - (fixture.signedMask ? 1n : 0n))) - 1n;
    assert(values.every(value => value >= low && value <= high));
    for (const value of [low, high, n, 2n * n, 2n * n + 1n]) assert(values.includes(value));
    if (fixture.signedMask) for (const value of [-1n, -n, -2n * n - 1n]) assert(values.includes(value));
    for (const [row, mask] of fixture.masks.entries()) for (const [lane, value] of mask.entries())
      assert.equal(BigInt(fixture.expectedLanes[row][lane]), BigInt(value) & BigInt(fixture.arity * fixture.lanes - 1));
  }
  assert(runtime.some(fixture => fixture.stdin.includes('18446744073709551615')));
  assert(runtime.some(fixture => fixture.stdin.includes('-9223372036854775808')));
});

test('negative one selects the last lane instead of becoming a dont-care index', () => {
  for (const fixture of runtime.filter(fixture => fixture.signedMask)) {
    let checked = false;
    for (const [row, mask] of fixture.masks.entries()) for (const [lane, value] of mask.entries()) if (value === '-1') {
      assert.equal(fixture.expectedLanes[row][lane], String(fixture.arity * fixture.lanes - 1));
      const output = fixture.stdout.trimEnd().split('\n')[row];
      const expected = fixture.dataSets[row % 2][fixture.arity - 1].at(-1);
      assert.equal(output.slice(lane * fixture.bits / 4, (lane + 1) * fixture.bits / 4), expected);
      checked = true;
    }
    assert(checked);
  }
});

test('GCC expressions remain genuine runtime builtins and the Clang reference is separate scalar source', () => {
  for (const fixture of runtime) {
    assert.equal((fixture.request.code.match(/__builtin_shuffle\(/g) || []).length, 1);
    assert.match(fixture.request.code, /scanf\("%llu?d?"|scanf\("%lld"/);
    assert.match(fixture.request.code, /\(\* volatile operation\)/);
    assert(!fixture.oracleCode.includes('__builtin_shuffle'));
    assert.match(fixture.oracleCode, /unsigned char left\[16\], right\[16\], output\[16\]/);
    assert.match(fixture.oracleCode, /unsigned long long\)mask\[lane\] &/);
    assert.equal(fixture.stdout.trimEnd().split('\n').length, fixture.masks.length);
    assert(fixture.stdout.trimEnd().split('\n').every(line => /^[0-9a-f]{32}$/.test(line)));
  }
});

test('floating inputs preserve negative zero, NaN payloads, subnormals and infinity as bytes', () => {
  const bytes = runtime.filter(fixture => fixture.mode.startsWith('f')).flatMap(fixture => fixture.dataSets.flat(2));
  for (const value of ['00000080', '4523c17f', '01000000', '0000807f',
    '0000000000000080', 'bc9a78563412f87f', '0100000000000000', '000000000000f07f']) assert(bytes.includes(value));
});

test('all original fourteen constant-shuffle regressions keep their source and expected outputs', () => {
  const originals = [...extendedCases, ...extendedDisabledCases].filter(fixture => fixture.id.includes('-shuffle-'));
  const constants = all.filter(fixture => fixture.semanticKind === 'constant-permutation');
  assert.equal(constants.length, 14);
  for (const original of originals) {
    const fixture = constants.find(value => value.id === original.id);
    for (const key of ['request', 'stdin', 'stdout', 'requiredInstructions', 'forbiddenInstructions'])
      assert.deepEqual(fixture[key], original[key]);
    assert.equal(fixture.oracleCode, original.request.code);
  }
});
