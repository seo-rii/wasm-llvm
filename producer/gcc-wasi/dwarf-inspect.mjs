import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Consume official LLVM textual/JSON output and public WebAssembly/CDP metadata.
// No code in this module decodes the private DWARF binary format.
export const dwarfIdentity = (bytes) => ({
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex')
});
export function llvmCodeSection(text) {
  const match = text.match(/^\s*\d+\s+CODE\s+([\da-f]+)\s+([\da-f]+)/im);
  assert(match, 'Official LLVM section headers lack CODE');
  return { size: Number.parseInt(match[1], 16), offset: Number.parseInt(match[2], 16) };
}
export function dwarfPc(filePc, codeOffset) {
  assert(Number.isSafeInteger(filePc) && Number.isSafeInteger(codeOffset) && filePc >= codeOffset);
  return filePc - codeOffset;
}
export function llvmDwarfDies(text) {
  const dies = [],
    stack = [];
  let current, attribute;
  for (const line of text.split('\n')) {
    const start = line.match(/^(0x[\da-f]+):([ ]+)(DW_TAG_\w+)/i);
    if (start) {
      const depth = start[2].length;
      while (stack.length && stack.at(-1).depth >= depth) stack.pop();
      current = {
        offset: start[1],
        tag: start[3],
        depth,
        attributes: {},
        parent: stack.at(-1),
        children: []
      };
      current.parent?.children.push(current);
      stack.push(current);
      dies.push(current);
      attribute = undefined;
    } else if (/^0x[\da-f]+:/i.test(line)) {
      current = undefined;
      attribute = undefined;
    } else if (current) {
      const match = line.match(/\b(DW_AT_\w+)(?:\s+\[[^\]]+\])?\s+(.*)/);
      if (match) {
        attribute = match[1];
        current.attributes[attribute] = match[2];
      } else if (attribute && line.trim()) current.attributes[attribute] += '\n' + line.trim();
    }
  }
  const byOffset = new Map(dies.map((die) => [die.offset.toLowerCase(), die]));
  for (const die of dies) {
    const reference = (die.attributes.DW_AT_specification ?? die.attributes.DW_AT_abstract_origin)
      ?.match(/0x[\da-f]+/i)?.[0]
      .toLowerCase();
    if (reference)
      Object.defineProperty(die, 'referent', { value: byOffset.get(reference), enumerable: false });
  }
  return dies;
}
export function dwarfDieName(die, seen = new Set()) {
  if (!die || seen.has(die)) return undefined;
  seen.add(die);
  return die.attributes.DW_AT_name?.match(/\("([^"]+)"\)/)?.[1] ?? dwarfDieName(die.referent, seen);
}
export function dwarfFunction(dies, name) {
  const matches = dies.filter(
    (die) =>
      die.tag === 'DW_TAG_subprogram' && dwarfDieName(die) === name && die.attributes.DW_AT_low_pc
  );
  assert.equal(matches.length, 1, `Expected one concrete DWARF function ${name}`);
  return matches[0];
}
export function dwarfFunctionRange(die) {
  const integer = (value) => Number.parseInt(value?.match(/0x([\da-f]+)/i)?.[1] ?? '', 16);
  const low = integer(die.attributes.DW_AT_low_pc),
    high = integer(die.attributes.DW_AT_high_pc);
  assert(
    Number.isSafeInteger(low) && Number.isSafeInteger(high) && low < high,
    'Expected a concrete contiguous function range'
  );
  return { low, high };
}
export function activeLlvmExpression(text, pc) {
  if (!text) return undefined;
  const ranges = [...text.matchAll(/\[0x([\da-f]+),\s*0x([\da-f]+)\):\s*([^\n]+)/gi)];
  if (ranges.length) {
    const selected = ranges.filter(
      (match) => pc >= Number.parseInt(match[1], 16) && pc < Number.parseInt(match[2], 16)
    );
    assert(selected.length <= 1, 'Overlapping active DWARF location ranges');
    return selected[0]?.[3].replace(/\)\s*$/, '').trim();
  }
  return text.match(/\((DW_OP_[^\n]+)\)/)?.[1].trim();
}
export function inspectLlvmLocation(expression, role = 'variable') {
  if (!expression) return { kind: 'unavailable' };
  const integer = (value) =>
    Number.parseInt(value.replace(/^0x/, ''), value.startsWith('0x') ? 16 : 10);
  const local = 'DW_OP_WASM_location 0x0 (0x[\\da-f]+|\\d+)';
  let match = expression.match(
    new RegExp('^' + local + (role === 'frame-base' ? ', DW_OP_stack_value' : '') + '$', 'i')
  );
  if (match) return { kind: 'local', index: integer(match[1]), stackValue: role === 'frame-base' };
  if (role === 'variable') {
    match = expression.match(/^DW_OP_fbreg ([+-]?\d+)$/);
    if (match) return { kind: 'frame-offset', offset: Number(match[1]) };
    match = expression.match(
      new RegExp('^' + local + ', DW_OP_piece (0x8|8), ' + local + ', DW_OP_piece (0x8|8)$', 'i')
    );
    if (match)
      return {
        kind: 'pieces',
        indices: [integer(match[1]), integer(match[3])],
        pieceBytes: [8, 8]
      };
  }
  throw new Error(`Unsupported observed ${role} location: ${expression}`);
}
export function inspectFunctionLocations(functionDie, pc) {
  const range = dwarfFunctionRange(functionDie),
    text = functionDie.attributes.DW_AT_frame_base;
  const frameBase = inspectLlvmLocation(activeLlvmExpression(text, pc), 'frame-base');
  const variables = [];
  function visit(die) {
    for (const child of die.children) {
      if (['DW_TAG_variable', 'DW_TAG_formal_parameter'].includes(child.tag))
        variables.push({
          name: dwarfDieName(child),
          tag: child.tag,
          expression: activeLlvmExpression(child.attributes.DW_AT_location, pc),
          location: inspectLlvmLocation(activeLlvmExpression(child.attributes.DW_AT_location, pc)),
          dieOffset: child.offset,
          type: child.attributes.DW_AT_type
        });
      else if (child.tag !== 'DW_TAG_subprogram') visit(child);
    }
  }
  visit(functionDie);
  return { range, frameBase, variables };
}
export function verifyPrologueLocationBoundary(functionDie, trapPc) {
  const range = dwarfFunctionRange(functionDie),
    text = functionDie.attributes.DW_AT_frame_base;
  const rows = [...(text ?? '').matchAll(/\[0x([\da-f]+),\s*0x([\da-f]+)\):/gi)];
  assert(rows.length, 'GCC frame base must be a genuine bounded location list');
  const low = Number.parseInt(rows[0][1], 16),
    high = Number.parseInt(rows.at(-1)[2], 16);
  assert(
    low > range.low && high === range.high,
    'Frame base must begin after the prologue and end at the exclusive function endpoint'
  );
  assert.equal(
    inspectLlvmLocation(activeLlvmExpression(text, range.low), 'frame-base').kind,
    'unavailable'
  );
  assert.equal(
    inspectLlvmLocation(activeLlvmExpression(text, high), 'frame-base').kind,
    'unavailable'
  );
  const active = inspectLlvmLocation(activeLlvmExpression(text, trapPc), 'frame-base');
  assert.equal(active.kind, 'local');
  return { functionLow: range.low, ready: low, endExclusive: high, trapPc, active };
}
export function cdpNumericLocal(frame, index) {
  const key = '$var' + index,
    item = frame.locals.find((value) => value.name === key);
  assert(item, `Actual CDP frame lacks ${key}`);
  const primitive = item.value;
  if (primitive.type === 'bigint') return BigInt(primitive.unserializableValue.replace(/n$/, ''));
  assert.equal(primitive.type, 'number');
  assert(Number.isFinite(primitive.value));
  return primitive.value;
}
export function measuredBoundaryVariables(locations, indices, prefix = 'r') {
  return indices.map((index) => {
    const candidates = locations.variables.filter(
      (variable) =>
        variable.name?.startsWith(prefix) &&
        variable.location.kind === 'local' &&
        variable.location.index === index
    );
    assert.equal(
      candidates.length,
      1,
      `Actual live source variable at Wasm local ${index} is required`
    );
    const variable = candidates[0],
      ordinal = Number(variable.name.slice(prefix.length));
    assert(Number.isSafeInteger(ordinal));
    return { name: variable.name, index, sourceOrdinal: ordinal };
  });
}
export function assertRecordType(dies, name, expectedSize = 24) {
  const candidates = dies.filter(
    (die) =>
      ['DW_TAG_structure_type', 'DW_TAG_class_type'].includes(die.tag) &&
      dwarfDieName(die) === name &&
      die.attributes.DW_AT_byte_size
  );
  assert(candidates.length, `Missing complete type ${name}`);
  for (const die of candidates) {
    const size = Number.parseInt(
      die.attributes.DW_AT_byte_size.match(/0x([\da-f]+)/i)?.[1] ?? '',
      16
    );
    assert.equal(size, expectedSize);
    const members = Object.fromEntries(
      die.children
        .filter((child) => child.tag === 'DW_TAG_member')
        .map((child) => [
          dwarfDieName(child),
          Number.parseInt(
            child.attributes.DW_AT_data_member_location?.match(/0x([\da-f]+)/i)?.[1] ?? '',
            16
          )
        ])
    );
    assert.deepEqual(members, { tag: 0, wide: 8, ratio: 16 });
  }
  return {
    name,
    size: expectedSize,
    members: { tag: 0, wide: 8, ratio: 16 },
    concreteDefinitions: candidates.length
  };
}
export async function inspectDwarfCustomSections(bytes, required = true) {
  const module = await WebAssembly.compile(bytes),
    result = {};
  for (const name of [
    '.debug_info',
    '.debug_abbrev',
    '.debug_line',
    '.debug_str',
    '.debug_loc',
    '.debug_ranges',
    '.debug_aranges',
    '.debug_pubnames',
    '.debug_pubtypes',
    '.debug_types',
    '.debug_frame',
    '.debug_macro',
    '.debug_macinfo'
  ]) {
    const sections = WebAssembly.Module.customSections(module, name);
    assert(sections.length <= 1, `Duplicate ${name}`);
    if (sections.length) result[name] = dwarfIdentity(Buffer.from(sections[0]));
  }
  if (required)
    for (const name of ['.debug_info', '.debug_abbrev', '.debug_line'])
      assert(result[name]?.bytes > 0, `Missing genuine ${name}`);
  else if (required === false)
    assert.equal(Object.keys(result).length, 0, 'Release/strip output retains DWARF');
  return result;
}

export function assertUserCompilationUnit(text, sourcePath) {
  assert(/format = DWARF32, version = 0x0004/.test(text), 'User object must use DWARF32/DWARF4');
  assert(/addr_size = 0x04/.test(text), 'Wasm32 debug addresses must be four bytes');
  const units = llvmDwarfDies(text).filter((die) => die.tag === 'DW_TAG_compile_unit');
  const matches = units.filter((unit) => {
    const name = dwarfDieName(unit),
      directory = unit.attributes.DW_AT_comp_dir?.match(/"([^"]+)"/)?.[1] ?? '';
    return name && path.resolve(directory, name) === path.resolve(sourcePath);
  });
  assert.equal(matches.length, 1, 'Debug object must identify its exact original user source');
  return { source: path.resolve(sourcePath), format: 'DWARF32', version: 4, addressBytes: 4 };
}
export function assertWideTypes(dies) {
  return ['long double', '__int128 unsigned'].map((name) => {
    const type = dies.find((die) => die.tag === 'DW_TAG_base_type' && dwarfDieName(die) === name);
    assert(type, `Missing genuine wide base type ${name}`);
    const size = Number.parseInt(
      type.attributes.DW_AT_byte_size.match(/0x([\da-f]+)/i)?.[1] ?? '',
      16
    );
    assert.equal(size, 16);
    return { name, bytes: size, encoding: type.attributes.DW_AT_encoding };
  });
}

// Consumer callbacks execute the official tools against the exact original and
// analysis-only program identities. The value checks below inspect bounded
// fixture expressions and actual public CDP locals/memory, not DWARF binaries.
function successfulDwarfCommand(result) {
  assert.equal(result.status, 0, result.stderr || result.error || 'Official DWARF tool failed');
  assert.equal(result.signal, null);
  assert(!result.error);
  return result;
}
export function consumeDwarfPc({ program, fixture, name, pc, run, toolPaths, cwd }) {
  const lookup = successfulDwarfCommand(
    run(toolPaths.llvmDwarf, ['--lookup=0x' + pc.toString(16), program.program.path])
  );
  const expectedDie = dwarfFunction(program.dies, name),
    selectedDie = llvmDwarfDies(lookup.stdout).find((die) => die.offset === expectedDie.offset);
  assert.equal(
    selectedDie?.tag,
    'DW_TAG_subprogram',
    'Official lookup must select the exact function DIE'
  );
  const symbol = successfulDwarfCommand(
    run(toolPaths.symbolizer, [
      '--no-debuginfod',
      '--output-style=JSON',
      '--obj=' + program.consumer.path,
      '0x' + pc.toString(16)
    ])
  );
  const source = JSON.parse(symbol.stdout)[0].Symbol[0];
  assert.equal(source.FunctionName.split('(')[0], name);
  assert(source.Line > 0 && source.FileName);
  const expectedSourceLines = fixture.expected.sourceLines?.[name];
  assert(
    Array.isArray(expectedSourceLines) && expectedSourceLines.length > 0,
    'Every source frame needs independent original statement lines'
  );
  assert(
    expectedSourceLines.includes(source.Line),
    `Official source line ${source.Line} must match original ${name} statement lines ${expectedSourceLines}`
  );
  const originalSource = fixture.expected.functionSources[name];
  assert(originalSource, 'Every observed source frame needs an independent fixture source');
  assert.equal(
    path.resolve(source.FileName),
    program.sourcePaths?.[originalSource] ??
      program.files.find((file) => file.path.endsWith('/' + originalSource))?.path,
    'Official source consumer must select the exact source, including duplicate basenames'
  );
  const frame = successfulDwarfCommand(
    run(
      toolPaths.symbolizer,
      ['--no-debuginfod', '--output-style=JSON'],
      cwd,
      `FRAME ${program.program.path} 0x${pc.toString(16)}\n`
    )
  );
  return {
    lookup,
    symbol,
    source,
    expectedSourceLines,
    frame,
    officialFrame: JSON.parse(frame.stdout)
  };
}
export function sourceFramesFromNodeTrap(program, fixture, nodeTrap, consumeAtPc) {
  const pcs = [...nodeTrap.stderr.matchAll(/wasm-function\[\d+\]:0x([\da-f]+)/gi)].map((match) =>
    Number.parseInt(match[1], 16)
  );
  assert(pcs.length);
  return fixture.expected.frames.map((name) => {
    const die = dwarfFunction(program.dies, name),
      range = dwarfFunctionRange(die),
      filePc = pcs.find(
        (pc) =>
          dwarfPc(pc, program.code.offset) >= range.low &&
          dwarfPc(pc, program.code.offset) < range.high
      );
    assert(filePc !== undefined, `Runtime stack lacks ${name}`);
    const pc = dwarfPc(filePc, program.code.offset),
      consumers = consumeAtPc(name, pc);
    const locations = inspectFunctionLocations(die, pc);
    const boundary =
      locations.frameBase.kind === 'local' ? verifyPrologueLocationBoundary(die, pc) : null;
    const measured =
      fixture.family === 'local-boundary' && name === 'boundary_leaf'
        ? measuredBoundaryVariables(locations, fixture.expected.actualLocalIndices)
        : [];
    const wanted = new Set();
    if (locations.frameBase.kind === 'local') wanted.add(locations.frameBase.index);
    const expected =
      fixture.expected.values?.[name] ??
      Object.fromEntries(
        measured.map((item) => [item.name, fixture.expected.seed + item.sourceOrdinal])
      );
    for (const [variableName] of Object.entries(expected)) {
      const variable = locations.variables.find((item) => item.name === variableName);
      assert(variable, `Missing source variable ${name}.${variableName}`);
      assert.notEqual(
        variable.location.kind,
        'unavailable',
        `Unavailable required O0 variable ${name}.${variableName}`
      );
      if (variable.location.kind === 'local') wanted.add(variable.location.index);
      if (variable.location.kind === 'pieces')
        for (const index of variable.location.indices) wanted.add(index);
    }
    return {
      name,
      filePc,
      pc,
      range,
      ...consumers,
      locations,
      boundary,
      measured,
      expected,
      wantedIndices: [...wanted]
    };
  });
}

export function verifyLiveDwarfValues(fixture, program, frames, pause, consumeAtPc) {
  const memory = new DataView(Uint8Array.from(pause.memory).buffer),
    proofs = [];
  for (const plan of frames) {
    const actual = pause.frames.find((frame) => frame.name === plan.name);
    assert(actual, `Actual paused caller frame missing ${plan.name}`);
    const die = dwarfFunction(program.dies, plan.name),
      consumers = consumeAtPc(plan.name, actual.pc),
      locations = inspectFunctionLocations(die, actual.pc);
    const boundary =
      locations.frameBase.kind === 'local' ? verifyPrologueLocationBoundary(die, actual.pc) : null;
    const measured =
      fixture.family === 'local-boundary' && plan.name === 'boundary_leaf'
        ? measuredBoundaryVariables(locations, fixture.expected.actualLocalIndices)
        : [];
    assert.deepEqual(
      measured,
      plan.measured,
      'Actual host PCs disagree on the measured live locals'
    );
    const frameBase =
      locations.frameBase.kind === 'local'
        ? Number(cdpNumericLocal(actual, locations.frameBase.index))
        : undefined;
    const values = {};
    for (const [name, expected] of Object.entries(plan.expected)) {
      const location = locations.variables.find((variable) => variable.name === name)?.location;
      assert(location && location.kind !== 'unavailable');
      if (expected && typeof expected === 'object' && expected.type?.endsWith('-pieces')) {
        assert.equal(location.kind, 'pieces');
        assert.deepEqual(location.pieceBytes, [8, 8]);
        const pieces = location.indices.map(
          (index) => '0x' + BigInt.asUintN(64, BigInt(cdpNumericLocal(actual, index))).toString(16)
        );
        assert.deepEqual(pieces, [expected.low, expected.high]);
        values[name] = { location, pieces };
      } else if (expected && typeof expected === 'object' && expected.type === 'argv-pointer') {
        let pointer;
        if (location.kind === 'local')
          pointer = Number(cdpNumericLocal(actual, location.index)) >>> 0;
        else {
          assert.equal(location.kind, 'frame-offset');
          const official = consumers.officialFrame.Frame.find((variable) => variable.Name === name);
          assert.equal(official.FrameOffset, location.offset);
          assert.equal(official.Size, '0x4');
          assert(Number.isSafeInteger(frameBase));
          pointer = memory.getUint32(frameBase + official.FrameOffset, true);
        }
        const strings = expected.strings.map((_, index) => {
          const address = memory.getUint32(pointer + index * 4, true),
            bytes = [];
          for (let offset = 0; offset < 128; offset++) {
            const byte = memory.getUint8(address + offset);
            if (!byte) return new TextDecoder().decode(Uint8Array.from(bytes));
            bytes.push(byte);
          }
          throw new Error('Argument exceeds bounded fixture length');
        });
        assert.deepEqual(strings, expected.strings);
        values[name] = { location, pointer, strings };
      } else if (expected && typeof expected === 'object' && expected.members) {
        assert.equal(location.kind, 'frame-offset');
        assert(Number.isSafeInteger(frameBase));
        const official = consumers.officialFrame.Frame.find((variable) => variable.Name === name);
        assert.equal(official.FrameOffset, location.offset);
        assert.equal(Number.parseInt(official.Size, 16), expected.size);
        const members = {};
        for (const [member, spec] of Object.entries(expected.members)) {
          const address = frameBase + official.FrameOffset + spec.offset;
          const value =
            spec.type === 'i32'
              ? memory.getInt32(address, true)
              : spec.type === 'u64'
                ? '0x' + memory.getBigUint64(address, true).toString(16)
                : memory.getFloat64(address, true);
          assert.equal(value, spec.value);
          members[member] = value;
        }
        values[name] = { location, officialFrameOffset: official.FrameOffset, members };
      } else {
        let value;
        if (location.kind === 'local') value = Number(cdpNumericLocal(actual, location.index));
        else {
          assert.equal(location.kind, 'frame-offset');
          assert(Number.isSafeInteger(frameBase));
          const official = consumers.officialFrame.Frame.find((variable) => variable.Name === name);
          assert.equal(official.FrameOffset, location.offset);
          assert.equal(official.Size, '0x4');
          value = memory.getInt32(frameBase + official.FrameOffset, true);
        }
        assert.equal(value, expected, `Actual source value ${plan.name}.${name}`);
        values[name] = { location, value };
      }
    }
    proofs.push({
      name: plan.name,
      pc: actual.pc,
      consumers,
      frameBase,
      frameBaseLocation: locations.frameBase,
      actualLocalCount: actual.localCount,
      values,
      boundary,
      measuredLocalIndices: measured
    });
  }
  return proofs;
}
