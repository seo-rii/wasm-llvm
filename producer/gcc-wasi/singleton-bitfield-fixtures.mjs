// Regression for declared bitfield storage types in the Basic C ABI.
// The original source is compiled independently by GCC and the Clang oracle.
// Only named field values are observed; record padding is never compared.
const profiles = [
  { id: 'short7', type: 'signed short', size: 2, alignment: 2, scalar: 'i32' },
  { id: 'longlong7', type: 'signed long long', size: 8, alignment: 8, scalar: 'i64' },
  { id: 'packed-int7', type: 'signed int', size: 1, alignment: 1, packed: true },
  { id: 'packed-longlong7', type: 'signed long long', size: 1, alignment: 1, packed: true },
];

export const cases = profiles.flatMap(profile => ['0', '2'].map(optimization => {
  const header = `#ifndef SINGLETON_BITFIELD_H
#define SINGLETON_BITFIELD_H
typedef struct ${profile.packed ? '__attribute__((packed)) ' : ''}{ ${profile.type} value:7; } Box;
Box sb_make(int);
int sb_read(Box);
Box sb_change(Box);
Box sb_invoke(Box, Box (*)(Box));
#endif
`;
  const signatures = profile.packed ? {
    sb_make: { params: ['i32', 'i32'], results: [] },
    sb_read: { params: ['i32'], results: ['i32'] },
    sb_change: { params: ['i32', 'i32'], results: [] },
    sb_invoke: { params: ['i32', 'i32', 'i32'], results: [] },
  } : {
    sb_make: { params: ['i32'], results: [profile.scalar] },
    sb_read: { params: [profile.scalar], results: ['i32'] },
    sb_change: { params: [profile.scalar], results: [profile.scalar] },
    sb_invoke: { params: [profile.scalar, 'i32'], results: [profile.scalar] },
  };
  return {
    id: `singleton-bitfield-${profile.id}-o${optimization}`,
    features: ['basic-c-abi', 'declared-bitfield-storage-type', profile.id,
      'aggregate-argument', 'aggregate-return', 'multi-tu', 'indirect-call', 'callback'],
    interop: true,
    printscan: false,
    stdcpp: false,
    oracleKind: 'same-source-clang',
    signatures,
    request: {
      language: 'c', standard: 'gnu11', optimization, emit: 'executable', simd: false,
      defines: ['ONLINE_JUDGE=1'],
      code: `#ifndef ONLINE_JUDGE
#error missing real macro option
#endif
#include <stdio.h>
#include "singleton-bitfield.h"
static Box (*volatile maker)(int) = sb_make;
static int (*volatile reader)(Box) = sb_read;
static Box callback(Box value) { value.value += 1; return value; }
int main(void) {
  int input;
  if (scanf("%d", &input) != 1 || input != -31) return 1;
  if (sizeof(Box) != ${profile.size} || _Alignof(Box) != ${profile.alignment}) return 2;
  Box a = sb_make(input), b = maker(input);
  if (a.value != input || b.value != input) return 3;
  if (sb_read(a) != input || reader(b) != input) return 4;
  Box changed = sb_change(a), called = sb_invoke(b, callback);
  if (changed.value != input + 2 || called.value != input + 1) return 5;
  if (a.value != input || b.value != input) return 6;
  if (sb_read(changed) != input + 2 || reader(called) != input + 1) return 7;
  puts("singleton bitfield ABI ok");
  return 0;
}
`,
      files: [
        { path: 'singleton-bitfield.h', contents: header },
        { path: 'provider.c', contents: `#include "singleton-bitfield.h"
__attribute__((noinline)) Box sb_make(int input) { Box result = {0}; result.value = input; return result; }
__attribute__((noinline)) int sb_read(Box value) { return value.value; }
__attribute__((noinline)) Box sb_change(Box value) { value.value += 2; return value; }
__attribute__((noinline)) Box sb_invoke(Box value, Box (*fn)(Box)) { return fn(value); }
` },
      ],
      sources: ['provider.c'],
    },
    stdin: '-31\n',
    stdout: 'singleton bitfield ABI ok\n',
  };
}));
