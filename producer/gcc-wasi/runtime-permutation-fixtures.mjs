// GCC compiles the original GNU __builtin_shuffle expression. Clang uses
// a separately identified scalar byte-selection oracle for runtime masks.
import { cases as extendedCases, disabledCases as extendedDisabledCases } from './simd-extended-fixtures.mjs';

export const runtimePermutationModes = [
  { name: 'i8x16', bits: 8, scalar: 'signed char', signed: 'signed char', unsigned: 'unsigned char', load: 'i32.load8_s' },
  { name: 'i16x8', bits: 16, scalar: 'short', signed: 'short', unsigned: 'unsigned short', load: 'i32.load16_s' },
  { name: 'i32x4', bits: 32, scalar: 'int', signed: 'int', unsigned: 'unsigned int', load: 'i32.load' },
  { name: 'i64x2', bits: 64, scalar: 'long long', signed: 'long long', unsigned: 'unsigned long long', load: 'i64.load' },
  { name: 'f32x4', bits: 32, scalar: 'float', signed: 'int', unsigned: 'unsigned int', load: 'f32.load' },
  { name: 'f64x2', bits: 64, scalar: 'double', signed: 'long long', unsigned: 'unsigned long long', load: 'f64.load' }
];

function dataSets({ name, bits }) {
  let values;
  if (name === 'f32x4') values = [
    [[0x7fc12345, 0x80000000, 0x7f800000, 1], [0xffc54321, 0, 0xff800000, 0x3f800001]],
    [[0xbf800000, 0, 0xff800000, 0x3f800000], [0x00800000, 0x3fc00000, 0x80000001, 0x7fcabcde]]
  ];
  else if (name === 'f64x2') values = [
    [[0x7ff8123456789abcn, 0x8000000000000000n], [0xfff0000000000000n, 1n]],
    [[0x3ff0000000000000n, 0xbff0000000000000n], [0n, 0x7ff0000000000000n]]
  ];
  else {
    const first = {
      8: [[0, 1, 127, 128, 255, 85, 170, 16, 32, 64, 2, 3, 4, 5, 6, 7],
        [240, 224, 208, 192, 176, 160, 144, 129, 112, 96, 80, 63, 48, 31, 15, 8]],
      16: [[0, 1, 0x7fff, 0x8000, 0xffff, 0x1234, 0xabcd, 0x55aa],
        [0xf00d, 0xbeef, 0x8001, 0x7ffe, 0x42, 0x2468, 0x1357, 0xaa55]],
      32: [[0xdeadbeef, 0x80000000, 0x7fffffff, 0x12345678], [0, 0xffffffff, 0x2468ace0, 0x13579bdf]],
      64: [[0x0123456789abcdefn, 0xfedcba9876543210n], [0x8000000000000000n, 0x7fffffffffffffffn]]
    }[bits];
    const limit = (1n << BigInt(bits)) - 1n;
    values = [first, first.map((vector, index) => vector.map(value => BigInt(value) ^ ((index ? 0xa5a5a5a5a5a5a5a5n : 0x5a5a5a5a5a5a5a5an) & limit)))];
  }
  return values.map(pair => pair.map(vector => vector.map(value =>
    BigInt(value).toString(16).padStart(bits / 4, '0').match(/../g).reverse().join(''))));
}

function maskRows(bits, signed) {
  const lanes = 128 / bits, n = BigInt(lanes);
  const values = [0n, 1n, n - 1n, n, n + 1n, 2n * n - 1n, 2n * n, 2n * n + 1n, 7n * n + 3n];
  if (signed) {
    const low = -(1n << BigInt(bits - 1)), high = (1n << BigInt(bits - 1)) - 1n;
    values.push(-1n, -n, -n - 1n, -2n * n, -2n * n - 1n, low, low + 1n,
      high, high - 1n, (1n << BigInt(bits - 2)) + 3n, -(1n << BigInt(bits - 2)) + 1n);
  } else {
    const high = (1n << BigInt(bits)) - 1n;
    values.push(high, high - 1n, 1n << BigInt(bits - 1), (1n << BigInt(bits - 1)) + 1n, (1n << BigInt(bits - 2)) + 3n);
  }
  return values.map((_, row) => Array.from({ length: lanes }, (_, lane) => values[(row + lane) % values.length]));
}

function runtimeFixture(mode, arity, signedMask, language, optimization, feature) {
  const { name, bits, scalar, signed, unsigned, load } = mode, lanes = 128 / bits;
  const data = dataSets(mode), masks = maskRows(bits, signedMask), total = BigInt(arity * lanes);
  const expectedLanes = masks.map(mask => mask.map(value => ((value % total + total) % total).toString()));
  const stdout = expectedLanes.map((mask, row) => {
    const pool = arity === 1 ? data[row % 2][0] : data[row % 2].flat();
    return mask.map(value => pool[Number(value)]).join('');
  }).join('\n') + '\n';
  const arrays = data.map(pair => '{' + pair.map(vector => '{' + [...Buffer.from(vector.join(''), 'hex')].join(',') + '}').join(',') + '}').join(',\n');
  const before = `#include <stdio.h>
#include <string.h>
${feature === 'enabled' ? '#ifndef' : '#ifdef'} __wasm_simd128__
#error unexpected SIMD feature profile
#endif
typedef ${scalar} V __attribute__((vector_size(16)));
typedef ${signedMask ? signed : unsigned} M __attribute__((vector_size(16)));
static const unsigned char inputs[2][2][16] = {
${arrays}
};
#ifdef __cplusplus
extern "C"
#endif
__attribute__((noinline, used)) V convert(V a, V b, M mask) {
`;
  const after = `
}
static V (* volatile operation)(V, V, M) = convert;
int main(void) {
  for (unsigned row = 0; row < ${masks.length}; ++row) {
    unsigned which;
    if (scanf("%u", &which) != 1 || which > 1) return 2;
    V a, b; M mask;
    memcpy(&a, inputs[which][0], 16); memcpy(&b, inputs[which][1], 16);
    for (unsigned lane = 0; lane < ${lanes}; ++lane) {
      ${signedMask ? 'long long' : 'unsigned long long'} value;
      if (scanf("${signedMask ? '%lld' : '%llu'}", &value) != 1) return 3;
      mask[lane] = (${signedMask ? signed : unsigned})value;
    }
    V result = operation(a, b, mask);
    unsigned char bytes[16]; memcpy(bytes, &result, 16);
    for (unsigned byte = 0; byte < 16; ++byte) printf("%02x", (unsigned)bytes[byte]);
    putchar('\\n');
  }
  return 0;
}
`;
  const oracleBody = `  unsigned char left[16], right[16], output[16];
  memcpy(left, &a, 16); memcpy(right, &b, 16);
  for (unsigned lane = 0; lane < ${lanes}; ++lane) {
    unsigned index = (unsigned)((unsigned long long)mask[lane] & ${arity * lanes - 1}ULL);
    const unsigned char *input = ${arity === 1 ? 'left' : `index < ${lanes} ? left : right`};
    index &= ${lanes - 1};
    for (unsigned byte = 0; byte < ${bits / 8}; ++byte)
      output[lane * ${bits / 8} + byte] = input[index * ${bits / 8} + byte];
  }
  V result; memcpy(&result, output, 16); return result;`;
  return {
    id: `runtime-${name}-${arity}-${signedMask ? 'signed' : 'unsigned'}-${language}-o${optimization}-${feature}`,
    semanticKind: 'scalar-runtime-permutation', operationFunction: 'convert', feature,
    mode: name, bits, lanes, arity, signedMask,
    request: { language, standard: language === 'cpp' ? 'gnu++17' : 'gnu11', optimization,
      ...(feature === 'default' ? {} : { simd: feature === 'enabled' }),
      code: before + `  return __builtin_shuffle(a, ${arity === 2 ? 'b, ' : ''}mask);` + after },
    oracleCode: before + oracleBody + after,
    stdin: masks.map((mask, row) => row % 2 + ' ' + mask.join(' ') + '\n').join(''), stdout,
    dataSets: data, masks: masks.map(mask => mask.map(String)), expectedLanes,
    requiredInstructions: [load], forbiddenInstructions: ['i8x16.swizzle', 'i8x16.relaxed_swizzle']
  };
}

const runtime = runtimePermutationModes.flatMap(mode => [1, 2].flatMap(arity => [true, false].flatMap(signed =>
  ['c', 'cpp'].flatMap(language => ['0', '2'].flatMap(optimization => ['enabled', 'disabled', 'default'].map(feature =>
    runtimeFixture(mode, arity, signed, language, optimization, feature)))))));
const constants = [...extendedCases, ...extendedDisabledCases].filter(fixture => fixture.id.includes('-shuffle-')).map(fixture => ({
  ...fixture, semanticKind: 'constant-permutation', operationFunction: 'permute',
  feature: fixture.request.simd ? 'enabled' : 'disabled', oracleCode: fixture.request.code,
  reference: 'simd-extended-fixtures.mjs'
}));

// The public SDK currently normalizes an omitted simd option to -mno-simd128.
// The native harness preserves omission and tests the compiler's actual default.
export const cases = [...runtime.filter(fixture => fixture.feature === 'enabled'), ...constants.filter(fixture => fixture.feature === 'enabled')];
export const disabledCases = [...runtime.filter(fixture => fixture.feature === 'disabled'), ...constants.filter(fixture => fixture.feature === 'disabled')];
export const defaultCases = runtime.filter(fixture => fixture.feature === 'default');
