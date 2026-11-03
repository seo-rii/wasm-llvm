import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases, disabledCases, diagnosticCases, disabledDiagnostic, saturationProfiles } from './simd-saturating-fixtures.mjs';

test('covers exactly eight Wasm operations in both languages and optimization levels', () => {
  const operations = [
    'i8x16.add_sat_s', 'i8x16.add_sat_u', 'i8x16.sub_sat_s', 'i8x16.sub_sat_u',
    'i16x8.add_sat_s', 'i16x8.add_sat_u', 'i16x8.sub_sat_s', 'i16x8.sub_sat_u'
  ];
  assert.deepEqual(saturationProfiles.map(profile => profile.opcode).sort(), operations.sort());
  assert.equal(cases.length, 32);
  assert.equal(new Set(cases.map(fixture => fixture.id)).size, 32);
  for (const opcode of operations) {
    const selected = cases.filter(fixture => fixture.requiredInstructions[0] === opcode);
    assert.deepEqual(selected.map(fixture => `${fixture.request.language}:${fixture.request.optimization}`).sort(), ['c:0', 'c:2', 'cpp:0', 'cpp:2']);
    for (const fixture of selected) {
      assert.equal(fixture.request.simd, true);
      assert.equal(fixture.requiredInstructions.length, 1);
      assert.deepEqual([...fixture.forbiddenInstructions].sort(), operations.filter(other => other !== opcode).sort());
    }
  }
});

test('mathematical oracle includes hand-checked clipping, exact bounds and interior results', () => {
  const expected = {
    'add-s-i8x16': [[127, 1, 127], [-128, -1, -128], [126, 1, 127], [-127, -1, -128], [127, -128, -1], [-1, 1, 0]],
    'sub-s-i8x16': [[127, -1, 127], [-128, 1, -128], [126, -1, 127], [-127, 1, -128], [-128, -128, 0], [127, 126, 1]],
    'add-u-i8x16': [[255, 1, 255], [254, 1, 255], [0, 0, 0], [127, 128, 255], [128, 128, 255], [1, 1, 2]],
    'sub-u-i8x16': [[0, 1, 0], [255, 255, 0], [255, 0, 255], [255, 254, 1], [1, 2, 0], [128, 127, 1]],
    'add-s-i16x8': [[32767, 1, 32767], [-32768, -1, -32768], [32766, 1, 32767], [-32767, -1, -32768], [32767, -32768, -1], [-1, 1, 0]],
    'sub-s-i16x8': [[32767, -1, 32767], [-32768, 1, -32768], [32766, -1, 32767], [-32767, 1, -32768], [-32768, -32768, 0], [32767, 32766, 1]],
    'add-u-i16x8': [[65535, 1, 65535], [65534, 1, 65535], [0, 0, 0], [32767, 32768, 65535], [32768, 32768, 65535], [1, 1, 2]],
    'sub-u-i16x8': [[0, 1, 0], [65535, 65535, 0], [65535, 0, 65535], [65535, 65534, 1], [1, 2, 0], [32768, 32767, 1]]
  };
  for (const profile of saturationProfiles) for (const [left, right, result] of expected[profile.id]) {
    const sample = profile.samples.find(sample => sample.left === String(left) && sample.right === String(right));
    assert(sample, `${profile.id}: missing ${left}, ${right}`);
    assert.equal(sample.result, String(result), `${profile.id}: ${left}, ${right}`);
  }
});

test('all representative pairs are legal and every vector mixes both operands', () => {
  for (const profile of saturationProfiles) {
    assert.equal(profile.samples.length, 64);
    assert.equal(new Set(profile.samples.map(sample => `${sample.left},${sample.right}`)).size, 64);
    const minimum = BigInt(profile.minimum), maximum = BigInt(profile.maximum);
    for (const sample of profile.samples) for (const value of Object.values(sample)) {
      assert(BigInt(value) >= minimum && BigInt(value) <= maximum, `${profile.id}: out-of-range lane ${value}`);
    }
    for (let offset = 0; offset < 64; offset += profile.lanes) {
      const block = profile.samples.slice(offset, offset + profile.lanes);
      assert(new Set(block.map(sample => sample.left)).size > 1);
      assert(new Set(block.map(sample => sample.right)).size > 1);
    }
    const rows = profile.stdout.trimEnd().split('\n');
    assert.equal(rows.length, 64 / profile.lanes);
    for (const row of rows) assert.equal(row.split(' ').length, profile.lanes);
    assert.deepEqual(rows.flatMap(row => row.split(' ')).sort(), profile.samples.map(sample => sample.result).sort());
  }
});

test('disabled and invalid-type profiles remain distinct from positive builtin qualification', () => {
  assert.equal(disabledCases.length, 4);
  assert.deepEqual(disabledCases.map(fixture => `${fixture.request.language}:${fixture.request.optimization}`).sort(), ['c:0', 'c:2', 'cpp:0', 'cpp:2']);
  for (const fixture of disabledCases) {
    assert.equal(fixture.request.simd, false);
    assert.equal(fixture.stdout, '20 14 51 33\n');
    assert.equal(fixture.stdin, '3 17\n');
    assert.deepEqual(fixture.requiredInstructions, []);
    assert(!fixture.request.code.includes('__builtin_wasm_'));
  }
  assert(cases.some(fixture => fixture.request.code === disabledDiagnostic));
  assert(!disabledDiagnostic.includes('#error'));
  assert.equal(diagnosticCases.length, 16);
  const allIds = [...cases, ...disabledCases, ...diagnosticCases].map(fixture => fixture.id);
  assert.equal(new Set(allIds).size, allIds.length);
  for (const fixture of diagnosticCases) {
    assert.equal(fixture.request.simd, true);
    assert(fixture.request.code.includes(fixture.builtin));
    assert(new RegExp(fixture.diagnosticPattern).test(fixture.id.includes('wrong-width') ? 'incompatible type' : 'implicit declaration'));
  }
});
