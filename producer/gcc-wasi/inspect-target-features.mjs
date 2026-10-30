import assert from 'node:assert/strict';

// Inspect section structure only; instruction/immediate decoding remains an
// independent SDK/engine check. Relocatable objects need not engine-validate.
export function inspectTargetFeatures(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0], 'Expected Wasm');
  let offset = 8, end = bytes.length;
  const byte = () => { assert(offset < end, 'Truncated section'); return bytes[offset++]; };
  const u32 = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const next = byte(); value += (next & 127) * 2 ** shift;
      if (!(next & 128)) { assert(value <= 0xffffffff, 'Overflowing u32'); return value; }
    }
    assert.fail('Invalid u32');
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const name = () => { const size = u32(); assert(size <= end - offset, 'Truncated name'); const value = decoder.decode(bytes.subarray(offset, offset + size)); offset += size; return value; };
  const sections = [], features = new Map();
  let featureSections = 0;
  while (offset < bytes.length) {
    end = bytes.length;
    const id = byte(), size = u32();
    assert(size <= bytes.length - offset, 'Truncated module');
    end = offset + size;
    if (id === 0) {
      const label = name(); sections.push(label);
      if (label === 'target_features') {
        assert.equal(++featureSections, 1, 'Duplicate target_features section');
        for (let count = u32(); count; --count) {
          const prefix = String.fromCharCode(byte()), feature = name();
          assert(prefix === '+' || prefix === '-', 'Invalid feature prefix');
          assert(feature && !features.has(feature), 'Empty or duplicate feature name');
          features.set(feature, prefix);
        }
        assert.equal(offset, end, 'Trailing target_features data');
      }
    } else sections.push(id);
    offset = end;
  }
  return { sections, features: Object.fromEntries([...features].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}
