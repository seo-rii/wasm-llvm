// IEEE binary128 / WASI Basic C ABI qualification. This module also works with
// wasm-idle/scripts/verify-gcc-wasi.mjs --suite: every case contains real C/C++.
// Expectations use exact dyadic constants, integer/byte observations, or explicit
// decimal literals; test-long-double.mjs checks them independently with Clang.
const profiles = [];
const add = (id, code, extra = {}) => profiles.push({ id, code, ...extra });

add('layout-precision', `#include <stdio.h>
#include <stddef.h>
#include <float.h>
struct Layout { char before; long double value; char after; };
static volatile long double one = 1.0L, epsilon = 0x1p-100L;
int main(void) {
  long double sum = one + epsilon;
  printf("%u %u %u %u %d %d %d %d\\n", (unsigned)sizeof(long double),
    (unsigned)_Alignof(long double), (unsigned)offsetof(struct Layout, value),
    (unsigned)sizeof(struct Layout), LDBL_MANT_DIG, LDBL_MAX_EXP,
    sum > one, sum - one == epsilon);
  return 0;
}
`, { stdout: '16 16 16 48 113 16384 1 1\n', features: ['layout', 'binary128-precision'] });

add('arithmetic', `#include <stdio.h>
static volatile long double tiny = 0x1p-100L;
__attribute__((noinline)) static long double compute(long double a, long double b) {
  long double p = a * b;
  return p / b - a;
}
int main(void) {
  int n; if (scanf("%d", &n) != 1) return 1;
  volatile long double a = (long double)n + tiny, b = 4.0L;
  long double sum = a + tiny, difference = sum - (long double)n;
  printf("%d %d %d %d %d %d\\n", sum > a, difference == 2*tiny,
    compute(a,b) == 0, -a < 0, -(-a) == a, __builtin_fabsl(-a) == a);
  return 0;
}
`, { stdin: '3\n', stdout: '1 1 1 1 1 1\n', features: ['add', 'subtract', 'multiply', 'divide', 'negate', 'absolute'] });

add('conversions', `#include <stdio.h>
#include <limits.h>
static volatile long long signed_value = LLONG_MIN;
static volatile unsigned long long unsigned_value = ULLONG_MAX;
static volatile int signed_word = INT_MIN;
static volatile unsigned int unsigned_word = UINT_MAX;
static volatile double double_value = 0x1.0000000000001p+0;
static volatile float float_value = 1.5f;
int main(void) {
  volatile long double a = signed_value, b = unsigned_value;
  volatile long double c = double_value, d = float_value;
  volatile long double si = signed_word, ui = unsigned_word;
  volatile long double positive = 4294967295.75L, negative = -2147483648.75L;
  volatile long double fractional = -3.75L;
  printf("%d %d %d %d %d %d %d %d %d %d\\n", (long long)a == LLONG_MIN,
    (unsigned long long)b == ULLONG_MAX, b + 1 == 0x1p64L,
    (double)c == double_value && c > 1, (float)d == float_value,
    (unsigned int)positive == UINT_MAX, (int)negative == INT_MIN,
    (int)fractional == -3, si == -2147483648.0L, ui == 4294967295.0L);
  return 0;
}
`, { stdout: '1 1 1 1 1 1 1 1 1 1\n', features: ['signed-conversion', 'unsigned-conversion', 'float-conversion', 'double-conversion'] });

add('special-values', `#include <stdio.h>
static volatile long double nan_value = __builtin_nanl(""), inf_value = __builtin_infl();
static volatile long double positive_zero = 0.0L, negative_zero = -0.0L;
static volatile long double subnormal = 0x1p-16494L;
int main(void) {
  long double nan = nan_value, inf = inf_value, nz = negative_zero;
  printf("%d %d %d %d %d %d %d %d %d\\n", nan != nan, !(nan == nan),
    !(nan < 1), !(nan >= 1), inf > 0x1p16383L,
    positive_zero == nz, !!__builtin_signbitl(nz),
    !__builtin_signbitl(__builtin_fabsl(nz)), subnormal > 0 && subnormal/2 == 0);
  return 0;
}
`, { stdout: '1 1 1 1 1 1 1 1 1\n', features: ['nan', 'infinity', 'signed-zero', 'subnormal'] });

add('nan-payload', `#include <stdio.h>
#include <string.h>
static volatile unsigned long long payload[2] = {0x456789abcdef0123ULL,0xffff800000000123ULL};
static volatile long double negative_zero = -0.0L, positive_zero = 0.0L;
__attribute__((noinline)) static int bits_equal(long double value, unsigned long long low, unsigned long long high) {
  unsigned long long words[2]; memcpy(words,&value,sizeof(words));
  return words[0]==low && words[1]==high;
}
int main(void) {
  unsigned long long words[2]={payload[0],payload[1]};
  long double value; memcpy(&value,words,sizeof(value));
  volatile long double stored=value;
  long double negated=-stored, absolute=__builtin_fabsl(stored);
  long double positive=__builtin_copysignl(stored,positive_zero);
  long double negative=__builtin_copysignl(absolute,negative_zero);
  printf("%d %d %d %d %d %d %d\\n",
    bits_equal(stored,words[0],words[1]),
    bits_equal(negated,words[0],words[1]^0x8000000000000000ULL),
    bits_equal(absolute,words[0],words[1]&0x7fffffffffffffffULL),
    bits_equal(positive,words[0],words[1]&0x7fffffffffffffffULL),
    bits_equal(negative,words[0],words[1]),
    !!__builtin_signbitl(stored), !__builtin_signbitl(absolute));
  return 0;
}
`, { stdout: '1 1 1 1 1 1 1\n', features: ['nan-payload', 'negate', 'absolute', 'copysign', 'signbit', 'volatile-copy'] });

add('storage', `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct __attribute__((packed)) Packed { char tag; long double value; };
static long double globals[3] = {1.0L, -2.5L, 0x1p-100L};
static volatile struct Packed packed = {7, 1.0L};
int main(void) {
  long double local[3], *heap = malloc(sizeof(globals));
  if (!heap) return 1;
  memcpy(local, globals, sizeof(local)); memcpy(heap, local, sizeof(local));
  packed.value = heap[0] + heap[2];
  long double unaligned = packed.value;
  unsigned long long words[2]; memcpy(words, &heap[0], sizeof(words));
  printf("%d %d %d %d %d\\n", sizeof(globals) == 48,
    words[0] == 0 && words[1] == 0x3fff000000000000ULL,
    heap[1] == -2.5L, unaligned - 1 == heap[2], packed.tag == 7);
  free(heap); return 0;
}
`, { stdout: '1 1 1 1 1\n', features: ['global', 'stack', 'heap', 'packed', 'memcpy', 'little-endian-binary128'] });

const shapes = [
  { id: 'scalar', declaration: 'typedef long double Value;', member: '', direct: true },
  { id: 'singleton', declaration: 'typedef struct { long double value; } Value;', member: '.value', direct: true },
  { id: 'array', declaration: 'typedef struct { long double value[1]; } Value;', member: '.value[0]', direct: true },
  { id: 'nested', declaration: 'typedef struct { union { struct { long double value; } inner[1]; } outer; } Value;', member: '.outer.inner[0].value', direct: true },
  { id: 'aligned', declaration: 'typedef struct __attribute__((aligned(32))) { long double value; } Value;', member: '.value', direct: false },
  { id: 'multiple', declaration: 'typedef struct { long double value; int tag; } Value;', member: '.value', direct: false, tag: true },
  { id: 'packed-offset', declaration: 'typedef struct __attribute__((packed)) { char tag; long double value; } Value;', member: '.value', direct: false, tag: true },
  { id: 'cpp-nontrivial', declaration: 'struct Value { long double value; Value() {} Value(const Value &x): value(x.value) {} ~Value() {} };', member: '.value', direct: false, cpp: true },
];
for (const shape of shapes) {
  const get = value => value + shape.member;
  const header = `#ifndef LONG_DOUBLE_ABI_H
#define LONG_DOUBLE_ABI_H
${shape.declaration}
#ifdef __cplusplus
extern "C" {
#endif
Value ld_make(int);
Value ld_modify(Value);
int ld_inspect(Value);
Value ld_invoke(Value, Value (*)(Value));
long double ld_mixed(int, long double, long long, long double, int);
#ifdef __cplusplus
}
#endif
#endif
`;
  const args = shape.direct ? ['i64', 'i64'] : ['i32'];
  add(`abi-${shape.id}`, `#include <stdio.h>
#include "long-double-abi.h"
static Value callback(Value value) { ${get('value')} += 0x1p-99L; return value; }
static Value (*volatile maker)(int) = ld_make;
static Value (*volatile modifier)(Value) = ld_modify;
static int (*volatile inspector)(Value) = ld_inspect;
static long double (*volatile mixer)(int,long double,long long,long double,int) = ld_mixed;
int main(void) {
  int n; if (scanf("%d", &n) != 1 || n != 3) return 1;
  Value a = ld_make(n), b = maker(n);
  if (${get('a')} != 3.0L+0x1p-100L || ${get('b')} != ${get('a')}) return 2;
  Value c = ld_modify(a), d = modifier(b), e = ld_invoke(a, callback);
  if (${get('c')}-${get('a')} != 0x1p-99L || ${get('d')} != ${get('c')} || ${get('e')} != ${get('c')}) return 3;
  if (!ld_inspect(a) || !inspector(b) || ${get('a')} != 3.0L+0x1p-100L) return 4;
  ${shape.tag ? 'if (a.tag != 93 || c.tag != 93 || e.tag != 93) return 5;' : ''}
  long double x = ld_mixed(7, 1.0L+0x1p-100L, 4294967303LL, 2.0L, 9);
  long double y = mixer(7, 1.0L+0x1p-100L, 4294967303LL, 2.0L, 9);
  if (x != 3.0L+0x1p-100L || y != x) return 6;
  puts("long double ABI ok"); return 0;
}
`, {
    language: shape.cpp ? 'cpp' : 'c', stdin: '3\n', stdout: 'long double ABI ok\n', interop: true,
    features: ['binary128-abi', shape.id, 'direct', 'indirect', 'callback', 'mixed-arguments'],
    files: [{ path: 'long-double-abi.h', contents: header }, { path: shape.cpp ? 'provider.cpp' : 'provider.c', contents: `#include "long-double-abi.h"
__attribute__((noinline)) Value ld_make(int n) { Value result; ${get('result')} = (long double)n+0x1p-100L; ${shape.tag ? 'result.tag=93;' : ''} return result; }
__attribute__((noinline)) Value ld_modify(Value value) { ${get('value')} += 0x1p-99L; return value; }
__attribute__((noinline)) int ld_inspect(Value value) { return ${get('value')} == 3.0L+0x1p-100L; }
__attribute__((noinline)) Value ld_invoke(Value value, Value (*f)(Value)) { return f(value); }
__attribute__((noinline)) long double ld_mixed(int a, long double x, long long cookie, long double y, int b) { return a==7 && cookie==4294967303LL && b==9 ? x+y : -1.0L; }
` }], sources: [shape.cpp ? 'provider.cpp' : 'provider.c'],
    signatures: {
      ld_make: { params: ['i32', 'i32'], results: [] },
      ld_modify: { params: ['i32', ...args], results: [] },
      ld_inspect: { params: args, results: ['i32'] },
      ld_invoke: { params: ['i32', ...args, 'i32'], results: [] },
      ld_mixed: { params: ['i32', 'i32', 'i64', 'i64', 'i64', 'i64', 'i64', 'i32'], results: [] },
    },
  });
}

add('varargs', `#include <stdio.h>
#include "long-double-varargs.h"
static long double (*volatile indirect)(int,...) = ld_variadic;
int main(void) {
  Box value = { 2.0L+0x1p-100L };
  long double a = ld_variadic(7, 31, 1.0L+0x1p-100L, 4294967303LL, 1.5, value, 19);
  long double b = indirect(7, 31, 1.0L+0x1p-100L, 4294967303LL, 1.5, value, 19);
  printf("%d %d\\n", a==3.0L+0x1p-99L, b==a); return 0;
}
`, { stdout: '1 1\n', interop: true, features: ['varargs', 'va-copy', 'singleton-varargs', 'mixed-arguments'],
  files: [{ path: 'long-double-varargs.h', contents: 'typedef struct { long double value; } Box;\nlong double ld_variadic(int,...);\n' },
    { path: 'provider.c', contents: `#include <stdarg.h>
#include "long-double-varargs.h"
static long double read_values(va_list ap) {
  int a=va_arg(ap,int); long double x=va_arg(ap,long double);
  long long cookie=va_arg(ap,long long); double d=va_arg(ap,double);
  Box y=va_arg(ap,Box); int b=va_arg(ap,int);
  return a==31 && cookie==4294967303LL && d==1.5 && b==19 ? x+y.value : -1.0L;
}
__attribute__((noinline)) long double ld_variadic(int tag,...) {
  va_list ap,copy; va_start(ap,tag); va_copy(copy,ap);
  long double a=read_values(ap), b=read_values(copy);
  va_end(copy); va_end(ap); return tag==7 && a==b ? a : -2.0L;
}
` }], sources: ['provider.c'], signatures: { ld_variadic: { params: ['i32', 'i32', 'i32'], results: [] } } });

add('abi-simd-mixed', `#include <stdio.h>
#include "long-double-simd.h"
static long double callback(long double a, Vector value, long double b) {
  return a+b+(long double)(value[1]+value[2]);
}
static long double (*volatile indirect)(long double,Vector,long double)=ld_vector_mix;
int main(void) {
  int n; if(scanf("%d",&n)!=1 || n!=3) return 1;
  long double a=(long double)n+0x1p-100L, b=2.0L;
  Vector value={n,-7,11,13};
  long double direct=ld_vector_mix(a,value,b), by_pointer=indirect(a,value,b);
  long double by_callback=ld_vector_invoke(a,value,b,callback);
  printf("%d %d %d\\n",direct==8.0L+0x1p-100L,by_pointer==direct,
    by_callback==9.0L+0x1p-100L);
  return 0;
}
`, { stdin: '3\n', stdout: '1 1 1\n', interop: true, simd: true,
  features: ['binary128-abi', 'simd128-abi', 'mixed-arguments', 'direct', 'indirect', 'callback'],
  files: [{ path: 'long-double-simd.h', contents: `typedef int Vector __attribute__((vector_size(16)));
long double ld_vector_mix(long double,Vector,long double);
long double ld_vector_invoke(long double,Vector,long double,long double (*)(long double,Vector,long double));
` }, { path: 'provider.c', contents: `#include "long-double-simd.h"
__attribute__((noinline)) long double ld_vector_mix(long double a,Vector value,long double b) {
  return value[1]==-7 && value[2]==11 && value[3]==13 ? a+b+(long double)value[0] : -1.0L;
}
__attribute__((noinline)) long double ld_vector_invoke(long double a,Vector value,long double b,
  long double (*f)(long double,Vector,long double)) { return f(a,value,b); }
` }], sources: ['provider.c'], signatures: {
    ld_vector_mix: { params: ['i32','i64','i64','v128','i64','i64'], results: [] },
    ld_vector_invoke: { params: ['i32','i64','i64','v128','i64','i64','i32'], results: [] },
  } });

add('libm', `#include <stdio.h>
#include <math.h>
static volatile long double four=4, x=-2.75L, epsilon=0x1p-56L;
int main(void) {
  long double e=epsilon;
  printf("%d %d %d %d %d %d %d\\n", sqrtl(four)==2, floorl(x)==-3,
    ceill(x)==-2, truncl(x)==-2, fmodl(7.5L,four)==3.5L,
    copysignl(four,x)==-4, fmal(1+e,1-e,-1)==-0x1p-112L);
  return 0;
}
`, { stdout: '1 1 1 1 1 1 1\n', features: ['libm', 'fused-binary128'] });

add('printscan', `#include <stdio.h>
int main(void) {
  long double value, precise;
  if (scanf("%Lf", &value)!=1) return 1;
  if (sscanf("1.00000000000000000000000082718061255302767487140869206996285356581211090087890625", "%Lf", &precise)!=1) return 2;
  if (precise != 1.0L+0x1p-80L) return 3;
  printf("%.2Lf %.30Lf %La\\n", value, precise, value); return 0;
}
`, { stdin: '1.25\n', stdout: '1.25 1.000000000000000000000000827181 0x1.4p+0\n', printscan: true, features: ['stdin', 'stdout', 'printf-long-double', 'scanf-long-double'] });

add('strtold', `#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
int main(void) {
  char *end; errno=0;
  long double value=strtold("0x1.00000000000000000001p0tail",&end);
  int exact=value==1.0L+0x1p-80L && *end=='t' && errno==0;
  errno=0; long double large=strtold("1e99999",&end); int overflow=__builtin_isinf(large) && errno==ERANGE && *end==0;
  errno=0; long double small=strtold("1e-99999",&end); int underflow=small==0 && errno==ERANGE && *end==0;
  printf("%d %d %d\\n",exact,overflow,underflow); return 0;
}
`, { stdout: '1 1 1\n', printscan: true, features: ['strtold', 'errno', 'overflow', 'underflow'] });

add('cpp-initialization', `#include <stdio.h>
extern long double global_value;
long double twice(long double);
struct Init { Init() { global_value=1.0L+0x1p-100L; } ~Init() { puts("destroyed"); } } init;
int main() { printf("%d\\n", twice(global_value)==2.0L+0x1p-99L); return 0; }
`, { language: 'cpp', stdout: '1\ndestroyed\n', features: ['cpp', 'static-initialization', 'destruction', 'multi-tu', 'template'],
  files: [{ path: 'provider.cpp', contents: 'long double global_value;\ntemplate<class T> T multiply(T x) { return x*2; }\nlong double twice(long double x) { return multiply(x); }\n' }], sources: ['provider.cpp'] });

add('cpp-library', `#include <limits>
#include <vector>
#include <numeric>
#include <cmath>
#include <iostream>
#include <iomanip>
int main() {
  long double input; if (!(std::cin>>input)) return 1;
  std::vector<long double> values={1.0L,0x1p-100L,input};
  long double sum=std::accumulate(values.begin(),values.end(),0.0L);
  std::cout<<std::numeric_limits<long double>::digits<<" "
    <<(sum-input==1.0L+0x1p-100L)<<" "<<(std::sqrt(input*input)==input)<<" "
    <<std::fixed<<std::setprecision(2)<<input<<"\\n";
  return 0;
}
`, { language: 'cpp', stdin: '1.25\n', stdout: '113 1 1 1.25\n', printscan: true, stdcpp: true, features: ['cpp', 'numeric-limits', 'vector', 'accumulate', 'cmath-long-double', 'iostream-long-double'] });

export const cases = profiles.flatMap(profile => ['0', '2'].map(optimization => ({
  id: `long-double-${profile.id}-o${optimization}`,
  features: profile.features, interop: Boolean(profile.interop),
  printscan: Boolean(profile.printscan), stdcpp: Boolean(profile.stdcpp),
  signatures: profile.signatures || {},
  request: {
    language: profile.language || 'c', standard: profile.language === 'cpp' ? 'gnu++17' : 'gnu11',
    optimization, emit: 'executable', simd: Boolean(profile.simd), defines: ['ONLINE_JUDGE=1'],
    code: '#ifndef ONLINE_JUDGE\n#error ONLINE_JUDGE was not passed as a compiler option\n#endif\n' + profile.code,
    ...(profile.files ? { files: profile.files, sources: profile.sources } : {}),
  }, stdin: profile.stdin || '', stdout: profile.stdout,
})));
