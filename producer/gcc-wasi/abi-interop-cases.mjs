// Basic C ABI fixtures shared by native interop and GCC-only browser tests.
// Clang is only the independent ABI comparison compiler in abi-interop.mjs.
const request = { language: 'c', standard: 'gnu11', emit: 'executable', optimization: '0' };

function aggregate(id, declaration, scalar, access, value, cpp = false) {
  const header = `${declaration}\ntypedef ${scalar} Scalar;
Type make_value(Scalar);
Scalar read_value(Type);
Scalar modify_value(Type);
Scalar call_callback(Type, Scalar (*)(Type));\n`;
  return {
    id: `abi-${id}`,
    features: ['basic-c-abi', 'aggregate-argument', 'aggregate-return', 'indirect-call', 'cross-compiler-callback'],
    request: {
      ...request,
      ...(cpp ? { language: 'cpp', standard: 'gnu++17' } : {}),
      code: `#include <stdio.h>
#include "abi.h"
static Scalar callback(Type x) { return x.${access}; }
static Scalar (*volatile reader)(Type) = read_value;
static Type (*volatile maker)(Scalar) = make_value;
int main(void) {
  Scalar expected = ${value};
  Type x = {0}; x.${access} = expected;
  if (read_value(x) != expected) return 11;
  if (reader(x) != expected) return 12;
  Type y = make_value(expected);
  if (y.${access} != expected) return 13;
  Type z = maker(expected);
  if (z.${access} != expected) return 14;
  if (call_callback(x, callback) != expected) return 15;
  if (modify_value(x) != expected + 1 || x.${access} != expected) return 16;
  puts("ok"); return 0;
}\n`,
      files: [
        { path: 'abi.h', contents: header },
        { path: 'provider.c', contents: `#include "abi.h"
__attribute__((noinline)) Type make_value(Scalar x) { Type r = {0}; r.${access} = x; return r; }
__attribute__((noinline)) Scalar read_value(Type r) { return r.${access}; }
__attribute__((noinline)) Scalar modify_value(Type r) { r.${access} += 1; return r.${access}; }
__attribute__((noinline)) Scalar call_callback(Type r, Scalar (*f)(Type)) { return f(r); }\n` },
      ],
      sources: ['provider.c'],
    },
    stdin: '', stdout: 'ok\n',
  };
}

export const cases = [
  aggregate('singleton-i32', 'typedef struct { int value; } Type;', 'int', 'value', '-1234567'),
  aggregate('singleton-f32', 'typedef struct { float value; } Type;', 'float', 'value', '3.125f'),
  aggregate('singleton-f64', 'typedef struct { double value; } Type;', 'double', 'value', '-19.375'),
  aggregate('singleton-i64', 'typedef struct { long long value; } Type;', 'long long', 'value', '-4294967303LL'),
  aggregate('singleton-u64', 'typedef struct { unsigned long long value; } Type;', 'unsigned long long', 'value', '0xfedcba9876543210ULL'),
  aggregate('singleton-i8', 'typedef struct { signed char value; } Type;', 'signed char', 'value', '-101'),
  aggregate('singleton-u8', 'typedef struct { unsigned char value; } Type;', 'unsigned char', 'value', '251'),
  aggregate('singleton-i16', 'typedef struct { short value; } Type;', 'short', 'value', '-32001'),
  aggregate('singleton-u16', 'typedef struct { unsigned short value; } Type;', 'unsigned short', 'value', '65001'),
  aggregate('singleton-nested', 'typedef struct { union { struct { double value; } inner[1]; } outer; } Type;', 'double', 'outer.inner[0].value', '42.625'),
  aggregate('singleton-union', 'typedef union { float value; } Type;', 'float', 'value', '-7.25f'),
  aggregate('singleton-array', 'typedef struct { long long value[1]; } Type;', 'long long', 'value[0]', '4294967303LL'),
  aggregate('singleton-packed', 'typedef struct __attribute__((packed)) { double value; } Type;', 'double', 'value', '-3.75'),
  aggregate('singleton-zero-array', 'typedef struct { int value; char zero[0]; } Type;', 'int', 'value', '42'),
  aggregate('singleton-bitfield', 'typedef struct { int value: 7; } Type;', 'int', 'value', '-31'),
  aggregate('aligned-aggregate', 'typedef struct __attribute__((aligned(16))) { double value; } Type;', 'double', 'value', '23.5'),
  aggregate('flexible-array-aggregate', 'typedef struct { int value; char bytes[]; } Type;', 'int', 'value', '42'),
  aggregate('multiple-fields', 'typedef struct { int value; int other; } Type;', 'int', 'value', '42'),
  aggregate('multiple-union-fields', 'typedef union { int value; float other; } Type;', 'int', 'value', '42'),
  aggregate('singleton-pointer', 'typedef struct { const char *value; } Type;', 'const char *', 'value', '"pointer"'),
  aggregate('cpp-nontrivial', 'struct Type { int value; Type(int n = 0): value(n) {} Type(const Type &other): value(other.value) {} ~Type() { value = 0; } };', 'int', 'value', '42', true),
  aggregate('cpp-trivial', 'struct Type { double value; Type(double n = 0): value(n) {} };', 'double', 'value', '42.625', true),
  {
    id: 'abi-scalar-narrow', features: ['basic-c-abi', 'signed-extension', 'unsigned-extension'],
    exports: ['echo_i8', 'echo_u8', 'echo_i16', 'echo_u16'],
    rawCalls: [['echo_i8', [155], -101], ['echo_u8', [507], 251], ['echo_i16', [33535], -32001], ['echo_u16', [130537], 65001]],
    request: {
      ...request,
      code: `#include <stdio.h>
#include "abi.h"
int main(void) {
  if (echo_i8(-101) != -101 || echo_u8(251) != 251 || echo_i16(-32001) != -32001 || echo_u16(65001) != 65001) return 20;
  puts("ok"); return 0;
}\n`,
      files: [
        { path: 'abi.h', contents: 'signed char echo_i8(int);\nunsigned char echo_u8(int);\nshort echo_i16(int);\nunsigned short echo_u16(int);\n' },
        { path: 'provider.c', contents: '#include "abi.h"\nsigned char echo_i8(int x) { return (signed char)x; }\nunsigned char echo_u8(int x) { return (unsigned char)x; }\nshort echo_i16(int x) { return (short)x; }\nunsigned short echo_u16(int x) { return (unsigned short)x; }\n' },
      ], sources: ['provider.c'],
    }, stdin: '', stdout: 'ok\n',
  },
  {
    id: 'abi-varargs-interoperability', features: ['basic-c-abi', 'varargs', 'singleton-varargs', 'aggregate-varargs'],
    request: {
      ...request,
      code: `#include <stdio.h>
#include "abi.h"
int main(void) { Single a = {3.125}; Pair b = {11, 31}; if (inspect(7, -11, 1234567890123LL, a, b) != 42) return 21; puts("ok"); return 0; }\n`,
      files: [
        { path: 'abi.h', contents: 'typedef struct { double value; } Single;\ntypedef struct { int a; int b; } Pair;\nint inspect(int, ...);\n' },
        { path: 'provider.c', contents: `#include <stdarg.h>
#include "abi.h"
int inspect(int tag, ...) { va_list ap; va_start(ap, tag); int a = va_arg(ap,int); long long b = va_arg(ap,long long); Single s = va_arg(ap,Single); Pair p = va_arg(ap,Pair); va_end(ap); return tag == 7 && a == -11 && b == 1234567890123LL && s.value == 3.125 ? p.a + p.b : -1; }\n` },
      ], sources: ['provider.c'],
    }, stdin: '', stdout: 'ok\n',
  },
  {
    id: 'abi-empty-aggregate', features: ['basic-c-abi', 'empty-aggregate', 'aggregate-return'],
    request: {
      ...request,
      code: '#include <stdio.h>\n#include "abi.h"\nint main(void) { Empty e = make_empty(); if (use_empty(e,42) != 42) return 22; puts("ok"); return 0; }\n',
      files: [
        { path: 'abi.h', contents: 'typedef struct {} Empty;\nEmpty make_empty(void);\nint use_empty(Empty,int);\n' },
        { path: 'provider.c', contents: '#include "abi.h"\nEmpty make_empty(void) { Empty e; return e; }\nint use_empty(Empty e,int x) { return x; }\n' },
      ], sources: ['provider.c'],
    }, stdin: '', stdout: 'ok\n',
  },
];
