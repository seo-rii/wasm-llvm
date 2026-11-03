// Issue #93: unnamed bitfields occupy storage without adding a scalar member.
// Original C is compiled independently by GCC and pinned Clang. Only named
// values and named field bits are observed; padding/unnamed bits are ignored.
// Basic C ABI: tool-conventions 25aceba5adba8f3f7cdbadd8e8705784aebcad6a.
const profiles = [
  { id: 'named-control', fields: 'signed int value:7;', size: 4, alignment: 4, bitOffset: 0, abi: 'direct' },
  { id: 'before', fields: 'unsigned int :3; signed int value:7;', size: 4, alignment: 4, bitOffset: 3, abi: 'direct' },
  { id: 'after', fields: 'signed int value:7; unsigned int :3;', size: 4, alignment: 4, bitOffset: 0, abi: 'direct' },
  { id: 'packed-before', attributes: 'packed', fields: 'unsigned int :3; signed int value:7;', size: 2, alignment: 1, bitOffset: 3, abi: 'indirect' },
  { id: 'packed-after', attributes: 'packed', fields: 'signed int value:7; unsigned int :3;', size: 2, alignment: 1, bitOffset: 0, abi: 'indirect' },
  { id: 'aligned-before', attributes: 'aligned(16)', fields: 'unsigned int :3; signed int value:7;', size: 16, alignment: 16, bitOffset: 3, abi: 'indirect' },
  { id: 'aligned-after', attributes: 'aligned(16)', fields: 'signed int value:7; unsigned int :3;', size: 16, alignment: 16, bitOffset: 0, abi: 'indirect' },
  { id: 'anonymous-only', fields: 'unsigned int :3;', size: 1, alignment: 1, abi: 'ignored' },
  { id: 'anonymous-only-hi', fields: 'unsigned short :16;', size: 2, alignment: 1, abi: 'ignored' },
  { id: 'anonymous-only-di', fields: 'unsigned long long :64;', size: 8, alignment: 1, abi: 'ignored' },
  { id: 'anonymous-only-ti', attributes: 'aligned(16)', fields: 'unsigned int :3;', size: 16, alignment: 16, abi: 'ignored' },
  { id: 'two-named', fields: 'unsigned int :3; signed int value:7; unsigned int tag:5;', size: 4, alignment: 4, bitOffset: 3, tag: true, abi: 'indirect' },
  { id: 'zero-boundary', fields: 'unsigned int :3; unsigned int :0; signed int value:7;', size: 8, alignment: 4, bitOffset: 32, abi: 'indirect' },
  { id: 'mode8-before', fields: 'unsigned int :8; signed int value:7;', size: 4, alignment: 4, bitOffset: 8, abi: 'direct' },
  { id: 'mode32-before', fields: 'unsigned int :32; signed int value:7;', size: 8, alignment: 4, bitOffset: 32, abi: 'indirect' },
  { id: 'packed31-before', attributes: 'packed', fields: 'unsigned int :1; signed int value:31;', size: 4, alignment: 1, bitOffset: 1, width: 31, abi: 'direct' },
  { id: 'short-before', fields: 'unsigned short :3; signed short value:7;', size: 2, alignment: 2, bitOffset: 3, abi: 'direct' },
  { id: 'longlong-before', fields: 'unsigned long long :3; signed long long value:7;', size: 8, alignment: 8, bitOffset: 3, scalar: 'i64', abi: 'direct' },
  { id: 'array-before', wrapper: 'array', fields: 'unsigned int :3; signed int value:7;', size: 4, alignment: 4, bitOffset: 3, abi: 'direct' },
  { id: 'record-before', wrapper: 'record', fields: 'unsigned int :3; signed int value:7;', size: 4, alignment: 4, bitOffset: 3, abi: 'direct' },
];

const abiSignatures = {
  indirect: {
    ab_make: { params: ['i32', 'i32'], results: [] },
    ab_read: { params: ['i32'], results: ['i32'] },
    ab_change: { params: ['i32', 'i32'], results: [] },
    ab_invoke: { params: ['i32', 'i32', 'i32'], results: [] },
  },
  ignored: {
    ab_make: { params: ['i32'], results: [] },
    ab_read: { params: [], results: ['i32'] },
    ab_change: { params: [], results: [] },
    ab_invoke: { params: ['i32'], results: [] },
  },
};

export const cases = profiles.flatMap(profile => ['0', '2'].map(optimization => {
  const hasValue = profile.bitOffset !== undefined;
  const width = profile.width ?? 7;
  const member = profile.wrapper === 'array' ? 'cell[0].value' : profile.wrapper === 'record' ? 'cell.value' : 'value';
  const scalar = profile.scalar ?? 'i32';
  const header = `#ifndef ANONYMOUS_BITFIELD_H
#define ANONYMOUS_BITFIELD_H
typedef struct ${profile.attributes ? `__attribute__((${profile.attributes})) ` : ''}{ ${profile.fields} } ${profile.wrapper ? 'Inner' : 'Box'};
${profile.wrapper ? `typedef struct { Inner cell${profile.wrapper === 'array' ? '[1]' : ''}; } Box;\n` : ''}
Box ab_make(int);
int ab_read(Box);
Box ab_change(Box);
Box ab_invoke(Box, Box (*)(Box));
#endif
`;
  return {
    id: `anonymous-bitfield-${profile.id}-o${optimization}`,
    features: ['basic-c-abi', 'anonymous-bitfield-singleton', profile.id,
      'aggregate-argument', 'aggregate-return', 'multi-tu', 'indirect-call', 'callback',
      ...(hasValue ? ['named-bit-offset'] : ['empty-value-control'])],
    interop: true,
    printscan: false,
    stdcpp: false,
    oracleKind: 'same-source-clang',
    objectSignatures: true,
    signatures: profile.abi === 'direct' ? {
      ab_make: { params: ['i32'], results: [scalar] },
      ab_read: { params: [scalar], results: ['i32'] },
      ab_change: { params: [scalar], results: [scalar] },
      ab_invoke: { params: [scalar, 'i32'], results: [scalar] },
    } : abiSignatures[profile.abi],
    request: {
      language: 'c', standard: 'gnu11', optimization, emit: 'executable', simd: false,
      defines: ['ONLINE_JUDGE=1'],
      code: `#ifndef ONLINE_JUDGE
#error missing real macro option
#endif
#include <stdio.h>
#include "anonymous-bitfield.h"
static Box (*volatile maker)(int) = ab_make;
static int (*volatile reader)(Box) = ab_read;
static Box (*volatile changer)(Box) = ab_change;
static Box (*volatile invoker)(Box, Box (*)(Box)) = ab_invoke;
static int callbacks;
static Box callback(Box value) { callbacks++; ${hasValue ? `value.${member} += 1;` : ''} return value; }
${hasValue ? `static int named_bits(const Box *value) {
  const unsigned char *bytes = (const unsigned char *)value;
  unsigned result = 0;
  for (unsigned i = 0; i < ${width}; i++) {
    unsigned bit = ${profile.bitOffset} + i;
    result |= ((bytes[bit / 8] >> (bit % 8)) & 1u) << i;
  }
  return (result & ${2 ** (width - 1)}u) ? (int)result - ${2 ** width} : (int)result;
}
static int matches(const Box *value, int expected) {
  return value->${member} == expected && named_bits(value) == expected${profile.tag ? ' && value->tag == 17' : ''};
}` : ''}
int main(void) {
  int input;
  if (scanf("%d", &input) != 1 || input != -31) return 1;
  if (sizeof(Box) != ${profile.size} || _Alignof(Box) != ${profile.alignment}) return 2;
  Box a = ab_make(input), b = maker(input);
  ${hasValue ? 'if (!matches(&a, input) || !matches(&b, input)) return 3;' : ''}
  if (ab_read(a) != ${hasValue ? 'input' : '17'} || reader(b) != ${hasValue ? 'input' : '17'}) return 4;
  Box c = ab_change(a), d = changer(b);
  Box e = ab_invoke(a, callback), f = invoker(b, callback);
  if (callbacks != 2) return 5;
  ${hasValue ? `if (!matches(&c, input + 2) || !matches(&d, input + 2)) return 6;
  if (!matches(&e, input + 1) || !matches(&f, input + 1)) return 7;
  if (!matches(&a, input) || !matches(&b, input)) return 8;
  if (ab_read(c) != input + 2 || reader(e) != input + 1) return 9;` : 'if (ab_read(c) != 17 || reader(e) != 17) return 9;'}
  puts("anonymous bitfield ABI ok");
  return 0;
}
`,
      files: [
        { path: 'anonymous-bitfield.h', contents: header },
        { path: 'provider.c', contents: `#include "anonymous-bitfield.h"
__attribute__((noinline)) Box ab_make(int input) {
  Box result = {};
  ${hasValue ? `result.${member} = input;` : '(void)input;'}
  ${profile.tag ? 'result.tag = 17;' : ''}
  return result;
}
__attribute__((noinline)) int ab_read(Box value) { ${hasValue ? `return value.${member};` : '(void)value; return 17;'} }
__attribute__((noinline)) Box ab_change(Box value) { ${hasValue ? `value.${member} += 2;` : ''} return value; }
__attribute__((noinline)) Box ab_invoke(Box value, Box (*fn)(Box)) { return fn(value); }
` },
      ],
      sources: ['provider.c'],
    },
    stdin: '-31\n',
    stdout: 'anonymous bitfield ABI ok\n',
  };
}));
