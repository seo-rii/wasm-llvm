import assert from 'node:assert/strict';
import { inspectAliasObject } from './symbol-alias-inspect.mjs';

// Read linking metadata, rather than inferring TLS from text or byte patterns.
export function inspectTlsObject(bytes) {
  const inspection = inspectAliasObject(bytes);
  const module = new WebAssembly.Module(bytes);
  const linking = WebAssembly.Module.customSections(module, 'linking');
  assert.equal(linking.length, 1);
  const data = new Uint8Array(linking[0]), decoder = new TextDecoder('utf-8', { fatal: true });
  let pos = 0, limit = data.length;
  const byte = () => { assert(pos < limit, 'Truncated TLS metadata'); return data[pos++]; };
  const u32 = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const next = byte(); value += (next & 127) * 2 ** shift;
      if (!(next & 128)) { assert(value <= 0xffffffff, 'Invalid TLS metadata integer'); return value; }
    }
    assert.fail('Invalid TLS metadata LEB');
  };
  const name = () => { const length = u32(); assert(pos + length <= limit); const value = decoder.decode(data.subarray(pos, pos + length)); pos += length; return value; };
  assert.equal(u32(), 2);
  const segments = []; let segmentSections = 0;
  while (pos < data.length) {
    limit = data.length;
    const kind = byte(), length = u32(), end = pos + length;
    assert(end <= limit, 'Truncated linking subsection'); limit = end;
    if (kind === 5) {
      assert.equal(++segmentSections, 1, 'Duplicate segment-info subsection');
      for (let count = u32(); count; --count) {
        const segment = { name: name(), alignmentLog2: u32(), flags: u32() };
        assert(segment.alignmentLog2 <= 31, 'Invalid wasm32 segment alignment');
        segments.push(segment);
      }
      assert.equal(pos, end, 'Trailing segment metadata');
    }
    pos = end;
  }
  const tlsSymbols = inspection.symbols.filter(symbol => symbol.flags & 0x100);
  for (const symbol of tlsSymbols) assert.equal(symbol.kind, 'data', 'TLS flag on a non-data symbol');
  for (const symbol of inspection.symbols.filter(symbol => symbol.kind === 'data' && !symbol.undefined)) {
    assert(segments[symbol.segment], 'Missing data segment metadata');
    assert.equal(Boolean(symbol.flags & 0x100), Boolean(segments[symbol.segment].flags & 2),
      'TLS symbol and segment flags disagree');
  }
  const tlsRelocations = inspection.relocations.filter(relocation => relocation.type === 21);
  for (const relocation of tlsRelocations) {
    const symbol = inspection.symbols[relocation.index];
    assert(symbol?.kind === 'data' && (symbol.flags & 0x100), 'TLS relocation requires a TLS data symbol');
  }
  return { ...inspection, segments, tlsSymbols, tlsRelocations,
    hasTls: Boolean(tlsSymbols.length || tlsRelocations.length || segments.some(segment => segment.flags & 2)) };
}
