import assert from 'node:assert/strict';

// Read only the type/function/export tables after engine validation. Imported
// functions precede defined functions in the function index space. Data bytes
// and code immediates are never interpreted as type or feature metadata.
export function inspectVectorAbi(bytes) {
  new WebAssembly.Module(bytes);
  let pos = 8;
  const readByte = () => { assert(pos < bytes.length, 'Truncated module'); return bytes[pos++]; };
  const u32 = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = readByte(); value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) { assert(value <= 0xffffffff); return value; }
    }
    assert.fail('Invalid u32');
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const name = () => { const size = u32(); const value = decoder.decode(bytes.subarray(pos, pos + size)); pos += size; return value; };
  const valueType = () => {
    const code = readByte(), type = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref' }[code];
    assert(type, `Unexpected value type ${code}`); return type;
  };
  const limits = () => { const flags = u32(); const minimum = u32(); const maximum = flags & 1 ? u32() : null; assert(!(flags & ~3), 'Unsupported memory/table limits'); return { minimum, maximum, shared: Boolean(flags & 2) }; };
  const types = [], functions = [], exports = [], memories = [];
  while (pos < bytes.length) {
    const section = readByte(), length = u32(), end = pos + length;
    assert(end <= bytes.length);
    if (section === 1) for (let count = u32(); count; --count) {
      assert.equal(readByte(), 0x60, 'Expected function type');
      const params = Array.from({ length: u32() }, valueType), results = Array.from({ length: u32() }, valueType);
      types.push({ params, results });
    }
    if (section === 2) for (let count = u32(); count; --count) {
      name(); name(); const kind = readByte();
      if (kind === 0) functions.push(u32());
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
  return { exports: Object.fromEntries(exports), memories };
}
