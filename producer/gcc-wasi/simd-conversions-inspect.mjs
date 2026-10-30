import assert from 'node:assert/strict';

// Read actual WABT instruction output, never search bytes for the SIMD prefix.
// Function names are the C/C++ fixture's address-taken, noinline convert body.
export function conversionInstructions(disassembly) {
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
    if (current && instruction && !instruction[1].startsWith('local['))
      current.instructions.push(instruction[1]);
  }
  const conversions = functions.filter(fn => fn.name === 'convert' || fn.name.startsWith('_ZL7convert'));
  assert.equal(conversions.length, 1, 'Expected exactly one real conversion function');
  assert(conversions[0].instructions.length, 'Conversion function has no decoded instructions');
  return conversions[0];
}

export function verifyConversionInstructions(fixture, conversion) {
  const instructions = conversion.instructions;
  for (const opcode of fixture.requiredInstructions)
    assert(instructions.includes(opcode), `Conversion function did not encode ${opcode}`);
  for (const opcode of fixture.forbiddenInstructions)
    assert(!instructions.includes(opcode), `Conversion function encoded forbidden ${opcode}`);
  if (fixture.semanticKind === 'scalar-fallback-integer-to-float')
    assert(instructions.some(opcode => /^f64\.convert_i64_[su]$/.test(opcode)), 'Missing actual scalar i64 to f64 conversion');
  if (fixture.semanticKind === 'scalar-fallback-float-to-integer')
    assert(instructions.some(opcode => /^i64\.trunc(?:_sat)?_f64_[su]$/.test(opcode)), 'Missing actual scalar f64 to i64 conversion');
}
