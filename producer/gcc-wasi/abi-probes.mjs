// Diagnostic programs for the real GCC frontend/backend. Passing a GCC-only
// case does not establish compatibility with a different compiler's ABI.
// abiInterop.referenceSources identifies optional Clang-built COMPARISON
// objects; never use that mode as evidence that GCC compiled those sources.
const c = { language: 'c', emit: 'executable', standard: 'gnu11', optimization: '0' };
const cpp = { language: 'cpp', emit: 'executable', standard: 'gnu++17', optimization: '0' };
const typedefVoidCode = `#include <stdio.h>
typedef void V;
static volatile int value;
__attribute__((noinline)) V f() { value += 19; return; }
__attribute__((noinline)) void g() { value += 23; return; }
static V (*volatile callback)() = f;
int main() { callback(); g(); printf("%d\\n", value); return 0; }
`;
const hostWideIntegerCode = `#include <stdio.h>
int main(void) {
  unsigned long long n;
  if (scanf("%llu", &n) != 1) return 2;
  unsigned long long mixed = n ^ 0xfedcba9876543210ULL;
  long long negative = -4294967303LL - (long long)n;
  printf("%llu %lld %llu\\n", mixed, negative, mixed / 17ULL);
  return 0;
}
`;

export const cases = [
  ...['0', '2'].map(optimization => ({
    id: `abi-host-wide-integers-o${optimization}`,
    features: ['host-width-independent-codegen', 'int64', 'negative-int64', 'unsigned-high-bit', 'int64-division'],
    request: { ...c, optimization, code: hostWideIntegerCode },
    stdin: '9\n', stdout: '18364758544493064729 -4294967312 1080279914381944984\n',
  })),
  ...['0', '2'].map(optimization => ({
    id: `abi-cpp-typedef-void-o${optimization}`,
    features: ['c++-typedef-void', 'void-return', 'function-pointers'],
    request: { ...cpp, optimization, code: typedefVoidCode },
    stdin: '', stdout: '42\n',
  })),
  {
    id: 'abi-long-double-layout',
    features: ['wasi-long-double-abi'],
    request: { ...c, code: `#include <stdio.h>
int main(void) {
  printf("%u %u %d\\n", (unsigned)sizeof(long double),
    (unsigned)_Alignof(long double), __LDBL_MANT_DIG__);
  return 0;
}
` },
    stdin: '', stdout: '16 16 113\n',
  },
  {
    id: 'abi-long-double-libm',
    features: ['long-double', 'libm', 'wasi-libc-abi'],
    request: { ...c, code: `#include <math.h>
#include <stdio.h>
int main(void) {
  volatile long double x = 4.0L;
  printf("%.3f\\n", (double)sqrtl(x));
  return 0;
}
` },
    stdin: '', stdout: '2.000\n',
  },
  {
    id: 'abi-varargs',
    features: ['varargs', 'double', 'int64', 'stack-alignment'],
    request: { ...c, code: `#include <stdarg.h>
#include <stdio.h>
__attribute__((noinline)) void inspect(int tag, ...) {
  va_list ap;
  va_start(ap, tag);
  int a = va_arg(ap, int);
  double b = va_arg(ap, double);
  long long c = va_arg(ap, long long);
  va_end(ap);
  printf("%d %d %.3f %lld\\n", tag, a, b, c);
}
int main(void) { inspect(7, -11, 3.125, 1234567890123LL); return 0; }
` },
    stdin: '', stdout: '7 -11 3.125 1234567890123\n',
  },
  {
    id: 'abi-libc-callback',
    features: ['libc', 'qsort', 'function-pointers', 'cross-compiler-callback'],
    request: { ...c, code: `#include <stdlib.h>
#include <stdio.h>
static int compare(const void *a, const void *b) {
  int x = *(const int *)a, y = *(const int *)b;
  return (x > y) - (x < y);
}
int main(void) {
  int values[] = {9, 1, -3, 2};
  qsort(values, 4, sizeof(values[0]), compare);
  printf("%d %d %d %d\\n", values[0], values[1], values[2], values[3]);
  return 0;
}
` },
    stdin: '', stdout: '-3 1 2 9\n',
  },
  {
    id: 'abi-data-relocations',
    features: ['global-pointers', 'data-relocation-addends', 'function-table-relocations', 'multiple-translation-units'],
    request: {
      ...c,
      code: `#include <stdio.h>
#include "relocations.h"
static int *number_pointer = &number;
static const char *suffix = message + 4;
static int (*callbacks[])(int) = {add_seven};
int main(void) {
  printf("%d %s %d\\n", *number_pointer, suffix, callbacks[0](35));
  return 0;
}
`,
      files: [
        { path: 'relocations.h', contents: 'extern int number;\nextern const char message[];\nint add_seven(int);\n' },
        { path: 'provider.c', contents: '#include "relocations.h"\nint number = 42;\nconst char message[] = "gcc-wasm";\nint add_seven(int n) { return n + 7; }\n' },
      ],
      sources: ['provider.c'],
    },
    stdin: '', stdout: '42 wasm 42\n',
  },
  {
    id: 'abi-singleton-struct',
    features: ['singleton-struct-arguments', 'singleton-struct-return', 'multiple-translation-units'],
    abiInterop: { referenceSources: ['provider.c'], purpose: 'Compare GCC calls against the Basic C ABI singleton scalar convention.' },
    request: {
      ...c,
      code: `#include <stdio.h>
#include "aggregate.h"
int main(void) { struct Single x = make_single(35); printf("%d %d\\n", x.value, read_single(x)); return 0; }
`,
      files: [
        { path: 'aggregate.h', contents: 'struct Single { int value; };\nstruct Single make_single(int);\nint read_single(struct Single);\n' },
        { path: 'provider.c', contents: '#include "aggregate.h"\nstruct Single make_single(int n) { struct Single s = {n + 7}; return s; }\nint read_single(struct Single s) { return s.value; }\n' },
      ],
      sources: ['provider.c'],
    },
    stdin: '', stdout: '42 42\n',
  },
  {
    id: 'abi-singleton-argument-only',
    features: ['singleton-struct-arguments', 'multiple-translation-units'],
    abiInterop: { referenceSources: ['provider.c'], purpose: 'Detect silent singleton argument ABI mismatches even when both signatures are (i32) -> i32.' },
    request: {
      ...c,
      code: `#include <stdio.h>
#include "aggregate.h"
int main(void) { struct Single x = {42}; printf("%d\\n", read_single(x)); return 0; }
`,
      files: [
        { path: 'aggregate.h', contents: 'struct Single { int value; };\nint read_single(struct Single);\n' },
        { path: 'provider.c', contents: '#include "aggregate.h"\nint read_single(struct Single s) { return s.value; }\n' },
      ],
      sources: ['provider.c'],
    },
    stdin: '', stdout: '42\n',
  },
  {
    id: 'abi-mixed-struct',
    features: ['struct-arguments', 'struct-return', 'double', 'int64', 'multiple-translation-units'],
    abiInterop: { referenceSources: ['provider.c'], purpose: 'Compare GCC and Clang indirect aggregate ABI with mixed alignment.' },
    request: {
      ...c,
      code: `#include <stdio.h>
#include "aggregate.h"
int main(void) { struct Mixed m = make_mixed(); printf("%.1f %lld %d %d\\n", m.value, m.number, (int)m.tag, check_mixed(m)); return 0; }
`,
      files: [
        { path: 'aggregate.h', contents: 'struct Mixed { double value; long long number; char tag; };\nstruct Mixed make_mixed(void);\nint check_mixed(struct Mixed);\n' },
        { path: 'provider.c', contents: '#include "aggregate.h"\nstruct Mixed make_mixed(void) { struct Mixed m = {4.5, 1234567890123LL, 65}; return m; }\nint check_mixed(struct Mixed m) { return m.value == 4.5 && m.number == 1234567890123LL && m.tag == 65; }\n' },
      ],
      sources: ['provider.c'],
    },
    stdin: '', stdout: '4.5 1234567890123 65 1\n',
  },
  {
    id: 'abi-c-constructor-priority',
    features: ['static-initialization', 'constructor-priority'],
    request: { ...c, code: `#include <stdio.h>
static int value;
__attribute__((constructor(201))) static void first(void) { value = 4; }
__attribute__((constructor(301))) static void second(void) { value = value * 10 + 2; }
int main(void) { printf("%d\\n", value); return 0; }
` },
    stdin: '', stdout: '42\n',
  },
  {
    id: 'abi-cpp-static-destructor',
    features: ['c++-static-initialization', 'c++-static-destruction'],
    request: { ...cpp, code: `#include <stdio.h>
struct Lifetime {
  Lifetime() { puts("construct"); }
  ~Lifetime() { puts("destroy"); }
};
static Lifetime lifetime;
int main() { puts("main"); return 0; }
` },
    stdin: '', stdout: 'construct\nmain\ndestroy\n',
  },
  {
    id: 'abi-cpp-local-static',
    features: ['c++-local-static', 'guard-runtime', 'static-destruction'],
    request: { ...cpp, code: `#include <stdio.h>
struct Lifetime {
  Lifetime() { puts("construct"); }
  ~Lifetime() { puts("destroy"); }
};
static void once() { static Lifetime lifetime; }
int main() { once(); once(); puts("main"); return 0; }
` },
    stdin: '', stdout: 'construct\nmain\ndestroy\n',
  },
];
