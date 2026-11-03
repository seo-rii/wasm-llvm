import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectTargetFeatures } from './inspect-target-features.mjs';

const u32 = number => { const bytes = []; do { let byte = number & 127; number >>>= 7; if (number) byte |= 128; bytes.push(byte); } while (number); return bytes; };
const name = text => { const bytes = [...Buffer.from(text)]; return [...u32(bytes.length), ...bytes]; };
const section = (label, data) => { const bytes = [...name(label), ...data]; return [0, ...u32(bytes.length), ...bytes]; };
const module = (...sections) => Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
const feature = (prefix, label) => [prefix.charCodeAt(0), ...name(label)];

test('reads explicit target features without classifying arbitrary 0xfd bytes', () => {
  const bytes = module(section('data-probe', [0xfd, 0x0c, ...Array(16).fill(0)]),
    section('target_features', [2, ...feature('+', 'simd128'), ...feature('-', 'atomics')]));
  assert.deepEqual(inspectTargetFeatures(bytes), { sections: ['data-probe', 'target_features'], features: { atomics: '-', simd128: '+' } });
  assert.deepEqual(inspectTargetFeatures(module(section('data-probe', [0xfd]))).features, {});
});

test('rejects duplicate feature metadata and malformed boundaries', () => {
  const valid = section('target_features', [1, ...feature('+', 'simd128')]);
  for (const bytes of [
    module(valid, valid),
    module(section('target_features', [2, ...feature('+', 'simd128'), ...feature('-', 'simd128')])),
    module(section('target_features', [1, ...feature('=', 'simd128')])),
    module(section('target_features', [1, 43, 0])),
    module(section('target_features', [1, 43, 1, 0xff])),
    module(section('target_features', [1, 43, 7, 115])),
    module(section('target_features', [0, 0])),
    module(section('target_features', [0x80, 0x80, 0x80, 0x80, 0x10])),
    module([0, 0x80]), module([0, 100, 0]), module(valid).subarray(0, -1),
  ]) assert.throws(() => inspectTargetFeatures(bytes));
});

test('preserves unknown UTF-8 feature names and multi-byte lengths', () => {
  const label = `future-${'x'.repeat(130)}-\u2603`;
  assert.deepEqual(inspectTargetFeatures(module(section('target_features', [1, ...feature('+', label)]))).features, { [label]: '+' });
});
