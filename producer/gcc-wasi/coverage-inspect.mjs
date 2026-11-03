import assert from 'node:assert/strict';
import { inspectAliasObject } from './symbol-alias-inspect.mjs';
import { inspectObjectFunctionSignatures } from './inspect-vector-abi.mjs';

// This reads Wasm linking metadata only. GCC's private gcno/gcda format is
// consumed exclusively by the pinned official gcov/gcov-dump programs.
function initializers(bytes, symbols) {
  let position = 8, limit = bytes.length;
  const byte = () => { assert(position < limit, 'Truncated initialization metadata'); return bytes[position++]; };
  const u32 = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const part = byte(); value += (part & 127) * 2 ** shift;
      if (!(part & 128)) { assert(value <= 0xffffffff); return value; }
    }
    assert.fail('Invalid initialization metadata LEB');
  };
  const name = () => {
    const size = u32(); assert(position + size <= limit);
    const result = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(position, position + size));
    position += size; return result;
  };
  const result = [];
  let seen = false;
  while (position < bytes.length) {
    limit = bytes.length;
    const section = byte(), size = u32(), end = position + size;
    assert(end <= bytes.length); limit = end;
    if (section === 0 && name() === 'linking') {
      assert.equal(u32(), 2);
      while (position < end) {
        const kind = byte(), length = u32(), subsectionEnd = position + length;
        assert(subsectionEnd <= end); limit = subsectionEnd;
        if (kind === 6) {
          assert(!seen, 'Duplicate initialization list'); seen = true;
          for (let count = u32(); count; --count) {
            const priority = u32(), symbolIndex = u32(), symbol = symbols[symbolIndex];
            assert(symbol && symbol.kind === 'function' && !symbol.undefined, 'Invalid initializer symbol');
            result.push({ priority, symbolIndex, name: symbol.name });
          }
          assert.equal(position, subsectionEnd);
        }
        position = subsectionEnd; limit = end;
      }
    }
    position = end;
  }
  return result;
}

export function inspectCoverageObject(bytes, { mode }, disassembly) {
  const metadata = inspectAliasObject(bytes), signatures = inspectObjectFunctionSignatures(bytes);
  const initFunctions = initializers(bytes, metadata.symbols);
  const selected = value => /^__gcov/.test(value || '');
  const symbols = metadata.symbols.filter(value => selected(value.name));
  const relocations = metadata.relocations.filter(value => selected(value.symbol));
  const instrumented = mode === 'coverage' || mode === 'arcs';
  const instructions = Object.fromEntries(['i64.load', 'i64.add', 'i64.store'].map(opcode =>
    [opcode, disassembly.split('\n').filter(line => new RegExp('\\|\\s+' + opcode.replace('.', '\\.') + '(?:\\s|$)').test(line)).length]));
  if (instrumented) {
    for (const [name, signature] of Object.entries({
      __gcov_init: { params: ['i32'], results: [] },
      __gcov_exit: { params: [], results: [] },
      __gcov_merge_add: { params: ['i32', 'i32'], results: [] },
    })) {
      const symbol = symbols.find(value => value.name === name);
      assert(symbol && symbol.undefined && symbol.kind === 'function' && symbol.binding === 'global', `Missing official coverage import: ${name}`);
      assert.deepEqual(signatures[name], signature, `Coverage import ABI: ${name}`);
      assert(relocations.some(value => value.symbol === name && value.type === (name === '__gcov_merge_add' ? 2 : 0)), `Missing coverage relocation: ${name}`);
    }
    const counters = symbols.filter(value => value.name.startsWith('__gcov0.'));
    assert(counters.length > 0, 'No emitted arc counters');
    for (const counter of counters) {
      assert.equal(counter.kind, 'data'); assert.equal(counter.undefined, false);
      assert.equal(counter.binding, 'local'); assert(counter.size > 0 && counter.size % 8 === 0);
      assert(relocations.some(value => value.symbol === counter.name && value.targetSection === 10 && [3, 4, 5].includes(value.type)), `No instruction relocation for ${counter.name}`);
    }
    assert(initFunctions.some(value => value.priority === 100 && /^_sub_I_/.test(value.name)), 'No priority-100 gcov constructor');
    for (const [opcode, count] of Object.entries(instructions)) assert(count > 0, `No real scalar counter instruction: ${opcode}`);
  } else {
    assert.equal(symbols.length, 0, 'Uninstrumented control emitted coverage symbols');
    assert.equal(relocations.length, 0, 'Uninstrumented control emitted coverage relocations');
    assert(!initFunctions.some(value => value.priority === 100 && /^_sub_I_/.test(value.name)), 'Uninstrumented control registered gcov');
  }
  return { symbols, relocations, signatures: Object.fromEntries(Object.entries(signatures).filter(([name]) => selected(name))),
    initFunctions, instructions, functionDefinitions: metadata.functionDefinitions };
}

export function verifyGcovJson(data, unit, expected, multiplier = 1, sourcePath) {
  assert.equal(data.format_version, '2', 'Use the pinned GCC JSON v2 tool');
  assert(/^17\.0\.0\b/.test(data.gcc_version));
  assert(Number.isSafeInteger(multiplier) && multiplier > 0);
  assert(Array.isArray(data.files) && data.files.length === 1, 'Expected the original single translation unit');
  const file = data.files[0];
  if (sourcePath !== undefined) assert.equal(file.file, sourcePath, 'gcov source identity differs from compiled input');
  const functions = Object.fromEntries(file.functions.map(value => [value.name, value.execution_count]));
  assert.equal(Object.keys(functions).length, file.functions.length, 'Duplicate function count');
  for (const value of Object.values(functions)) assert(Number.isSafeInteger(value) && value >= 0);
  for (const [name, count] of Object.entries(expected.functions))
    assert.equal(functions[name], count * multiplier, `Exact execution count: ${name}`);
  const branches = {};
  for (const [name, counts] of Object.entries(expected.branches)) {
    const lines = file.lines.filter(value => value.function_name === name && value.branches.length);
    branches[name] = lines.map(value => value.branches.map(branch => branch.count));
    assert.deepEqual(branches[name], counts.map(pair => pair.map(value => value * multiplier)), `Exact branch counts: ${name}`);
  }
  let loop;
  if ('main' in expected.functions) {
    const number = unit.code.split('\n').findIndex(line => line.includes('for (int index = -3;')) + 1;
    assert(number > 0, 'Missing independently specified loop');
    const line = file.lines.find(value => value.line_number === number && value.function_name === 'main');
    assert(line, 'No loop line in gcov output');
    loop = { line: number, branches: line.branches.map(branch => branch.count) };
    assert.deepEqual(loop.branches, [6 * multiplier, multiplier], 'Exact loop branches');
  }
  const lines = file.lines.map(value => {
    assert(Number.isSafeInteger(value.count) && value.count >= 0);
    assert(value.branches.every(branch => Number.isSafeInteger(branch.count) && branch.count >= 0));
    return { line: value.line_number, function: value.function_name, count: value.count,
      branches: value.branches.map(branch => branch.count) };
  });
  return { multiplier, functions, branches, ...(loop ? { loop } : {}), lines };
}
