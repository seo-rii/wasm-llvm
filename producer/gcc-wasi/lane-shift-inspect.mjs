import assert from 'node:assert/strict';

const simdOpcode = /^(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u;
const matchesSymbol = (name, symbol) => name === symbol || name.startsWith(symbol + '.');

// Decode instruction lines emitted by WABT, excluding local declarations and
// other functions. Bytes in data sections or instruction immediates are not opcodes.
function objectInstructions(disassembly, symbol) {
  const functions = [];
  let current;
  for (const line of disassembly.split('\n')) {
    const header = /^\s*[a-f0-9]+\s+func\[(\d+)\]\s+<([^>]+)>:/i.exec(line);
    if (header) {
      current = { index: Number(header[1]), name: header[2], instructions: [] };
      functions.push(current);
      continue;
    }
    const instruction = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/i.exec(line);
    if (current && instruction && !instruction[1].startsWith('local[')) current.instructions.push(instruction[1]);
  }
  const operations = functions.filter(fn => matchesSymbol(fn.name, symbol));
  assert.equal(operations.length, 1, `Expected exactly one ${symbol} operation body`);
  assert(operations[0].instructions.length, 'Operation body has no decoded instructions');
  return operations[0];
}

function watCode(text) {
  let output = '', string = false, comment = 0;
  for (let i = 0; i < text.length; ++i) {
    const pair = text.slice(i, i + 2), value = text[i];
    if (string) {
      if (value === '\\') { output += '  '; ++i; }
      else { if (value === '"') string = false; output += value === '\n' ? '\n' : ' '; }
    } else if (comment) {
      if (pair === '(;') { ++comment; output += '  '; ++i; }
      else if (pair === ';)') { --comment; output += '  '; ++i; }
      else output += value === '\n' ? '\n' : ' ';
    } else if (pair === ';;') {
      while (i < text.length && text[i] !== '\n') { output += ' '; ++i; }
      if (i < text.length) output += '\n';
    } else if (pair === '(;') { comment = 1; output += '  '; ++i; }
    else if (value === '"') { string = true; output += ' '; }
    else output += value;
  }
  assert(!string && !comment, 'Unterminated WAT string or comment');
  return output;
}

function watInstructions(assembly, symbol) {
  const text = watCode(assembly), functions = [];
  const pattern = /\(\s*func\s+\$([^\s()]+)/gu;
  for (const match of text.matchAll(pattern)) if (matchesSymbol(match[1], symbol)) {
    let depth = 0, end = match.index;
    do {
      assert(end < text.length, 'Unterminated WAT operation body');
      if (text[end] === '(') ++depth;
      else if (text[end] === ')') --depth;
      ++end;
    } while (depth);
    const body = text.slice(match.index, end);
    const instructions = [...body.matchAll(/\(\s*((?:i32|i64|f32|f64|v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.[a-z0-9_]+)(?=\s|\))/gu)].map(value => value[1]);
    functions.push({ name: match[1], instructions });
  }
  assert.equal(functions.length, 1, `Expected exactly one ${symbol} WAT operation body`);
  assert(functions[0].instructions.length, 'WAT operation body has no numeric instructions');
  return functions[0];
}

const shiftOpcode = /^(?:i32|i64|i8x16|i16x8|i32x4|i64x2)\.(?:shl|shr_[su])$/u;
const inventory = values => Object.fromEntries([...new Set(values)].sort().map(opcode => [opcode, values.filter(value => value === opcode).length]));

function inspect(fixture, reader, family) {
  assert(['gcc', 'clang'].includes(family), 'Unknown compiler family');
  return fixture.functions.map(operation => {
    const body = reader(operation.name), { instructions } = body;
    const simdShifts = instructions.filter(opcode => shiftOpcode.test(opcode) && simdOpcode.test(opcode));
    const vectorShift = family === 'gcc' && operation.uniform && fixture.feature === 'enabled';
    const expected = vectorShift ? operation.simdShift : operation.scalarShift;
    assert(instructions.includes(expected), `${operation.name} omitted ${expected}`);
    if (vectorShift) assert(simdShifts.every(opcode => opcode === expected), `${operation.name} encoded another SIMD shift`);
    else assert.equal(simdShifts.length, 0, `${operation.name} must use scalar lane shifts`);
    if (family === 'clang' || fixture.feature !== 'enabled')
      assert(!instructions.some(opcode => simdOpcode.test(opcode)), `${operation.name} unexpectedly encoded SIMD`);
    return { ...body, operation: operation.operation, uniform: operation.uniform,
      shifts: inventory(instructions.filter(opcode => shiftOpcode.test(opcode))),
      simdInstructions: inventory(instructions.filter(opcode => simdOpcode.test(opcode))),
      lowering: vectorShift ? 'simd-shift-instructions' : 'scalar-shift-instructions' };
  });
}

export function inspectLaneShiftObject(disassembly, fixture, { family = 'gcc' } = {}) {
  return inspect(fixture, name => objectInstructions(disassembly, name), family);
}
export function inspectLaneShiftWat(assembly, fixture) {
  return inspect(fixture, name => watInstructions(assembly, name), 'gcc');
}
export function verifyLaneShiftAgreement(watOperations, objectOperations) {
  assert.equal(watOperations.length, objectOperations.length);
  for (let i = 0; i < watOperations.length; ++i) {
    assert.equal(watOperations[i].name, objectOperations[i].name);
    assert.deepEqual(watOperations[i].shifts, objectOperations[i].shifts, 'WAT/object shift inventory differs');
    assert.deepEqual(watOperations[i].simdInstructions, objectOperations[i].simdInstructions, 'WAT/object SIMD inventory differs');
  }
}
