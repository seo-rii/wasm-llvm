// Real GCC SIMD operation qualification inputs. These generate ordinary source
// fixtures; no submitted program, compiler output, or WAT is transformed.
const integerTypes = [
  { bits: 8, signed: 'signed char', unsigned: 'unsigned char', opcode: 'i8x16' },
  { bits: 16, signed: 'short', unsigned: 'unsigned short', opcode: 'i16x8' },
  { bits: 32, signed: 'int', unsigned: 'unsigned int', opcode: 'i32x4' },
  { bits: 64, signed: 'long long', unsigned: 'unsigned long long', opcode: 'i64x2' }
];
const floatTypes = [
  { bits: 32, type: 'float', integer: 'int', opcode: 'f32x4', format: '%.1f' },
  { bits: 64, type: 'double', integer: 'long long', opcode: 'f64x2', format: '%.1f' }
];
const relations = ['==', '!=', '<', '<=', '>', '>='];
const opcodes = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];
const relation = (a, b, op) => ({ '==': a === b, '!=': a !== b, '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b })[op];
const literal = n => n < 0n ? `(-${-n - 1n}LL-1LL)` : `${n}ULL`;
const row = items => items.join(' ') + '\n';
const profiles = [];

for (const p of integerTypes) {
  const lanes = 128 / p.bits, high = 1n << BigInt(p.bits - 1), max = high * 2n - 1n;
  const unsigned = Array.from({ length: lanes }, (_, i) => [max, high, high - 1n, 1n][i % 4]);
  const signed = Array.from({ length: lanes }, (_, i) => [-1n, -high, high - 1n, 1n][i % 4]);
  const lines = [];
  for (const count of [0, p.bits - 1, 3]) {
    lines.push(row(unsigned.map(v => BigInt.asUintN(p.bits, v << BigInt(count)).toString())));
    lines.push(row(unsigned.map(v => (v >> BigInt(count)).toString())));
    lines.push(row(signed.map(v => (v >> BigInt(count)).toString())));
  }
  profiles.push({
    id: `shift-${p.opcode}`, stdout: lines.join(''),
    instructions: [`${p.opcode}.shl`, `${p.opcode}.shr_u`, `${p.opcode}.shr_s`],
    code: `#include <stdio.h>
typedef ${p.unsigned} U __attribute__((vector_size(16)));
typedef ${p.signed} S __attribute__((vector_size(16)));
static U input_u = {${unsigned.map(literal).join(',')}}, left, right;
static S input_s = {${signed.map(literal).join(',')}}, arithmetic;
__attribute__((noinline)) static void shift(unsigned count) {
  left = input_u << count; right = input_u >> count; arithmetic = input_s >> count;
}
int main(void) {
  unsigned n; if (scanf("%u", &n) != 1 || n >= ${p.bits}) return 2;
  unsigned counts[] = {0, ${p.bits - 1}, n};
  for (unsigned k = 0; k < 3; ++k) {
    shift(counts[k]);
    for (unsigned i = 0; i < ${lanes}; ++i) printf("%llu%c", (unsigned long long)left[i], i+1 == ${lanes} ? '\\n' : ' ');
    for (unsigned i = 0; i < ${lanes}; ++i) printf("%llu%c", (unsigned long long)right[i], i+1 == ${lanes} ? '\\n' : ' ');
    for (unsigned i = 0; i < ${lanes}; ++i) printf("%lld%c", (long long)arithmetic[i], i+1 == ${lanes} ? '\\n' : ' ');
  }
  return 0;
}
`
  });
  for (const isUnsigned of [false, true]) {
    const values = isUnsigned ? [0n, high - 1n, high, max] : [-high, -1n, 0n, high - 1n];
    const left = Array.from({ length: 16 }, (_, i) => values[i >> 2]);
    const right = Array.from({ length: 16 }, (_, i) => values[i % 4]);
    profiles.push({
      id: `compare-${p.opcode}-${isUnsigned ? 'unsigned' : 'signed'}`,
      stdout: relations.map(op => left.map((v, i) => relation(left[(i+3)%16], right[(i+3)%16], op) ? '1' : '0').join('') + '\n').join(''),
      instructions: opcodes.map((op, i) => `${p.opcode}.${op}${i < 2 ? '' : isUnsigned && p.bits !== 64 ? '_u' : '_s'}`)
        .concat(isUnsigned && p.bits === 64 ? ['v128.xor'] : []),
      code: `#include <stdio.h>
typedef ${isUnsigned ? p.unsigned : p.signed} V __attribute__((vector_size(16)));
typedef ${p.signed} M __attribute__((vector_size(16)));
static const ${isUnsigned ? p.unsigned : p.signed} a_values[16] = {${left.map(literal).join(',')}};
static const ${isUnsigned ? p.unsigned : p.signed} b_values[16] = {${right.map(literal).join(',')}};
static V a, b;
static M masks[6];
__attribute__((noinline)) static void compare(void) {
  ${relations.map((op, i) => `masks[${i}] = a ${op} b;`).join('\n  ')}
}
int main(void) {
  unsigned n; if (scanf("%u", &n) != 1 || n >= 16) return 2;
  char results[6][17] = {{0}};
  for (unsigned k = 0; k < 16 / ${lanes}; ++k) {
    for (unsigned i = 0; i < ${lanes}; ++i) { a[i] = a_values[(k*${lanes}+i+n)%16]; b[i] = b_values[(k*${lanes}+i+n)%16]; }
    compare();
    for (unsigned j = 0; j < 6; ++j) for (unsigned i = 0; i < ${lanes}; ++i)
      results[j][k*${lanes}+i] = masks[j][i] == -1 ? '1' : masks[j][i] == 0 ? '0' : '9';
  }
  for (unsigned j = 0; j < 6; ++j) puts(results[j]);
  return 0;
}
`
    });
  }
}

for (const p of floatTypes) {
  const lanes = 128 / p.bits;
  const a = [NaN, 3, NaN, 0, -0, Infinity, -Infinity, 3];
  const b = [3, NaN, NaN, -0, 0, 3, Infinity, 4];
  const expressions = ['a == b', 'a != b', 'a < b', 'a <= b', 'a > b', 'a >= b',
    '~(a < b)', '~(a <= b)', '~(a > b)', '~(a >= b)', '(a == a) & (b == b)', '~((a == a) & (b == b))',
    '(a < b) | (a > b)', '~((a < b) | (a > b))'];
  const results = relations.map(op => a.map((v, i) => relation(v, b[i], op)));
  results.push(...results.slice(2, 6).map(row => row.map(v => !v)));
  const ordered = a.map((v, i) => !Number.isNaN(v) && !Number.isNaN(b[i]));
  const lessgreater = a.map((v, i) => v < b[i] || v > b[i]);
  results.push(ordered, ordered.map(v => !v), lessgreater, lessgreater.map(v => !v));
  profiles.push({
    id: `compare-${p.opcode}-nan`, stdout: results.map(row => row.map(v => v ? '1' : '0').join('') + '\n').join(''),
    instructions: opcodes.map(op => `${p.opcode}.${op}`).concat(['v128.and', 'v128.or']),
    code: `#include <stdio.h>
typedef ${p.type} V __attribute__((vector_size(16)));
typedef ${p.integer} M __attribute__((vector_size(16)));
static V a, b;
static M masks[14];
__attribute__((noinline)) static void compare(void) {
  ${expressions.map((expr, i) => `masks[${i}] = ${expr};`).join('\n  ')}
}
int main(void) {
  int n; if (scanf("%d", &n) != 1) return 2;
  ${p.type} av[] = {__builtin_nan${p.bits === 32 ? 'f' : ''}(""), n, __builtin_nan${p.bits === 32 ? 'f' : ''}(""), 0.0, -0.0, __builtin_inf${p.bits === 32 ? 'f' : ''}(), -__builtin_inf${p.bits === 32 ? 'f' : ''}(), n};
  ${p.type} bv[] = {n, __builtin_nan${p.bits === 32 ? 'f' : ''}(""), __builtin_nan${p.bits === 32 ? 'f' : ''}(""), -0.0, 0.0, n, __builtin_inf${p.bits === 32 ? 'f' : ''}(), n+1};
  char results[14][9] = {{0}};
  for (unsigned k = 0; k < 8 / ${lanes}; ++k) {
    for (unsigned i = 0; i < ${lanes}; ++i) { a[i] = av[k*${lanes}+i]; b[i] = bv[k*${lanes}+i]; }
    compare();
    for (unsigned j = 0; j < 14; ++j) for (unsigned i = 0; i < ${lanes}; ++i)
      results[j][k*${lanes}+i] = masks[j][i] == -1 ? '1' : masks[j][i] == 0 ? '0' : '9';
  }
  for (unsigned j = 0; j < 14; ++j) puts(results[j]);
  return 0;
}
`
  });
}

const allTypes = [...integerTypes.map(p => ({ ...p, type: p.signed, integer: p.signed, format: '%lld', cast: '(long long)' })),
  ...floatTypes.map(p => ({ ...p, cast: '(double)' }))];
for (const p of allTypes) {
  const lanes = 128 / p.bits;
  const selected = Array.from({ length: lanes }, (_, i) => i % 2 ? 3 + i : -3 - i);
  profiles.push({
    id: `select-${p.opcode}`, language: 'cpp', standard: 'gnu++17',
    stdout: row(selected.map(v => p.format === '%.1f' ? v.toFixed(1) : v.toString())),
    instructions: ['v128.bitselect'],
    code: `#include <stdio.h>
typedef ${p.type} V __attribute__((vector_size(16)));
typedef ${p.integer} M __attribute__((vector_size(16)));
static V a, b, result;
static M mask;
__attribute__((noinline)) static void choose(void) { result = mask ? a : b; }
int main(void) {
  int n; if (scanf("%d", &n) != 1) return 2;
  for (unsigned i = 0; i < ${lanes}; ++i) { a[i] = n+i; b[i] = -n-(int)i; mask[i] = i%2 ? n : 0; }
  choose();
  for (unsigned i = 0; i < ${lanes}; ++i) printf("${p.format}%c", ${p.cast}result[i], i+1 == ${lanes} ? '\\n' : ' ');
  return 0;
}
`
  });
  const permutation = Array.from({ length: lanes }, (_, i) => i % 2 ? lanes + i : lanes - 1 - i);
  const shuffled = permutation.map(i => i < lanes ? 3 + i : -3 - (i - lanes));
  profiles.push({
    id: `shuffle-${p.opcode}`,
    stdout: row(shuffled.map(v => p.format === '%.1f' ? v.toFixed(1) : v.toString())),
    instructions: ['i8x16.shuffle'],
    code: `#include <stdio.h>
typedef ${p.type} V __attribute__((vector_size(16)));
static V a, b, result;
__attribute__((noinline)) static void permute(void) { result = __builtin_shufflevector(a, b, ${permutation.join(',')}); }
int main(void) {
  int n; if (scanf("%d", &n) != 1) return 2;
  for (unsigned i = 0; i < ${lanes}; ++i) { a[i] = n+i; b[i] = -n-(int)i; }
  permute();
  for (unsigned i = 0; i < ${lanes}; ++i) printf("${p.format}%c", ${p.cast}result[i], i+1 == ${lanes} ? '\\n' : ' ');
  return 0;
}
`
  });
}

function fixture(profile, optimization, simd) {
  return {
    id: `simd-extended-${profile.id}-${simd ? '' : 'disabled-'}o${optimization}`,
    request: { language: profile.language || 'c', standard: profile.standard || 'gnu11', optimization, simd, code: profile.code },
    stdin: '3\n', stdout: profile.stdout,
    requiredInstructions: simd ? profile.instructions : [], forbiddenInstructions: []
  };
}
export const cases = profiles.flatMap(profile => ['0', '2'].map(optimization => fixture(profile, optimization, true)));
const disabledIds = new Set(['shift-i32x4', 'compare-i32x4-signed', 'compare-f32x4-nan', 'select-i32x4', 'shuffle-i32x4']);
export const disabledCases = profiles.filter(p => disabledIds.has(p.id))
  .flatMap(profile => ['0', '2'].map(optimization => fixture(profile, optimization, false)));
export const disabledDiagnostic = '#ifndef __wasm_simd128__\n#error SIMD128 is disabled\n#endif\nint main(void) { return 0; }\n';
