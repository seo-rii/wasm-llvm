import assert from 'node:assert/strict';
import test from 'node:test';
import { cases, disabledCases, diagnosticCases, relaxedProfiles, encodeDyadic, multiplyAddBits, relaxedTrunc, relaxedDot } from './simd-relaxed-fixtures.mjs';
import { assertRelaxedOutput } from './simd-relaxed-inspect.mjs';

test('all 20 public instructions execute under all C/C++ O0/O2 combinations', () => {
  assert.equal(relaxedProfiles.length, 20); assert.equal(cases.length, 80);
  assert.equal(new Set(relaxedProfiles.map(profile => profile.opcode)).size, 20);
  for (const profile of relaxedProfiles) {
    const selected = cases.filter(fixture => fixture.apis.includes(profile.name));
    assert.deepEqual(selected.map(fixture => fixture.request.language + fixture.request.optimization).sort(), ['c0', 'c2', 'cpp0', 'cpp2']);
    for (const fixture of selected) {
      assert(fixture.request.simd && fixture.request.relaxedSimd);
      assert(fixture.request.code.includes(`#include <wasm_relaxed_simd.h>`));
      assert(fixture.request.code.includes(profile.name + '('));
      assert.deepEqual(fixture.requiredInstructions, [profile.opcode]);
      assert.equal(fixture.forbiddenInstructions.length, 19);
      for (const output of fixture.stdoutAlternatives) assertRelaxedOutput(fixture, output);
    }
  }
});

test('dyadic oracle distinguishes fused cancellation, overflow and double-rounded subnormals', () => {
  assert.equal(encodeDyadic(-1n, -46, 32), 0xa8800000n);
  assert.equal(encodeDyadic(1n, -104, 64), 0x3970000000000000n);
  assert.equal(multiplyAddBits(0x3f800001n, 0x3f7ffffen, 0xbf800000n, 32, false), 0n);
  assert.equal(multiplyAddBits(0x3f800001n, 0x3f7ffffen, 0xbf800000n, 32, true), 0xa8800000n);
  assert.equal(multiplyAddBits(0x3ff0000000000001n, 0x3feffffffffffffen, 0x3ff0000000000000n, 64, true, true), 0x3970000000000000n);
  assert.equal(multiplyAddBits(0x7f7fffffn, 0x40000000n, 0xff7fffffn, 32, false), 0x7f800000n);
  assert.equal(multiplyAddBits(0x7f7fffffn, 0x40000000n, 0xff7fffffn, 32, true), 0x7f7fffffn);
  assert.equal(multiplyAddBits(1n, 0x3f000000n, 1n, 32, false), 1n);
  assert.equal(multiplyAddBits(1n, 0x3f000000n, 1n, 32, true), 2n);
  assert.equal(multiplyAddBits(0x7f7fffffn, 0x40000000n, 0xff800000n, 32, false), 0x7fc00000n);
  assert.equal(multiplyAddBits(0x7f7fffffn, 0x40000000n, 0xff800000n, 32, true), 0xff800000n);
  assert.equal(multiplyAddBits(0x7f7fffffn, 0x40000000n, 0x7f800000n, 32, false, true), 0x7fc00000n);
  assert.equal(multiplyAddBits(0x7f7fffffn, 0x40000000n, 0x7f800000n, 32, true, true), 0x7f800000n);
  assert.equal(multiplyAddBits(0x7fefffffffffffffn, 0x4000000000000000n, 0xfff0000000000000n, 64, false), 0x7ff8000000000000n);
  assert.equal(multiplyAddBits(0x7fefffffffffffffn, 0x4000000000000000n, 0xfff0000000000000n, 64, true), 0xfff0000000000000n);
});

test('truncation includes all permitted unsigned sentinels and exact signed bounds', () => {
  assert.deepEqual([0, 1, 2, 3].map(p => relaxedTrunc(0x7fc00000n, 32, true, p)), [0n, 0xffffffffn, 0xfffffffen, 0x80000000n]);
  assert.deepEqual([0, 1].map(p => relaxedTrunc(0x7fc00000n, 32, false, p)), [0n, 0x80000000n]);
  assert.equal(relaxedTrunc(0x41dfffffffd00000n, 64, false), 0x7fffffffn);
  assert.equal(relaxedTrunc(0xc1e0000000180000n, 64, false), 0x80000000n);
  assert.equal(relaxedTrunc(0xbfefffffffffffffn, 64, true, 3), 0n);
  assert.equal(relaxedTrunc(0x4f000000n, 32, false, 0), 0x7fffffffn);
  assert.equal(relaxedTrunc(0x4f000000n, 32, false, 1), 0x80000000n);
});

test('dot-product oracle includes correlated signed/wrapping and unsigned/saturating choices', () => {
  const a = [-128, -128, -128, -128, -128, -128, -128, -128, 127, 127, 127, 127, 127, 127, 127, 127];
  const b = [-128, -128, -128, -128, -127, -127, -127, -127, -128, -128, -128, -128, -1, -1, -1, -1];
  const expected = [[-65535, 65026, -65021, -504], [-65535, -65534, 65027, 65538], [65537, 65026, -65021, -504], [-65535, -66046, 65027, 129544]];
  for (let p = 0; p < 4; p++) assert.deepEqual(relaxedDot(a, b, [1, 2, 3, 4], Boolean(p & 1), Boolean(p & 2)).map(v => Number(BigInt.asIntN(32, v))), expected[p]);
});

test('complete output alternatives reject mixed host projections and noncanonical NaNs', () => {
  const fixture = cases.find(f => f.id.includes('f32x4_relaxed_madd') && f.request.language === 'c' && f.request.optimization === '0');
  assert.equal(fixture.stdoutAlternatives.length, 2);
  const [a, b] = fixture.stdoutAlternatives.map(value => value.trimEnd().split('\n'));
  const differing = a.map((value, i) => value !== b[i] ? i : -1).filter(i => i >= 0);
  assert(differing.length > 1);
  const mixed = [...a]; mixed[differing[0]] = b[differing[0]];
  assert.throws(() => assertRelaxedOutput(fixture, mixed.join('\n') + '\n'), /permitted relaxed projection/);
  assert.throws(() => assertRelaxedOutput(fixture, fixture.stdout.replace('nan', '7fc00001')), /permitted relaxed projection/);
});

test('noncanonical lane masks admit byte top-bit selection while full masks stay exact', () => {
  const fixture = cases.find(f => f.id === 'simd-relaxed-i16x8_relaxed_laneselect-c-o0');
  const rows = '3118 ad79 adda 309b 309c adbd 305e addf\n3210 acf1 add2 3113 3194 ad35 3156 ad57\n';
  assertRelaxedOutput(fixture, rows + rows);
  for (const output of fixture.stdoutAlternatives) {
    assert.equal(output.split('\n')[0].split(' ')[0], '3118');
    assert.equal(output.split('\n')[0].split(' ')[1], 'ad79');
  }
});

test('baseline controls and disabled feature diagnostics do not masquerade as positive coverage', () => {
  assert.equal(disabledCases.length, 8); assert.equal(diagnosticCases.length, 324);
  assert.equal(diagnosticCases.filter(fixture => fixture.profile === 'relaxed-only' && !fixture.request.simd && fixture.request.relaxedSimd).length, 4);
  for (const fixture of disabledCases) {
    assert.equal(fixture.request.relaxedSimd, false); assert(!fixture.stdoutAlternatives); assert.deepEqual(fixture.apis, []);
    assert(!fixture.request.code.includes('wasm_relaxed_simd.h'));
  }
  const all = [...cases, ...disabledCases, ...diagnosticCases];
  assert.equal(new Set(all.map(fixture => fixture.id)).size, all.length);
  for (const fixture of diagnosticCases) {
    assert(!fixture.request.code.includes('#error'));
    assert(fixture.request.code.includes('return __builtin_wasm_'));
  }
});
