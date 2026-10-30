import assert from 'node:assert/strict';

// Inspect actual linking-v2 symbol and relocation sections. A function alias
// shares an entity index, while its relocations retain a distinct symbol index.
export function inspectAliasObject(bytes) {
  const module = new WebAssembly.Module(bytes);
  const imports = Object.groupBy(WebAssembly.Module.imports(module), value => value.kind);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  class Reader {
    constructor(start, end) { this.pos = start; this.end = end; }
    byte() { assert(this.pos < this.end, 'Truncated object metadata'); return bytes[this.pos++]; }
    u32() {
      let value = 0;
      for (let shift = 0; shift <= 28; shift += 7) {
        const byte = this.byte(); value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) { assert(value <= 0xffffffff, 'Invalid metadata u32'); return value; }
      }
      assert.fail('Invalid metadata LEB');
    }
    s32() {
      let value = 0n, shift = 0n;
      for (let i = 0; i < 5; i++) {
        const byte = this.byte(); value |= BigInt(byte & 127) << shift; shift += 7n;
        if (!(byte & 128)) {
          if (byte & 64) value -= 1n << shift;
          assert(value >= -2147483648n && value <= 2147483647n, 'Invalid relocation addend');
          return Number(value);
        }
      }
      assert.fail('Invalid signed metadata LEB');
    }
    name() { const size = this.u32(); assert(this.pos + size <= this.end, 'Truncated symbol name'); const value = decoder.decode(bytes.subarray(this.pos, this.pos + size)); this.pos += size; return value; }
    done() { assert.equal(this.pos, this.end, 'Trailing object metadata'); }
  }
  const sections = [], symbols = [], relocations = [];
  let pos = 8, linkingCount = 0, symbolTableCount = 0;
  while (pos < bytes.length) {
    const r = new Reader(pos, bytes.length), id = r.byte(), length = r.u32(), start = r.pos, end = start + length;
    assert(end <= bytes.length, 'Truncated object section');
    const payload = new Reader(start, end), name = id === 0 ? payload.name() : null;
    sections.push({ id, name, start, end, content: payload.pos }); pos = end;
  }
  const kinds = { 0: 'function', 1: 'data', 2: 'global', 3: 'section', 4: 'tag', 5: 'table' };
  for (const section of sections.filter(section => section.name === 'linking')) {
    assert.equal(++linkingCount, 1, 'Duplicate linking section');
    const r = new Reader(section.content, section.end); assert.equal(r.u32(), 2, 'Expected linking version2');
    while (r.pos < r.end) {
      const kind = r.byte(), size = r.u32(), end = r.pos + size; assert(end <= r.end, 'Truncated linking subsection');
      if (kind === 8) {
        assert.equal(++symbolTableCount, 1, 'Duplicate symbol table'); const table = new Reader(r.pos, end);
        for (let count = table.u32(); count; --count) {
          const type = table.byte(), flags = table.u32(), symbol = { symbolIndex: symbols.length, kind: kinds[type], flags,
            binding: ['global', 'weak', 'local', 'common'][flags & 3], visibility: flags & 4 ? 'hidden' : 'default', undefined: Boolean(flags & 16) };
          assert(symbol.kind, 'Unsupported symbol kind');
          if (type === 1) {
            symbol.name = table.name();
            if (!symbol.undefined) {
              if (symbol.binding !== 'common') { symbol.segment = table.u32(); symbol.offset = table.u32(); }
              symbol.size = table.u32();
              if (symbol.binding === 'common') symbol.alignment = table.byte();
            }
          } else if (type === 3) { symbol.sectionIndex = table.u32(); }
          else {
            symbol.entityIndex = table.u32();
            symbol.name = !symbol.undefined || flags & 64 ? table.name() : imports[symbol.kind]?.[symbol.entityIndex]?.name;
            assert(typeof symbol.name === 'string', 'Missing imported symbol name');
          }
          symbols.push(symbol);
        }
        table.done();
      }
      r.pos = end;
    }
    r.done();
  }
  assert.equal(linkingCount, 1, 'Missing linking section'); assert.equal(symbolTableCount, 1, 'Missing symbol table');
  const sectionCount = id => {
    const section = sections.find(section => section.id === id);
    return section ? new Reader(section.start, section.end).u32() : 0;
  };
  const importedFunctions = imports.function?.length || 0;
  const functionCount = importedFunctions + sectionCount(3), dataCount = sectionCount(11);
  for (const symbol of symbols) {
    if (symbol.kind === 'function') {
      assert(symbol.entityIndex < functionCount, 'Function symbol index out of range');
      assert.equal(symbol.entityIndex < importedFunctions, symbol.undefined, 'Function import/definition mismatch');
    }
    if (symbol.kind === 'data' && !symbol.undefined && symbol.binding !== 'common')
      assert(symbol.segment < dataCount, 'Data symbol segment out of range');
  }
  const addends = new Set([3, 4, 5, 8, 9, 11, 21, 23]);
  const allowed = new Set([...Array.from({length: 14}, (_, i) => i), 20, 21, 23, 26]);
  for (const section of sections.filter(section => section.name?.startsWith('reloc.'))) {
    const r = new Reader(section.content, section.end), sectionIndex = r.u32(), target = sections[sectionIndex];
    assert(target, 'Invalid relocation target section');
    for (let count = r.u32(); count; --count) {
      const type = r.u32(), offset = r.u32(), index = r.u32(); assert(allowed.has(type), 'Unsupported wasm32 relocation');
      assert(offset < target.end - target.start, 'Relocation outside target section');
      const addend = addends.has(type) ? r.s32() : 0;
      const symbol = type === 6 ? null : symbols[index];
      assert(type === 6 || symbol, 'Invalid relocation symbol index');
      const expectedKind = { 0:'function', 1:'function', 2:'function', 3:'data', 4:'data', 5:'data', 7:'global', 8:'function', 9:'section', 10:'tag', 11:'data', 12:'function', 13:'global', 20:'table', 21:'data', 23:'data', 26:'function' }[type];
      if (expectedKind) assert.equal(symbol.kind, expectedKind, 'Relocation has wrong symbol kind');
      relocations.push({ section: section.name, targetSection: target.id, type, offset, index, addend, symbol: symbol?.name ?? null });
    }
    r.done();
  }
  return { symbols, relocations, functionDefinitions: new Set(symbols.filter(s => s.kind === 'function' && !s.undefined).map(s => s.entityIndex)).size };
}

export function verifyAliasDefinitions(inspection, fixture) {
  const byName = new Map();
  for (const symbol of inspection.symbols) if (symbol.name !== undefined) {
    assert(!byName.has(symbol.name), 'Duplicate linking symbol ' + symbol.name); byName.set(symbol.name, symbol);
  }
  for (const group of fixture.aliasGroups) {
    const values = group.names.map(name => { const symbol = byName.get(name); assert(symbol, 'Missing alias symbol ' + name); assert(!symbol.undefined, 'Undefined alias symbol ' + name); assert.equal(symbol.kind, group.kind); return symbol; });
    const location = symbol => group.kind === 'function' ? symbol.entityIndex : [symbol.segment, symbol.offset, symbol.size];
    for (const symbol of values) {
      assert.notEqual(symbol.binding, 'weak', 'Strong aliases must not become weak');
      assert.deepEqual(location(symbol), location(values[0]), 'Alias has separate body or storage: ' + symbol.name);
      if (group.size !== undefined) assert.equal(symbol.size, group.size);
    }
  }
  for (const [name, expected] of Object.entries(fixture.visibility || {})) assert.equal(byName.get(name)?.visibility, expected, 'Alias visibility ' + name);
  for (const name of fixture.localSymbols || []) assert.equal(byName.get(name)?.binding, 'local', 'Alias local binding ' + name);
  return true;
}
