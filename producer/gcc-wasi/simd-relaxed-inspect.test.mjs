import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRelaxedInstructions } from './simd-relaxed-inspect.mjs';
const fixture = { request: { simd: true, relaxedSimd: true }, requiredInstructions: ['i8x16.relaxed_swizzle'], forbiddenInstructions: ['f32x4.relaxed_madd'] };
const header = '000010 func[0] <relaxed>:\n';
const instruction = ' 000020: fd 80 02 | i8x16.relaxed_swizzle\n';
test('requires the opcode in the live operation body, not another function or data', () => {
  assert.equal(verifyRelaxedInstructions(fixture, header + instruction).operationFunction.name, 'relaxed');
  assert.throws(() => verifyRelaxedInstructions(fixture, header + ' 000020: 01 | nop\n000030 func[1] <unrelated>:\n' + instruction), /body did not encode/);
  assert.throws(() => verifyRelaxedInstructions(fixture, header + 'Data: i8x16.relaxed_swizzle\n'), /body did not encode/);
  assert.throws(() => verifyRelaxedInstructions(fixture, header + instruction + ' 000022: fd 85 02 | f32x4.relaxed_madd\n'), /Unexpected encoded/);
});
test('scalar and SIMD-only controls reject hidden relaxed instructions', () => {
  const control = { request: { simd: true, relaxedSimd: false }, requiredInstructions: [], forbiddenInstructions: [] };
  assert.throws(() => verifyRelaxedInstructions(control, '000010 func[0] <add>:\n' + instruction), /leaked/);
  assert.throws(() => verifyRelaxedInstructions({ ...control, request: { simd: false } }, '000010 func[0] <add>:\n 000020: fd ae 01 | i32x4.add\n'), /scalar/);
});
