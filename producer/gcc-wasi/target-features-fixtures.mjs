// Real assembler inputs. Feature flags alone must not mark scalar output SIMD.
const encoded = bytes => bytes.map(byte => `\\${byte.toString(16).padStart(2, '0')}`).join('');
const custom = bytes => `(@custom "target_features" "${encoded(bytes)}")`;
const feature = (prefix, name) => [prefix.charCodeAt(0), name.length, ...Buffer.from(name)];
const section = (...entries) => custom([entries.length, ...entries.flatMap(([prefix, name]) => feature(prefix, name))]);
const run = code => `(func $run (export "run") (@sym (name "run")) (result i32) ${code})`;
const scalar = run('i32.const 42');
const vector = run('v128.const i32x4 1 2 3 4 v128.const i32x4 41 40 39 38 i32x4.add i32x4.extract_lane 0');
const relaxed = run('v128.const i32x4 0 0 0 0 v128.const i32x4 0 0 0 0 i8x16.relaxed_swizzle i8x16.extract_lane_s 0');
const make = (id, body, features = {}, result = 42, extra = {}) => ({ id, wat: `(module ${body})`, features, result, ...extra });

export const watCases = [
  make('scalar', scalar),
  make('scalar-integer-fd', run('i32.const 253'), {}, 253, { containsFd: true }),
  make('scalar-float-fd', run('f32.const nan:0x4000fd drop i32.const 42'), {}, 42, { containsFd: true }),
  make('scalar-data-fd', `(memory 1) (data (i32.const 0) "\\fd\\0c") ${scalar}`, {}, 42, { containsFd: true }),
  make('scalar-custom-fd', `(@custom "probe" "\\fd") ${scalar}`, {}, 42, { containsFd: true }),
  make('v128-local', run('(local v128) i32.const 42'), { simd128: '+' }, 42, { usesSimd: true }),
  make('v128-function-type', `(func $vector (@sym (name "vector")) (param v128) (result v128) local.get 0) ${scalar}`, { simd128: '+' }, 42, { usesSimd: true }),
  make('v128-import-type', `(import "env" "vector" (func $vector (@sym (name "vector")) (param v128))) ${scalar}`, { simd128: '+' }, 42, { usesSimd: true }),
  make('simd-instructions', vector, { simd128: '+' }, 42, { usesSimd: true }),
  make('v128-global', `(global v128 (v128.const i32x4 0 0 0 0)) ${scalar}`, { simd128: '+' }, 42,
    { usesSimd: true, linkError: 'invalid opcode in init_expr: 253' }),
  make('relaxed-simd', relaxed, { 'relaxed-simd': '+', simd128: '+' }, 0, { usesSimd: true, flags: ['--enable-relaxed-simd'] }),
  make('merge-existing', `${section(['+', 'sign-ext'])} ${vector}`, { 'sign-ext': '+', simd128: '+' }, 42, { usesSimd: true }),
  make('merge-duplicate-sections', `${section(['+', 'simd128'])} ${section(['+', 'simd128'])} ${vector}`, { simd128: '+' }, 42, { usesSimd: true }),
  make('merge-duplicate-entries', `${section(['+', 'simd128'], ['+', 'simd128'])} ${vector}`, { simd128: '+' }, 42, { usesSimd: true }),
  make('preserve-explicit-feature', `${section(['+', 'sign-ext'], ['-', 'atomics'])} ${scalar}`, { atomics: '-', 'sign-ext': '+' }),
  make('preserve-simd-prohibition', `${section(['-', 'simd128'])} ${scalar}`, { simd128: '-' }),
  make('empty-feature-section', `${custom([0])} ${scalar}`),
  make('after-producers', `${section(['+', 'simd128'])} (@custom "producers" "\\00") ${vector}`, { simd128: '+' }, 42, { usesSimd: true }),
  ...[
    ['missing-count', []], ['truncated-count', [0x80]], ['overflow-count', [0x80, 0x80, 0x80, 0x80, 0x10]],
    ['invalid-prefix', [1, ...feature('=', 'simd128')]], ['missing-name', [1, 43]],
    ['empty-name', [1, 43, 0]], ['truncated-name', [1, 43, 7, 115]],
    ['invalid-utf8-name', [1, 43, 1, 0xff]], ['trailing-data', [0, 0]],
  ].map(([id, bytes]) => make(`reject-${id}`, `${custom(bytes)} ${scalar}`, {}, 42, { reject: true })),
  make('reject-conflicting-sections', `${section(['+', 'simd128'])} ${section(['-', 'simd128'])} ${scalar}`, {}, 42, { reject: true }),
  make('reject-simd-prohibition', `${section(['-', 'simd128'])} ${vector}`, {}, 42, { reject: true }),
  make('reject-v128-type-prohibition', `${section(['-', 'simd128'])} ${run('(local v128) i32.const 42')}`, {}, 42, { reject: true }),
  make('reject-relaxed-prohibition', `${section(['-', 'relaxed-simd'])} ${relaxed}`, {}, 42, { reject: true, flags: ['--enable-relaxed-simd'] }),
];

const scalarCode = `#include <stdio.h>
static volatile unsigned char data[] = {253, 12, 0};
__attribute__((noinline)) int immediate(void) { return 253; }
int main(void) { printf("%u %d\\n", data[0], immediate()); return 0; }
`;
const vectorCode = `#include <stdio.h>
typedef int v4si __attribute__((vector_size(16)));
__attribute__((noinline)) v4si sum(v4si a, v4si b) { return a + b; }
int main(void) { v4si a = {1,2,3,4}, b = {41,40,39,38}; v4si c = sum(a,b);
  printf("%d %d %d %d\\n", c[0],c[1],c[2],c[3]); return 0; }
`;
export const cases = [
  ['scalar-fd', scalarCode, false, false, '253 253\n'],
  ['scalar-enabled', scalarCode, true, false, '253 253\n'],
  ['vector-add', vectorCode, true, true, '42 42 42 42\n'],
].flatMap(([id, code, simd, usesSimd, stdout]) => ['0', '2'].map(optimization => ({
  id: `${id}-O${optimization}`, request: { code, language: 'c', standard: 'gnu11', optimization, simd },
  stdin: '', stdout, usesSimd,
})));
