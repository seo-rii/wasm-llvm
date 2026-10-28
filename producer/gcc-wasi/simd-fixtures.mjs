// Original C/C++ source fixtures for GCC's optional SIMD128 backend.
// These are qualification inputs, never transformations of submitted programs.
const profiles = [
  {
    id: 'i8x16', type: 'unsigned char', lanes: 16, format: '%u', cast: '(unsigned)',
    left: 'n+i', right: 'n+2', expression: '(*a + *b) ^ *a',
    expected: '11 13 15 13 11 5 7 5 27 29 31 29 27 5 7 5',
    instructions: ['i8x16.add', 'v128.xor']
  },
  {
    id: 'i16x8', type: 'short', lanes: 8, format: '%d', cast: '(int)',
    left: 'n-i', right: 'n+i', expression: '(*a - *b) * *b',
    expected: '0 -8 -20 -36 -56 -80 -108 -140',
    instructions: ['i16x8.sub', 'i16x8.mul']
  },
  {
    id: 'i32x4', type: 'int', lanes: 4, format: '%d', cast: '',
    left: 'n-i*7', right: 'n+i', expression: '*a * *b + *b',
    expected: '12 -12 -50 -102',
    instructions: ['i32x4.mul', 'i32x4.add']
  },
  {
    id: 'i64x2', type: 'long long', lanes: 2, format: '%lld', cast: '',
    left: 'i ? -0x100000007LL-n : 0x100000001LL+n',
    right: 'i ? -n-2 : n', expression: '(*a + *b) * *b',
    expected: '12884901909 21474836555',
    instructions: ['i64x2.add', 'i64x2.mul']
  },
  {
    id: 'f32x4', type: 'float', lanes: 4, format: '%.3f', cast: '(double)',
    left: 'n+i+0.5f', right: 'n-2+i', expression: '(*a + *b) * *b',
    expected: '4.500 13.000 25.500 42.000',
    instructions: ['f32x4.add', 'f32x4.mul']
  },
  {
    id: 'f64x2', type: 'double', lanes: 2, format: '%.4f', cast: '',
    left: 'i ? -n-0.75 : n+0.25', right: 'i ? n+1 : n-1',
    expression: '-(*a - *b) / *b', expected: '-0.6250 1.9375',
    instructions: ['f64x2.sub', 'f64x2.neg', 'f64x2.div']
  }
];

function source(profile, byValue = false) {
  const expression = byValue ? profile.expression.replaceAll('*a', 'a').replaceAll('*b', 'b') : profile.expression;
  return `#include <stdio.h>
typedef ${profile.type} vec __attribute__((vector_size(16)));
static vec left, right, result;
__attribute__((noinline)) static ${byValue ? 'vec calculate(vec a, vec b)' : 'void calculate(vec *out, const vec *a, const vec *b)'} {
  ${byValue ? 'return' : '*out ='} ${expression};
}
int main(void) {
  int n; if (scanf("%d", &n) != 1) return 2;
  for (int i=0; i<${profile.lanes}; ++i) {
    left[i] = ${profile.left}; right[i] = ${profile.right};
  }
  ${byValue ? 'result = calculate(left, right);' : 'calculate(&result, &left, &right);'}
  for (int i=0; i<${profile.lanes}; ++i)
    printf("${profile.format}%c", ${profile.cast}result[i], i+1==${profile.lanes} ? '\\n' : ' ');
  return 0;
}
`;
}

export const cases = profiles.flatMap(profile => ['0', '2'].map(optimization => ({
  id: `simd-${profile.id}-o${optimization}`,
  request: { language: 'c', standard: 'gnu11', optimization, simd: true, code: source(profile) },
  stdin: '3\n', stdout: profile.expected + '\n',
  requiredInstructions: ['v128.load', 'v128.store', ...profile.instructions]
})));

for (const profile of profiles) {
  cases.push({
    id: `simd-byvalue-${profile.id}-o2`,
    request: { language: 'c', standard: 'gnu11', optimization: '2', simd: true, code: source(profile, true) },
    stdin: '3\n', stdout: profile.expected + '\n',
    requiredInstructions: profile.instructions
  });
}

cases.push({
  id: 'simd-lanes-constants-o2',
  request: {
    language: 'c', standard: 'gnu11', optimization: '2', simd: true,
    code: `#include <stdio.h>
#ifndef __wasm_simd128__
#error SIMD128 compiler feature macro is missing
#endif
typedef int vec __attribute__((vector_size(16)));
static vec result;
static volatile vec addend = {5, 6, 7, 8};
__attribute__((noinline)) static int calculate(int n) {
  vec v = {1, 2, 3, 4};
  v[2] = n;
  v += addend;
  result = v;
  return v[2];
}
int main(void) {
  int n; if (scanf("%d", &n) != 1) return 2;
  int lane = calculate(n);
  printf("%d %d %d %d %d\\n", lane, result[0], result[1], result[2], result[3]);
  return 0;
}
`
  },
  stdin: '9\n', stdout: '16 6 8 16 12\n',
  requiredInstructions: ['v128.const', 'i32x4.replace_lane', 'i32x4.extract_lane', 'i32x4.add']
});

export const disabledCases = profiles.map(profile => ({
  id: `scalar-${profile.id}-o2`,
  request: { language: 'c', standard: 'gnu11', optimization: '2', simd: false, code: source(profile) },
  stdin: '3\n', stdout: profile.expected + '\n', requiredInstructions: []
}));

export const disabledDiagnostic = `#ifndef __wasm_simd128__
#error SIMD128 is disabled for this compilation
#endif
int main(void) { return 0; }
`;
