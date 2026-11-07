import assert from 'node:assert/strict';

export const relaxedMnemonic = /^(?:i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.relaxed_/u;
export const simdMnemonic = /^(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u;

export function decodeDisassembly(disassembly) {
  const functions = [], instructions = [];
  let current;
  for (const line of disassembly.split('\n')) {
    const header = /^\s*[a-f0-9]+\s+func\[(\d+)\]\s+<([^>]+)>:/i.exec(line);
    if (header) { current = { index: Number(header[1]), name: header[2], instructions: [] }; functions.push(current); continue; }
    const instruction = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/i.exec(line);
    if (instruction && !instruction[1].startsWith('local[')) {
      instructions.push(instruction[1]);
      current?.instructions.push(instruction[1]);
    }
  }
  return { functions, instructions };
}

export function verifyRelaxedInstructions(fixture, disassembly) {
  const decoded = decodeDisassembly(disassembly);
  const name = fixture.request.relaxedSimd ? 'relaxed' : 'add';
  const functions = decoded.functions.filter(fn => fn.name === name || fn.name.startsWith(`_ZL${name.length}${name}`));
  assert.equal(functions.length, 1, `Expected one actual ${name} function`);
  for (const opcode of fixture.requiredInstructions) assert(functions[0].instructions.includes(opcode), `Actual ${name} body did not encode ${opcode}`);
  for (const opcode of fixture.forbiddenInstructions) assert(!decoded.instructions.includes(opcode), `Unexpected encoded ${opcode}`);
  if (!fixture.request.relaxedSimd) assert(!decoded.instructions.some(opcode => relaxedMnemonic.test(opcode)), 'Relaxed instructions leaked into a disabled profile');
  if (!fixture.request.simd) assert(!decoded.instructions.some(opcode => simdMnemonic.test(opcode)), 'SIMD instructions leaked into scalar profile');
  return { ...decoded, operationFunction: functions[0] };
}

export function assertRelaxedOutput(fixture, actual) {
  assert.equal(typeof actual, 'string');
  if (fixture.stdoutAlternatives !== undefined) {
    assert.equal(fixture.request.relaxedSimd, true);
    assert(Array.isArray(fixture.stdoutAlternatives) && fixture.stdoutAlternatives.length > 0 && fixture.stdoutAlternatives.length <= 16);
    assert(fixture.stdoutAlternatives.every(value => typeof value === 'string'));
    assert(fixture.stdoutAlternatives.includes(fixture.stdout));
    assert(fixture.stdoutAlternatives.includes(actual), `${fixture.id}: output does not match any permitted relaxed projection:\n${actual}`);
  } else assert.equal(actual, fixture.stdout);
}
