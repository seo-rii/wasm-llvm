import assert from 'node:assert/strict';

// Read only the type/function/export tables after engine validation. Imported
// functions precede defined functions in the function index space. Data bytes
// and code immediates are never interpreted as type or feature metadata.
function inspectAbi(bytes, objectSymbols = false) {
  new WebAssembly.Module(bytes);
  let pos = 8, limit = bytes.length;
  const readByte = () => { assert(pos < limit, 'Truncated module section'); return bytes[pos++]; };
  const u32 = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = readByte(); value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) { assert(value <= 0xffffffff); return value; }
    }
    assert.fail('Invalid u32');
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const name = () => { const size = u32(); assert(pos + size <= limit, 'Truncated Wasm name'); const value = decoder.decode(bytes.subarray(pos, pos + size)); pos += size; return value; };
  const valueType = () => {
    const code = readByte(), type = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref' }[code];
    assert(type, `Unexpected value type ${code}`); return type;
  };
  const limits = () => { const flags = u32(); const minimum = u32(); const maximum = flags & 1 ? u32() : null; assert(!(flags & ~3), 'Unsupported memory/table limits'); return { minimum, maximum, shared: Boolean(flags & 2) }; };
  const types = [], functions = [], functionImports = [], exports = [], memories = [], symbols = [];
  let linkingCount = 0, symbolTableCount = 0;
  while (pos < bytes.length) {
    limit = bytes.length;
    const section = readByte(), length = u32(), end = pos + length;
    assert(end <= bytes.length);
    limit = end;
    if (section === 0 && objectSymbols && name() === 'linking') {
      assert.equal(++linkingCount, 1, 'Duplicate linking section');
      assert.equal(u32(), 2, 'Unsupported linking metadata version');
      while (pos < end) {
        const subsection = readByte(), size = u32(), subsectionEnd = pos + size;
        assert(subsectionEnd <= end, 'Truncated linking subsection');
        limit = subsectionEnd;
        if (subsection === 8) {
          assert.equal(++symbolTableCount, 1, 'Duplicate linking symbol table');
          for (let count = u32(); count; --count) {
            const kind = readByte(), flags = u32(), undefinedSymbol = Boolean(flags & 0x10);
            if ([0, 2, 4, 5].includes(kind)) {
              const index = u32();
              const symbol = !undefinedSymbol || (flags & 0x40) ? name() : null;
              if (kind === 0) symbols.push({ index, symbol, flags });
            } else if (kind === 1) {
              name();
              if (!undefinedSymbol) {
                // Common data symbols omit the segment/offset and carry an alignment byte.
                if ((flags & 3) !== 3) { u32(); u32(); }
                u32();
                if ((flags & 3) === 3) readByte();
              }
            } else if (kind === 3) u32();
            else assert.fail(`Unsupported linking symbol kind ${kind}`);
          }
          assert.equal(pos, subsectionEnd, 'Trailing linking symbol bytes');
        }
        pos = subsectionEnd; limit = end;
      }
    }
    if (section === 1) for (let count = u32(); count; --count) {
      assert.equal(readByte(), 0x60, 'Expected function type');
      const params = Array.from({ length: u32() }, valueType), results = Array.from({ length: u32() }, valueType);
      types.push({ params, results });
    }
    if (section === 2) for (let count = u32(); count; --count) {
      name(); const symbol = name(), kind = readByte();
      if (kind === 0) { functions.push(u32()); functionImports.push(symbol); }
      else if (kind === 1) { valueType(); limits(); }
      else if (kind === 2) memories.push(limits());
      else if (kind === 3) { valueType(); readByte(); }
      else assert.fail(`Unsupported import kind ${kind}`);
    }
    if (section === 3) for (let count = u32(); count; --count) functions.push(u32());
    if (section === 5) for (let count = u32(); count; --count) memories.push(limits());
    if (section === 7) for (let count = u32(); count; --count) {
      const symbol = name(), kind = readByte(), index = u32();
      if (kind === 0) { assert(types[functions[index]], `Missing function type for ${symbol}`); exports.push([symbol, types[functions[index]]]); }
    }
    assert(pos <= end); pos = end;
  }
  const signatures = new Map();
  if (objectSymbols) {
    assert.equal(linkingCount, 1, 'Missing linking section');
    assert.equal(symbolTableCount, 1, 'Missing linking symbol table');
    for (const { index, symbol, flags } of symbols) {
      const signature = types[functions[index]];
      assert(signature, 'Linking function index out of bounds');
      assert.equal(Boolean(flags & 0x10), index < functionImports.length, 'Linking function import flag mismatch');
      assert.notEqual(flags & 3, 3, 'Function symbol cannot use common binding');
      const key = symbol ?? functionImports[index];
      assert.equal(typeof key, 'string', 'Missing linking function name');
      // Local symbol names are not globally unique and do not bind other objects.
      if ((flags & 3) === 2) continue;
      assert(!signatures.has(key), `Duplicate linking function symbol ${key}`);
      signatures.set(key, signature);
    }
  }
  return { exports: Object.fromEntries(exports), memories, signatures: Object.fromEntries(signatures) };
}

export function inspectVectorAbi(bytes) {
  const { exports, memories } = inspectAbi(bytes);
  return { exports, memories };
}

// Linking v2 symbols name both caller imports and provider definitions. Resolve
// their actual function indices/types, independent of exports, WAT or debug names.
export function inspectObjectFunctionSignatures(bytes) {
  return inspectAbi(bytes, true).signatures;
}
