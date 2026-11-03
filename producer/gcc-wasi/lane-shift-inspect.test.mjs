import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases, disabledCases } from './lane-shift-fixtures.mjs';
import { inspectLaneShiftObject, inspectLaneShiftWat, verifyLaneShiftAgreement } from './lane-shift-inspect.mjs';

const fixture = cases[0];
const opcode = (operation, feature = 'enabled') => operation.uniform && feature === 'enabled' ? operation.simdShift : operation.scalarShift;
const wat = (feature = 'enabled') => '(module\n' + fixture.functions.map(fn => `(func $${fn.name} (${opcode(fn, feature)} (i32.const 0) (i32.const 0)))`).join('\n') + '\n)';
const object = (feature = 'enabled') => fixture.functions.map((fn, i) => `${(16 + i).toString(16)} func[${i}] <${fn.name}>:\n 0010: 01 | ${opcode(fn, feature)}\n 0011: 0b | end`).join('\n');

test('proves every operation separately and agrees between WAT and object', () => {
  const operations = inspectLaneShiftObject(object(), fixture);
  assert.equal(operations.length, 7);
  assert.equal(operations.filter(fn => fn.lowering === 'scalar-shift-instructions').length, 4);
  verifyLaneShiftAgreement(inspectLaneShiftWat(wat(), fixture), operations);
  inspectLaneShiftObject(object('disabled'), disabledCases[0]);
  inspectLaneShiftObject(object('disabled'), fixture, { family: 'clang' });
});

test('rejects a uniform opcode substituted for a variable lane shift', () => {
  assert.throws(() => inspectLaneShiftObject(object().replace('| i32.shl', '| i8x16.shl'), fixture), /omitted i32.shl/);
  assert.throws(() => inspectLaneShiftWat(wat().replace('(i32.shl', '(i8x16.shl'), fixture), /omitted i32.shl/);
  const injected = object().replace('| i32.shl', '| i32.shl\n 0011: 01 | i8x16.shl');
  assert.throws(() => inspectLaneShiftObject(injected, fixture), /must use scalar lane shifts/);
});

test('rejects missing, duplicated and other-function instruction proof', () => {
  assert.throws(() => inspectLaneShiftWat(wat().replace('$lane_shl_u_8', '$unrelated'), fixture), /exactly one/);
  assert.throws(() => inspectLaneShiftObject(object() + '\n' + object(), fixture), /exactly one/);
  const spoiled = wat().replace('(i32.shl', '(i32.add');
  assert.throws(() => inspectLaneShiftWat(spoiled + '(func $extra (i32.shl))', fixture), /omitted i32.shl/);
  assert.throws(() => inspectLaneShiftObject(object().replace('| i32.shl', '| i32.add'), fixture), /omitted i32.shl/);
});

test('WAT comments and strings cannot supply opcodes or fake functions', () => {
  const text = wat().replace('(i32.shl', '(i32.add');
  for (const extra of [';; (func $lane_shl_u_8 (i32.shl))\n', '(; (func $lane_shl_u_8 (i32.shl)) ;)\n', '(data "(func $lane_shl_u_8 (i32.shl))")\n'])
    assert.throws(() => inspectLaneShiftWat(extra + text, fixture), /omitted i32.shl/);
  const valid = '(; outer (; (func $fake) ;) ;)\n' + wat();
  assert.equal(inspectLaneShiftWat(valid, fixture).length, 7);
  assert.throws(() => inspectLaneShiftWat(wat() + '(; unterminated', fixture), /Unterminated/);
});

test('disabled/default profiles and scalar references cannot encode SIMD', () => {
  const scalar = object('disabled').replace('| i32.shl', '| i32.shl\n 0011: fd 00 | v128.load');
  assert.throws(() => inspectLaneShiftObject(scalar, disabledCases[0]), /unexpectedly encoded SIMD/);
  assert.throws(() => inspectLaneShiftObject(scalar, fixture, { family: 'clang' }), /unexpectedly encoded SIMD/);
  assert.throws(() => inspectLaneShiftObject(object(), fixture, { family: 'other' }), /Unknown compiler/);
});

test('agreement compares counted shifts and SIMD operations, not just presence', () => {
  const left = inspectLaneShiftWat(wat(), fixture), right = inspectLaneShiftObject(object(), fixture);
  right[0].shifts['i32.shl']++;
  assert.throws(() => verifyLaneShiftAgreement(left, right), /shift inventory differs/);
});
