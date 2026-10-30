import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversionInstructions, verifyConversionInstructions } from './simd-conversions-inspect.mjs';

test('qualification requires the conversion body, not another function or raw prefix bytes', () => {
  const dump = `000010 func[1] <helper>:
 000011: fd f8 01 | i32x4.trunc_sat_f32x4_s
000020 func[2] <convert>:
 000021: 01 7f | local[0] type=i32
 000023: 41 fd 01 | i32.const 253
 000026: 0b | end
`;
  const converted = conversionInstructions(dump);
  assert.deepEqual(converted, { index: 2, name: 'convert', instructions: ['i32.const', 'end'] });
  assert.throws(() => verifyConversionInstructions({ requiredInstructions: ['i32x4.trunc_sat_f32x4_s'], forbiddenInstructions: [] }, converted));
});

test('multibyte SIMD subopcodes and mangled C++ conversion names remain inspectable', () => {
  const converted = conversionInstructions(`000010 func[4] <_ZL7convertDv4_f>:
 000011: 20 00 | local.get 0
 000013: fd f9 01 | i32x4.trunc_sat_f32x4_u
 000016: 0b | end
`);
  verifyConversionInstructions({ requiredInstructions: ['i32x4.trunc_sat_f32x4_u'], forbiddenInstructions: [] }, converted);
  assert.throws(() => conversionInstructions('000001 func[0] <main>:\n 000002: 0b | end\n'));
  assert.throws(() => conversionInstructions('000001 func[0] <convert>:\n 000002: 0b | end\n000004 func[1] <convert>:\n 000005: 0b | end\n'));
});

test('fallback proof requires real scalar conversion instructions', () => {
  const fixture = { requiredInstructions: [], forbiddenInstructions: [], semanticKind: 'scalar-fallback-integer-to-float' };
  assert.throws(() => verifyConversionInstructions(fixture, { instructions: ['v128.load', 'end'] }));
  verifyConversionInstructions(fixture, { instructions: ['i64x2.extract_lane', 'f64.convert_i64_s', 'f64x2.replace_lane'] });
  verifyConversionInstructions({ ...fixture, semanticKind: 'scalar-fallback-float-to-integer' }, { instructions: ['i64.trunc_f64_u'] });
});
