import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases, disabledCases, defaultCases } from './lane-shift-fixtures.mjs';

const all = [...cases, ...disabledCases, ...defaultCases];
test('covers widths, languages, optimization levels, feature profiles and runtime corpora', () => {
  assert.deepEqual([cases.length, disabledCases.length, defaultCases.length], [48, 48, 48]);
  assert.equal(new Set(all.map(f => f.id)).size, 144);
  for (const bits of [8, 16, 32, 64]) for (const language of ['c', 'cpp']) for (const optimization of ['0', '2'])
    for (const feature of ['enabled', 'disabled', 'default'])
      assert.deepEqual(all.filter(f => f.bits === bits && f.request.language === language && f.request.optimization === optimization && f.feature === feature)
        .map(f => f.corpusIndex), [0, 1, 2]);
  assert(defaultCases.every(f => !Object.hasOwn(f.request, 'simd')));
  assert(cases.every(f => f.request.simd === true));
  assert(disabledCases.every(f => f.request.simd === false));
});

test('every corpus covers all valid lane counts with defined signed-left inputs', () => {
  for (const fixture of all) {
    const { bits, lanes, rows } = fixture, maximum = (1n << BigInt(bits - 1)) - 1n;
    assert.deepEqual([...new Set(rows.flat().map(cell => cell.count))].sort((a, b) => a - b), Array.from({ length: bits }, (_, i) => i));
    for (const row of rows) {
      assert.equal(row.length, lanes);
      assert.equal(new Set(row.map(cell => cell.count)).size, Math.min(bits, lanes));
      for (const cell of row) {
        assert(Number.isInteger(cell.count) && cell.count >= 0 && cell.count < bits);
        assert(BigInt(cell.unsigned) >= 0n && BigInt(cell.unsigned) < (1n << BigInt(bits)));
        assert(BigInt(cell.signed) >= -maximum - 1n && BigInt(cell.signed) <= maximum);
        assert(BigInt(cell.signedLeft) >= 0n && (BigInt(cell.signedLeft) << BigInt(cell.count)) <= maximum);
      }
    }
    assert.equal(fixture.stdout.trim().split('\n').length, rows.length * 7);
    assert.equal(fixture.stdin.trim().split('\n').length, rows.length * lanes + 1);
  }
});

test('oracle checks wraparound, negative arithmetic right shift and 64-bit precision', () => {
  const eight = cases.find(f => f.bits === 8 && f.corpusIndex === 0);
  const lines = eight.stdout.trim().split('\n').map(line => line.split(' ').map(BigInt));
  assert.equal(lines[0][2], 252n); // 255 << 2, truncated to eight bits
  assert.equal(lines[1][3], 16n); // unsigned 128 >> 3
  assert.equal(lines[2][1], -1n); // arithmetic -1 >> 1
  const wide = cases.find(f => f.bits === 64 && f.corpusIndex === 0);
  assert(wide.stdin.includes('18446744073709551615'));
  assert(wide.stdout.includes('18446744073709551612'));
  assert(wide.stdout.includes('-9223372036854775808'));
});

test('GCC original vector source and scalar Clang reference stay distinct', () => {
  for (const fixture of all) {
    assert(fixture.request.code.includes('vector_size(16)'));
    assert(fixture.request.code.includes('r=a << c;'));
    assert(fixture.request.code.includes('r=a >> c;'));
    assert(!fixture.oracleCode.includes('vector_size'));
    assert(fixture.oracleCode.includes('values[i]'));
    assert(fixture.oracleCode.includes('#ifdef __wasm_simd128__'));
    assert.equal(fixture.functions.length, 7);
    assert.equal(fixture.functions.filter(f => f.uniform).length, 3);
    assert(fixture.request.code.includes('count>=BITS'));
  }
});
