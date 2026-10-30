// Original GNU vector shifts with runtime lane counts. The separate Clang
// reference uses scalar loops; BigInt supplies the expected decimal results.
import assert from 'node:assert/strict';

export const laneShiftModes = [
  { bits: 8, unsigned: 'unsigned char', signed: 'signed char', opcode: 'i8x16' },
  { bits: 16, unsigned: 'unsigned short', signed: 'short', opcode: 'i16x8' },
  { bits: 32, unsigned: 'unsigned int', signed: 'int', opcode: 'i32x4' },
  { bits: 64, unsigned: 'unsigned long long', signed: 'long long', opcode: 'i64x2' }
];
const operations = [
  ['shl_u', 'U', '<<', false], ['shr_u', 'U', '>>', false],
  ['shr_s', 'S', '>>', false], ['shl_s_defined', 'S', '<<', false],
  ['uniform_shl_u', 'U', '<<', true], ['uniform_shr_u', 'U', '>>', true],
  ['uniform_shr_s', 'S', '>>', true]
];
const name = (operation, bits) => `${operation.startsWith('uniform_') ? '' : 'lane_'}${operation}_${bits}`;

function source(mode, feature, scalar = false) {
  const { bits, unsigned, signed } = mode, lanes = 128 / bits;
  const high = 1n << BigInt(bits - 1), mask = 2n * high - 1n, maximum = high - 1n;
  const definitions = operations.map(([operation, kind, operator, uniform]) => {
    const argument = uniform ? 'unsigned count' : `const ${kind} *counts`;
    let body;
    if (scalar) {
      // Avoid signed integer promotion changing the unsigned 8/16-bit oracle.
      const value = kind === 'U' && bits < 32 ? '(unsigned int)values[i]' : 'values[i]';
      body = `for(unsigned i=0;i<LANES;++i) out[i]=(${kind})(${value} ${operator} ${uniform ? 'count' : 'counts[i]'});`;
    } else {
      body = `V${kind} a,r; __builtin_memcpy(&a,values,16); `;
      if (!uniform) body += `V${kind} c; __builtin_memcpy(&c,counts,16); `;
      body += `r=a ${operator} ${uniform ? 'count' : 'c'}; __builtin_memcpy(out,&r,16);`;
    }
    return `__attribute__((noinline)) void ${name(operation, bits)}(const ${kind} *values,${argument},${kind} *out){${body}}`;
  });
  return `#include <stdio.h>
${feature === 'enabled' && !scalar ? '#ifndef' : '#ifdef'} __wasm_simd128__
#error unexpected SIMD feature profile
#endif
#define BITS ${bits}
#define LANES ${lanes}
typedef ${unsigned} U;
typedef ${signed} S;
${scalar ? '' : 'typedef U VU __attribute__((vector_size(16)));\ntypedef S VS __attribute__((vector_size(16)));\n'}#ifdef __cplusplus
extern "C" {
#endif
${definitions.join('\n')}
#ifdef __cplusplus
}
#endif
static U input_u[LANES],counts_u[LANES],left_u[LANES],right_u[LANES],uniform_left[LANES],uniform_right[LANES];
static S input_s[LANES],input_left_s[LANES],counts_s[LANES],right_s[LANES],left_s[LANES],uniform_signed[LANES];
static void print_u(const U *values){for(unsigned i=0;i<LANES;++i)printf("%llu%c",(unsigned long long)values[i],i+1==LANES?'\\n':' ');}
static void print_s(const S *values){for(unsigned i=0;i<LANES;++i)printf("%lld%c",(long long)values[i],i+1==LANES?'\\n':' ');}
int main(void){
  unsigned rounds,uniform_count;
  if(scanf("%u %u",&rounds,&uniform_count)!=2 || rounds!=${Math.ceil(bits / lanes)} || uniform_count>=BITS)return 2;
  for(unsigned row=0;row<rounds;++row){
    for(unsigned i=0;i<LANES;++i){
      unsigned long long u;long long s,left;unsigned count;
      if(scanf("%llu %lld %lld %u",&u,&s,&left,&count)!=4 || count>=BITS || u>${mask}ULL ||
         s<(-${maximum}LL-1LL) || s>${maximum}LL || left<0 || left>(${maximum}LL>>count))return 3;
      input_u[i]=(U)u;input_s[i]=(S)s;input_left_s[i]=(S)left;counts_u[i]=(U)count;counts_s[i]=(S)count;
    }
    ${name('shl_u', bits)}(input_u,counts_u,left_u);
    ${name('shr_u', bits)}(input_u,counts_u,right_u);
    ${name('shr_s', bits)}(input_s,counts_s,right_s);
    ${name('shl_s_defined', bits)}(input_left_s,counts_s,left_s);
    ${name('uniform_shl_u', bits)}(input_u,uniform_count,uniform_left);
    ${name('uniform_shr_u', bits)}(input_u,uniform_count,uniform_right);
    ${name('uniform_shr_s', bits)}(input_s,uniform_count,uniform_signed);
    print_u(left_u);print_u(right_u);print_s(right_s);print_s(left_s);
    print_u(uniform_left);print_u(uniform_right);print_s(uniform_signed);
  }
  return 0;
}
`;
}

function corpus(bits, scenario) {
  const lanes = 128 / bits, high = 1n << BigInt(bits - 1), mask = 2n * high - 1n, maximum = high - 1n;
  const rounds = Math.ceil(bits / lanes), uniformCount = [0, bits - 1, 3][scenario];
  const unsignedValues = [0n, 1n, mask, high, maximum, 0xaaaaaaaaaaaaaaaan & mask, 0x5555555555555555n & mask];
  const signedValues = [-high, -1n, maximum, 0n, 1n, -high + 1n, -(high / 2n), high / 2n, maximum / 3n, -(maximum / 3n)];
  const rows = [], output = [];
  for (let row = 0; row < rounds; ++row) {
    const cells = Array.from({ length: lanes }, (_, lane) => {
      const index = row * lanes + lane, count = (index * [1, 3, 5][scenario] + scenario) % bits;
      const limit = maximum >> BigInt(count);
      return { unsigned: unsignedValues[(index + 2 * scenario) % unsignedValues.length],
        signed: signedValues[(index + 3 * scenario) % signedValues.length],
        signedLeft: [0n, limit, limit / 2n, limit < 1n ? limit : 1n][(index + scenario) % 4], count };
    });
    assert.equal(new Set(cells.map(cell => cell.count)).size, Math.min(bits, lanes));
    rows.push(cells);
    const calculations = [
      cells.map(cell => (cell.unsigned << BigInt(cell.count)) & mask),
      cells.map(cell => cell.unsigned >> BigInt(cell.count)),
      cells.map(cell => cell.signed >> BigInt(cell.count)),
      cells.map(cell => cell.signedLeft << BigInt(cell.count)),
      cells.map(cell => (cell.unsigned << BigInt(uniformCount)) & mask),
      cells.map(cell => cell.unsigned >> BigInt(uniformCount)),
      cells.map(cell => cell.signed >> BigInt(uniformCount))
    ];
    output.push(...calculations.map(values => values.join(' ') + '\n'));
  }
  assert.equal(new Set(rows.flat().map(cell => cell.count)).size, bits);
  return { rounds, uniformCount,
    rows: rows.map(row => row.map(cell => ({ unsigned: String(cell.unsigned), signed: String(cell.signed), signedLeft: String(cell.signedLeft), count: cell.count }))),
    stdin: `${rounds} ${uniformCount}\n` + rows.flat().map(cell => `${cell.unsigned} ${cell.signed} ${cell.signedLeft} ${cell.count}\n`).join(''),
    stdout: output.join('') };
}

function fixture(mode, language, optimization, feature, corpusIndex) {
  const { bits, opcode } = mode, data = corpus(bits, corpusIndex);
  return { id: `lane-shift-${bits}-${language}-o${optimization}-${feature}-counts-${corpusIndex}`,
    bits, lanes: 128 / bits, feature, corpusIndex,
    request: { language, standard: language === 'cpp' ? 'gnu++20' : 'gnu11', optimization,
      ...(feature === 'default' ? {} : { simd: feature === 'enabled' }), code: source(mode, feature) },
    oracleCode: source(mode, 'disabled', true), ...data,
    functions: operations.map(([operation, kind, operator, uniform]) => {
      const suffix = operator === '<<' ? '.shl' : kind === 'S' ? '.shr_s' : '.shr_u';
      return { name: name(operation, bits), operation, uniform,
        scalarShift: (bits === 64 ? 'i64' : 'i32') + suffix, simdShift: opcode + suffix };
    }) };
}
const matrix = feature => laneShiftModes.flatMap(mode => ['c', 'cpp'].flatMap(language =>
  ['0', '2'].flatMap(optimization => [0, 1, 2].map(index => fixture(mode, language, optimization, feature, index)))));
export const cases = matrix('enabled');
export const disabledCases = matrix('disabled');
// Native qualification omits both SIMD flags; the SDK normalizes omission to false.
export const defaultCases = matrix('default');
