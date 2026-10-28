// Real GCC/Clang vector ABI fixtures. Every provider is a separate translation
// unit, so neither inlining nor a source-language replacement can mask its ABI.
const modes = [
  ['i8x16', 'signed char', 16], ['i16x8', 'short', 8],
  ['i32x4', 'int', 4], ['i64x2', 'long long', 2],
  ['f32x4', 'float', 4], ['f64x2', 'double', 2],
];
const shapes = [
  { id: 'direct', declaration: 'typedef Vec Type;', access: '', direct: true },
  { id: 'singleton', declaration: 'typedef struct { Vec value; } Type;', access: '.value', direct: true },
  { id: 'array', declaration: 'typedef struct { Vec value[1]; } Type;', access: '.value[0]', direct: true },
  { id: 'nested', declaration: 'typedef struct { union { struct { Vec value; } inner[1]; } outer; } Type;', access: '.outer.inner[0].value', direct: true },
  { id: 'packed', declaration: 'typedef struct __attribute__((packed)) { Vec value; } Type;', access: '.value', direct: true },
  { id: 'aligned', declaration: 'typedef struct __attribute__((aligned(32))) { Vec value; } Type;', access: '.value', direct: false },
  { id: 'multiple', declaration: 'typedef struct { Vec value; int tag; } Type;', access: '.value', direct: false, tag: true },
  { id: 'union-multiple', declaration: 'typedef union { Vec value; int other[4]; } Type;', access: '.value', direct: false },
  { id: 'packed-offset', declaration: 'typedef struct __attribute__((packed)) { char tag; Vec value; } Type;', access: '.value', direct: false, tag: true },
  { id: 'cpp-packed', declaration: 'struct __attribute__((packed)) Type { Vec value; };', access: '.value', direct: true, cpp: true },
  { id: 'cpp-multiple', declaration: 'struct Type { Vec value; int tag; };', access: '.value', direct: false, tag: true, cpp: true },
  { id: 'cpp-direct', declaration: 'typedef Vec Type;', access: '', direct: true, cpp: true },
  { id: 'cpp-trivial', declaration: 'struct Type { Vec value; Type() {} };', access: '.value', direct: true, cpp: true },
  { id: 'cpp-nontrivial', declaration: 'struct Type { Vec value; Type() {} Type(const Type &other): value(other.value) {} ~Type() {} };', access: '.value', direct: false, cpp: true },
];

function makeCase([mode, lane, lanes], shape) {
  const field = name => `${name}${shape.access}`;
  const header = `#ifndef VECTOR_ABI_H
#define VECTOR_ABI_H
typedef ${lane} Lane;
typedef Lane Vec __attribute__((vector_size(16)));
${shape.declaration}
#ifdef __cplusplus
extern "C" {
#endif
Type make_value(Vec);
Vec read_value(Type);
Type modify_value(Type);
Type call_callback(Type, Type (*)(Type));
Vec mixed_values(int, Vec, long long, Vec, int);
#ifdef __cplusplus
}
#endif
#endif
`;
  return {
    id: `vector-abi-${mode}-${shape.id}`,
    mode, shape: shape.id,
    features: ['simd128', 'vector-abi', 'direct-call', 'indirect-call', 'callback', 'caller-copy', shape.direct ? 'direct-v128' : 'indirect-aggregate'],
    signatures: {
      make_value: shape.direct ? { params: ['v128'], results: ['v128'] } : { params: ['i32', 'v128'], results: [] },
      read_value: { params: [shape.direct ? 'v128' : 'i32'], results: ['v128'] },
      modify_value: shape.direct ? { params: ['v128'], results: ['v128'] } : { params: ['i32', 'i32'], results: [] },
      call_callback: shape.direct ? { params: ['v128', 'i32'], results: ['v128'] } : { params: ['i32', 'i32', 'i32'], results: [] },
      mixed_values: { params: ['i32', 'v128', 'i64', 'v128', 'i32'], results: ['v128'] },
    },
    request: {
      language: shape.cpp ? 'cpp' : 'c', standard: shape.cpp ? 'gnu++17' : 'gnu11',
      emit: 'executable', simd: true,
      code: `#include <stdio.h>
#include "vector-abi.h"
static Type callback(Type value) { ${field('value')}[0] += 3; return value; }
static Vec (*volatile reader)(Type) = read_value;
static Type (*volatile maker)(Vec) = make_value;
static Type (*volatile modifier)(Type) = modify_value;
static Vec (*volatile mixer)(int, Vec, long long, Vec, int) = mixed_values;
static int check(Vec value, Vec expected, int delta) {
  for (int i = 0; i < ${lanes}; ++i)
    if (value[i] != expected[i] + (i == 0 ? delta : 0)) return 0;
  return 1;
}
int main(void) {
  int seed = 0;
  if (scanf("%d", &seed) != 1) return 10;
  Vec expected, other;
  for (int i = 0; i < ${lanes}; ++i) { expected[i] = (Lane)(seed + i * 2); other[i] = expected[i] + 9; }
  Type original = make_value(expected);
  if (!check(${field('original')}, expected, 0)) return 11;
  Type indirect = maker(expected);
  if (!check(${field('indirect')}, expected, 0)) return 12;
  if (!check(read_value(original), expected, 0)) return 13;
  if (!check(reader(original), expected, 0)) return 14;
  Type modified = modify_value(original);
  if (!check(${field('modified')}, expected, 1) || !check(${field('original')}, expected, 0)) return 15;
  Type modified_indirect = modifier(original);
  if (!check(${field('modified_indirect')}, expected, 1)) return 16;
  Type callback_result = call_callback(original, callback);
  if (!check(${field('callback_result')}, expected, 3) || !check(${field('original')}, expected, 0)) return 17;
  Type copies[2] = {original, callback_result};
  copies[0] = copies[1];
  if (!check(${field('copies[0]')}, expected, 3)) return 18;
  if (!check(mixed_values(2, expected, 4294967303LL, other, 5), expected, 14)) return 19;
  if (!check(mixer(2, expected, 4294967307LL, other, 5), other, 18)) return 20;
  ${shape.tag ? 'if (original.tag != 93 || modified.tag != 93 || copies[0].tag != 93) return 21;' : ''}
  puts("vector ABI ok");
  return 0;
}
`,
      files: [
        { path: 'vector-abi.h', contents: header },
        { path: 'provider.c', contents: `#include "vector-abi.h"
__attribute__((noinline)) Type make_value(Vec value) { Type result; ${field('result')} = value; ${shape.tag ? 'result.tag = 93;' : ''} return result; }
__attribute__((noinline)) Vec read_value(Type value) { return ${field('value')}; }
__attribute__((noinline)) Type modify_value(Type value) { ${field('value')}[0] += 1; return value; }
__attribute__((noinline)) Type call_callback(Type value, Type (*callback)(Type)) { return callback(value); }
__attribute__((noinline)) Vec mixed_values(int before, Vec left, long long cookie, Vec right, int after) {
  Vec result = cookie == 4294967303LL ? left : right;
  result[0] += (Lane)(before + (cookie & 255) + after);
  return result;
}
` },
      ], sources: ['provider.c'],
    }, stdin: '-7\n', stdout: 'vector ABI ok\n',
  };
}

export const cases = modes.flatMap(mode => shapes.map(shape => makeCase(mode, shape)));

// An off-profile vector remains an indirectly passed memory object. Its type
// need not be supported as a Wasm register; GCC may scalarize its operations.
// Cross-compiler interop is intentionally not asserted without SIMD enabled.
export const disabledCases = modes.map(mode => {
  const fixture = makeCase(mode, shapes[0]);
  return { ...fixture, id: `${fixture.id}-disabled`, request: { ...fixture.request, simd: false }, signatures: {
    make_value: { params: ['i32', 'i32'], results: [] },
    read_value: { params: ['i32', 'i32'], results: [] },
    modify_value: { params: ['i32', 'i32'], results: [] },
    call_callback: { params: ['i32', 'i32', 'i32'], results: [] },
    mixed_values: { params: ['i32', 'i32', 'i32', 'i64', 'i32', 'i32'], results: [] },
  } };
});
