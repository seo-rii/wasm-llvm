import assert from 'node:assert/strict';

const simdOpcode = /^(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u;
const matchesSymbol = (name, symbol) => name === symbol || name.startsWith(symbol + '.');

// Decode instruction lines emitted by WABT, excluding local declarations and
// other functions. Bytes in data sections or instruction immediates are not opcodes.
export function permutationInstructions(disassembly, symbol) {
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

export function permutationWatInstructions(assembly, symbol) {
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

export function verifyRuntimePermutationInstructions(fixture, operation) {
  assert(matchesSymbol(operation.name, fixture.operationFunction), 'Instruction proof names another function');
  const instructions = operation.instructions;
  for (const opcode of fixture.requiredInstructions) assert(instructions.includes(opcode), `Operation body omitted ${opcode}`);
  for (const opcode of fixture.forbiddenInstructions) assert(!instructions.includes(opcode), `Operation body encoded forbidden ${opcode}`);
  if (fixture.semanticKind === 'scalar-runtime-permutation')
    assert(instructions.some(opcode => opcode === 'i32.and' || opcode === 'i64.and'), 'Runtime fallback omitted scalar selector masking');
  else assert.equal(fixture.semanticKind, 'constant-permutation', 'Unknown permutation contract');
  if (fixture.feature !== 'enabled') assert(!instructions.some(opcode => simdOpcode.test(opcode)), 'Disabled/default operation body encoded SIMD');
}
