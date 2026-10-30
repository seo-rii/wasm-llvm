// Real GCC target builtins; the program never contains a scalar replacement for
// a saturating operation. BigInt computes the independent mathematical oracle.
const layouts = [
  { bits: 8, shape: 'i8x16', signedType: 'signed char', unsignedType: 'unsigned char' },
  { bits: 16, shape: 'i16x8', signedType: 'short', unsignedType: 'unsigned short' }
];
const languages = [
  { language: 'c', standard: 'gnu11' },
  { language: 'cpp', standard: 'gnu++17' }
];
const inputRotation = 3;
const allOpcodes = layouts.flatMap(({ shape }) => ['add', 'sub'].flatMap(operation =>
  ['s', 'u'].map(sign => `${shape}.${operation}_sat_${sign}`)));

export const saturationProfiles = layouts.flatMap(layout => [true, false].flatMap(signed =>
  ['add', 'sub'].map(operation => {
    const half = 1n << BigInt(layout.bits - 1);
    const minimum = signed ? -half : 0n;
    const maximum = signed ? half - 1n : half * 2n - 1n;
    const values = signed
      ? [minimum, minimum + 1n, -2n, -1n, 0n, 1n, maximum - 1n, maximum]
      : [0n, 1n, 2n, half - 1n, half, half + 1n, maximum - 1n, maximum];
    // All 64 pairs of eight representative values. Both operands vary within
    // every eight-lane block, so a wrong lane order cannot hide behind splats.
    const samples = Array.from({ length: 64 }, (_, index) => {
      const column = index % 8, row = Math.floor(index / 8);
      const left = values[(row + column) % 8], right = values[column];
      const mathematical = operation === 'add' ? left + right : left - right;
      const result = mathematical < minimum ? minimum : mathematical > maximum ? maximum : mathematical;
      return { left: String(left), right: String(right), result: String(result) };
    });
    const sign = signed ? 's' : 'u', lanes = 128 / layout.bits;
    const builtin = `__builtin_wasm_${operation}_sat_${sign}_${layout.shape}`;
    const opcode = `${layout.shape}.${operation}_sat_${sign}`;
    const type = signed ? layout.signedType : layout.unsignedType;
    const results = samples.map((_, index) => samples[(index + inputRotation) % samples.length].result);
    const stdout = Array.from({ length: samples.length / lanes }, (_, row) =>
      results.slice(row * lanes, (row + 1) * lanes).join(' ') + '\n').join('');
    const code = `#include <stdio.h>
typedef ${type} Lane;
typedef Lane V __attribute__((vector_size(16)));
typedef char check_lane_width[sizeof(Lane) * 8 == ${layout.bits} ? 1 : -1];
typedef char check_vector_width[sizeof(V) == 16 ? 1 : -1];
static const Lane left_values[64] = {${samples.map(sample => sample.left).join(',')}};
static const Lane right_values[64] = {${samples.map(sample => sample.right).join(',')}};
static V left, right;
__attribute__((noinline, noclone)) static V saturate(V a, V b) {
  return ${builtin}(a, b);
}
int main(void) {
  unsigned rotation;
  if (scanf("%u", &rotation) != 1 || rotation >= 64) return 2;
  for (unsigned block = 0; block < ${64 / lanes}; ++block) {
    for (unsigned lane = 0; lane < ${lanes}; ++lane) {
      unsigned index = (block * ${lanes} + lane + rotation) % 64;
      left[lane] = left_values[index];
      right[lane] = right_values[index];
    }
    V result = saturate(left, right);
    for (unsigned lane = 0; lane < ${lanes}; ++lane)
      printf("%d%c", (int)result[lane], lane + 1 == ${lanes} ? '\\n' : ' ');
  }
  return 0;
}
`;
    return { id: `${operation}-${sign}-${layout.shape}`, bits: layout.bits, lanes, signed, operation,
      builtin, opcode, minimum: String(minimum), maximum: String(maximum), samples, code, stdout };
  })));

export const cases = saturationProfiles.flatMap(profile => languages.flatMap(language =>
  ['0', '2'].map(optimization => ({
    id: `simd-saturating-${profile.id}-${language.language}-o${optimization}`,
    request: { ...language, optimization, simd: true, code: profile.code },
    stdin: `${inputRotation}\n`, stdout: profile.stdout,
    requiredInstructions: [profile.opcode],
    forbiddenInstructions: allOpcodes.filter(opcode => opcode !== profile.opcode)
  }))));

// Ordinary scalar arithmetic is a live-input control for -mno-simd128. It does
// not implement or stand in for any of the vector saturating builtins.
const scalarCode = `#include <stdio.h>
__attribute__((noinline, noclone)) static unsigned multiply(unsigned a, unsigned b) {
  return a * b;
}
int main(void) {
  unsigned a, b;
  if (scanf("%u %u", &a, &b) != 2 || a > 65535 || b > 65535) return 2;
  printf("%u %u %u %u\\n", a + b, a > b ? a - b : b - a,
         multiply(a, b), (a << 4) ^ b);
  return 0;
}
`;
export const disabledCases = languages.flatMap(language => ['0', '2'].map(optimization => ({
  id: `simd-saturating-scalar-disabled-${language.language}-o${optimization}`,
  request: { ...language, optimization, simd: false, code: scalarCode },
  stdin: '3 17\n', stdout: '20 14 51 33\n',
  requiredInstructions: [], forbiddenInstructions: [...allOpcodes]
})));

// A real, live builtin invocation: disabled/default diagnostics must come from
// the target, not from a fixture's preprocessor #error.
export const disabledDiagnostic = saturationProfiles[0].code;

const diagnosticProfiles = [
  { id: 'wrong-width-i8x16', inputType: 'signed char', inputBytes: 8, outputType: 'signed char',
    builtin: '__builtin_wasm_add_sat_s_i8x16', diagnosticPattern: 'incompatible type|cannot convert|could not convert' },
  { id: 'wrong-width-i16x8', inputType: 'unsigned short', inputBytes: 8, outputType: 'unsigned short',
    builtin: '__builtin_wasm_sub_sat_u_i16x8', diagnosticPattern: 'incompatible type|cannot convert|could not convert' },
  { id: 'unsupported-i32x4', inputType: 'int', inputBytes: 16, outputType: 'int',
    builtin: '__builtin_wasm_add_sat_s_i32x4', diagnosticPattern: 'implicit declaration|was not declared|undeclared' },
  { id: 'unsupported-i64x2', inputType: 'unsigned long long', inputBytes: 16, outputType: 'unsigned long long',
    builtin: '__builtin_wasm_sub_sat_u_i64x2', diagnosticPattern: 'implicit declaration|was not declared|undeclared' }
];
export const diagnosticCases = diagnosticProfiles.flatMap(profile => languages.flatMap(language =>
  ['0', '2'].map(optimization => ({
    id: `simd-saturating-${profile.id}-${language.language}-o${optimization}`,
    request: { ...language, optimization, simd: true, code: `#include <stdio.h>
typedef ${profile.inputType} Input __attribute__((vector_size(${profile.inputBytes})));
typedef ${profile.outputType} Output __attribute__((vector_size(16)));
__attribute__((noinline, noclone)) static Output invalid(Input a, Input b) {
  return ${profile.builtin}(a, b);
}
int main(void) {
  unsigned n; if (scanf("%u", &n) != 1 || n > 63) return 2;
  Input a = {0}, b = {0}; a[0] = n; b[0] = 1;
  Output result = invalid(a, b);
  printf("%u\\n", (unsigned)result[0]);
  return 0;
}
` },
    stdin: '3\n', builtin: profile.builtin, diagnosticPattern: profile.diagnosticPattern
  }))));
