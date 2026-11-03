// GNU __float128 uses actual GCC/Clang frontends and binary128 operations.
// Exact dyadic values, integer observations and known IEEE storage words form
// the oracle; no host JavaScript floating-point calculation approximates them.
const profiles = [];
const add = (id, code, extra = {}) => profiles.push({ id, code, ...extra });

add('layout-literals', `#include <stdio.h>
#include <stddef.h>
struct Layout { char before; __float128 value; char after; };
static volatile __float128 one = 1.0Q, epsilon = 0x1p-100q;
#if !defined(__SIZEOF_FLOAT128__) && !defined(__FLOAT128__)
#error missing GNU float128 feature macro
#endif
#ifdef __SIZEOF_FLOAT128__
typedef char check_size_macro[__SIZEOF_FLOAT128__ == sizeof(__float128) ? 1 : -1];
#endif
#ifdef __cplusplus
static_assert(__is_same(decltype(1.0Q), __float128), "Q literal type");
static_assert(__is_same(decltype(0x1p-100q), __float128), "q literal type");
static_assert(!__is_same(__float128, long double), "distinct long double");
#else
_Static_assert(__builtin_types_compatible_p(__typeof__(1.0Q), __float128), "Q literal type");
_Static_assert(__builtin_types_compatible_p(__typeof__(0x1p-100q), __float128), "q literal type");
_Static_assert(!__builtin_types_compatible_p(__float128, long double), "distinct long double");
#endif
int main(void) {
  __float128 sum = one + epsilon;
  printf("%u %u %u %u %d %d\\n", (unsigned)sizeof(__float128),
    (unsigned)__alignof__(__float128), (unsigned)offsetof(struct Layout, value),
    (unsigned)sizeof(struct Layout), sum > one, sum - one == epsilon);
  return 0;
}
`, { stdout: '16 16 16 48 1 1\n', features: ['type-identity', 'layout', 'q-literal', 'precision-beyond-binary64'] });

add('arithmetic', `#include <stdio.h>
static volatile __float128 tiny = 0x1p-100Q;
__attribute__((noinline)) static __float128 compute(__float128 a, __float128 b) {
  __float128 product = a * b;
  return product / b - a;
}
int main(void) {
  int input; if (scanf("%d", &input) != 1 || input != 3) return 1;
  volatile __float128 a = (__float128)input + tiny, b = 4.0q;
  __float128 sum = a + tiny, difference = sum - (__float128)input;
  printf("%d %d %d %d %d %d\\n", sum > a, difference == 2*tiny,
    compute(a,b) == 0, -a < 0, -(-a) == a, a != b && a <= b && b >= a);
  return 0;
}
`, { stdin: '3\n', stdout: '1 1 1 1 1 1\n', features: ['add', 'subtract', 'multiply', 'divide', 'negation', 'comparison'] });

add('conversions', `#include <stdio.h>
#include <limits.h>
static volatile long long si = (-9223372036854775807LL-1);
static volatile unsigned long long ui = 18446744073709551615ULL;
static volatile __int128 wide = ((__int128)1 << 100) + 57;
static volatile double d = 0x1.0000000000001p+0;
static volatile float f = 1.5f;
int main(void) {
  volatile __float128 a = si, b = ui, c = wide, x = d, y = f;
  volatile __float128 negative = -2147483648.75Q, positive = 4294967295.75q;
  volatile __float128 fraction = -3.75Q;
  printf("%d %d %d %d %d %d %d %d %d %d\\n", (long long)a == (-9223372036854775807LL-1),
    (unsigned long long)b == 18446744073709551615ULL, b + 1 == 0x1p64Q,
    (__int128)c == wide && c - 0x1p100Q == 57,
    (double)x == d && x > 1, (float)y == f,
    (int)negative == INT_MIN, (unsigned int)positive == UINT_MAX,
    (int)fraction == -3, (__float128)(long double)c == c);
  return 0;
}
`, { stdout: '1 1 1 1 1 1 1 1 1 1\n', features: ['integer-conversions', 'int128-conversion', 'float-conversion', 'double-conversion', 'long-double-conversion'] });

add('special-values', `#include <stdio.h>
#include <string.h>
static volatile unsigned long long nan_words[2] = {0x456789abcdef0123ULL,0x7fff800000000123ULL};
static volatile unsigned long long inf_words[2] = {0,0x7fff000000000000ULL};
static volatile __float128 negative_zero = -0.0Q, tiny = 0x1p-16494Q;
int main(void) {
  unsigned long long n[2] = {nan_words[0],nan_words[1]}, i[2] = {inf_words[0],inf_words[1]}, z[2];
  __float128 nan, inf, zero = negative_zero;
  memcpy(&nan,n,16); memcpy(&inf,i,16); memcpy(z,&zero,16);
  volatile __float128 held = nan;
  __float128 negated = -held; unsigned long long payload[2]; memcpy(payload,&negated,16);
  printf("%d %d %d %d %d %d %d %d\\n", held != held, !(held < 1), !(held >= 1),
    inf > 0x1p16383Q, zero == 0 && z[0] == 0 && z[1] == 0x8000000000000000ULL,
    tiny > 0 && tiny/2 == 0, payload[0] == n[0], payload[1] == (n[1]^0x8000000000000000ULL));
  return 0;
}
`, { stdout: '1 1 1 1 1 1 1 1\n', features: ['nan-payload', 'infinity', 'signed-zero', 'subnormal', 'bit-preserving-negation'] });

add('storage', `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct __attribute__((packed)) Packed { char tag; __float128 value; };
static __float128 globals[3] = {1.0Q,-2.5q,0x1p-100Q};
static volatile struct Packed packed = {7,1.0Q};
int main(void) {
  __float128 local[3], *heap = (__float128 *)malloc(sizeof(globals));
  if (!heap) return 1;
  memcpy(local,globals,sizeof(local)); memcpy(heap,local,sizeof(local));
  packed.value = heap[0] + heap[2];
  __float128 unaligned = packed.value;
  unsigned long long words[2]; memcpy(words,&heap[0],16);
  printf("%d %d %d %d %d\\n", sizeof(globals) == 48,
    words[0] == 0 && words[1] == 0x3fff000000000000ULL,
    heap[1] == -2.5Q, unaligned - 1 == heap[2], packed.tag == 7);
  free(heap); return 0;
}
`, { stdout: '1 1 1 1 1\n', features: ['globals', 'packed-storage', 'stack', 'heap', 'memcpy'] });

add('long-double-library-bridge', `#include <stdio.h>
#include <stdlib.h>
#include <math.h>
static volatile __float128 value = 2.25Q;
int main(void) {
  __float128 x = value;
  __float128 root = (__float128)sqrtl((long double)x);
  __float128 parsed = (__float128)strtold("1.0000000000000000000000000000000001925929944387235853055977942584927318538101648215388195239938795566558837890625",0);
  printf("%d %d %d\\n", root == 1.5Q,
    (__float128)fmal((long double)x,2.0L,-0.5L) == 4.0Q,
    parsed == 1.0Q + 0x1p-112Q);
  return 0;
}
`, { stdout: '1 1 1\n', printscan: true, features: ['explicit-long-double-conversion', 'libm-sqrt', 'libm-fma', 'strtold'] });

export const cases = profiles.flatMap(profile => ['c', 'cpp'].flatMap(language => ['0', '2'].map(optimization => ({
  id: `gnu-float128-${profile.id}-${language}-o${optimization}`,
  features: ['gnu-float128', ...profile.features],
  signatures: {},
  printscan: Boolean(profile.printscan),
  request: { language, standard: language === 'cpp' ? 'gnu++17' : 'gnu11', optimization,
    emit: 'executable', simd: false, defines: ['ONLINE_JUDGE=1'], code: profile.code },
  stdin: profile.stdin || '', stdout: profile.stdout,
}))));

for (const language of ['c', 'cpp']) for (const optimization of ['0', '2']) {
  const extension = language === 'cpp' ? 'cpp' : 'c';
  const header = `#ifndef GNU_QUAD_ABI_H
#define GNU_QUAD_ABI_H
#ifdef __cplusplus
extern "C" {
#endif
__float128 gq_add(__float128, __float128);
__float128 gq_callback(__float128, __float128 (*)(__float128));
int gq_compare(__float128, __float128);
#ifdef __cplusplus
}
#endif
#endif
`;
  cases.push({
    id: `gnu-float128-direct-callback-${language}-o${optimization}`,
    features: ['gnu-float128', 'multi-tu', 'direct-call', 'indirect-call', 'callback', 'binary128-abi'],
    interop: true, objectSignatures: true,
    signatures: {
      gq_add: { params: ['i32','i64','i64','i64','i64'], results: [] },
      gq_callback: { params: ['i32','i64','i64','i32'], results: [] },
      gq_compare: { params: ['i64','i64','i64','i64'], results: ['i32'] },
    },
    request: { language, standard: language === 'cpp' ? 'gnu++17' : 'gnu11', optimization,
      emit: 'executable', simd: false, defines: ['ONLINE_JUDGE=1'],
      code: `#include <stdio.h>
#include "gnu-quad.h"
static __float128 (*volatile add_pointer)(__float128,__float128) = gq_add;
static __float128 (*volatile call_pointer)(__float128,__float128 (*)(__float128)) = gq_callback;
static int calls;
static __float128 callback(__float128 x) { ++calls; return x + 0x1p-100Q; }
int main(void) {
  int input; if (scanf("%d",&input) != 1 || input != 42) return 1;
  __float128 x = (__float128)input + 0x1p-100Q;
  __float128 a = gq_add(x,0x1p-100Q), b = add_pointer(x,0x1p-100Q);
  __float128 c = gq_callback(x,callback), d = call_pointer(x,callback);
  printf("%d %d %d %d %d\\n", gq_compare(a,b), a - input == 0x1p-99Q,
    gq_compare(c,d), c == a, calls == 2);
  return 0;
}
`, files: [{ path: 'gnu-quad.h', contents: header }, { path: `provider.${extension}`, contents: `#include "gnu-quad.h"
__attribute__((noinline)) __float128 gq_add(__float128 a, __float128 b) { return a + b; }
__attribute__((noinline)) __float128 gq_callback(__float128 a, __float128 (*fn)(__float128)) { return fn(a); }
__attribute__((noinline)) int gq_compare(__float128 a, __float128 b) { return a == b; }
` }], sources: [`provider.${extension}`] },
    stdin: '42\n', stdout: '1 1 1 1 1\n',
  });
}

for (const optimization of ['0', '2']) {
  cases.push({
    id: `gnu-float128-gnu-cpp-library-o${optimization}`,
    features: ['gnu-float128', 'gnu-libstdc++', 'type-traits', 'numeric-limits', 'absolute-value'],
    clang: false, clangReason: 'This case qualifies the actual GNU libstdc++ extensions built with the current GCC; Clang references use a separate libc++.',
    stdcpp: true, signatures: {},
    request: { language: 'cpp', standard: 'gnu++17', optimization, emit: 'executable', simd: false,
      code: `#include <stdio.h>
#include <type_traits>
#include <limits>
#include <cmath>
static_assert(__SIZEOF_FLOAT128__ == 16, "GNU type size macro");
static_assert(std::is_floating_point<__float128>::value, "floating trait");
static_assert(std::is_arithmetic<__float128>::value, "arithmetic trait");
static_assert(!std::is_same<__float128,long double>::value, "distinct long double");
static_assert(!std::is_same<__float128,_Float128>::value, "distinct _Float128");
static_assert(std::numeric_limits<__float128>::is_specialized, "GNU limits");
static_assert(std::numeric_limits<__float128>::digits == 113, "binary128 precision");
static_assert(std::is_same<decltype(std::abs(1.0Q)),__float128>::value, "abs result type");
static volatile __float128 value = -1.0Q - 0x1p-100Q;
int main(void) {
  using Limits = std::numeric_limits<__float128>;
  __float128 absolute = std::abs(value), nan = Limits::quiet_NaN();
  printf("%d %d %d %d %d %d\\n", absolute - 1 == 0x1p-100Q,
    Limits::epsilon() == 0x1p-112Q, Limits::min() == 0x1p-16382Q,
    Limits::denorm_min() == 0x1p-16494Q,
    Limits::infinity() > Limits::max(), nan != nan);
  return 0;
}
` }, stdin: '', stdout: '1 1 1 1 1 1\n',
  });
  cases.push({
    id: `gnu-float128-c-type-relations-o${optimization}`,
    features: ['gnu-float128', 'c-type-compatibility', 'float128-conversion'],
    clang: false, clangReason: 'Pinned Clang supports GNU __float128 but does not expose _Float128/F128.',
    signatures: {},
    request: { language: 'c', standard: 'gnu11', optimization, emit: 'executable', simd: false,
      code: `#include <stdio.h>
_Static_assert(__builtin_types_compatible_p(__float128,_Float128), "C aliases");
_Static_assert(!__builtin_types_compatible_p(__float128,long double), "distinct long double");
static volatile _Float128 f = 1.0F128 + 0x1p-100F128;
int main(void) {
  __float128 q = f; long double l = q; _Float128 back = l;
  printf("%d %d %d\\n", q - 1.0Q == 0x1p-100Q, back == f, sizeof(q) == sizeof(l));
  return 0;
}
` }, stdin: '', stdout: '1 1 1\n',
  });
  const header = `int gf_overload(__float128);
int gf_overload(long double);
`;
  cases.push({
    id: `gnu-float128-cpp-overloads-o${optimization}`,
    features: ['gnu-float128', 'cpp-distinct-type', 'cpp-mangling', 'multi-tu', 'q-literal-type'],
    interop: true, objectSignatures: true,
    signatures: {
      _Z11gf_overloadg: { params: ['i64','i64'], results: ['i32'] },
      _Z11gf_overloade: { params: ['i64','i64'], results: ['i32'] },
    },
    request: { language: 'cpp', standard: 'gnu++17', optimization, emit: 'executable', simd: false,
      code: `#include <stdio.h>
#include "overloads.h"
static int (*volatile quad_pointer)(__float128) = gf_overload;
static int (*volatile long_pointer)(long double) = gf_overload;
int main(void) {
  printf("%d %d %d %d\\n", gf_overload(1.0Q), gf_overload(1.0L),
    quad_pointer(2.0q), long_pointer(2.0L));
  return 0;
}
`, files: [{path: 'overloads.h', contents: header}, {path: 'provider.cpp', contents: `#include "overloads.h"
int gf_overload(__float128 x) { return 10 + (int)x; }
int gf_overload(long double x) { return 20 + (int)x; }
`}], sources: ['provider.cpp'] }, stdin: '', stdout: '11 21 12 22\n',
  });
  cases.push({
    id: `gnu-float128-cpp-three-types-o${optimization}`,
    features: ['gnu-float128', 'cpp-distinct-type', 'float128-conversion', 'cpp-mangling'],
    clang: false, clangReason: 'Pinned Clang supports GNU __float128 but does not expose _Float128/F128.',
    signatures: {
      _Z11gf_overloadg: { params: ['i64','i64'], results: ['i32'] },
      _Z11gf_overloade: { params: ['i64','i64'], results: ['i32'] },
      _Z11gf_overloadDF128_: { params: ['i64','i64'], results: ['i32'] },
    },
    request: { language: 'cpp', standard: 'gnu++17', optimization, emit: 'executable', simd: false,
      code: `#include <stdio.h>
static_assert(!__is_same(__float128,_Float128), "C++ distinct GNU type");
static_assert(!__is_same(__float128,long double), "C++ distinct long double");
static_assert(!__is_same(_Float128,long double), "C++ distinct _Float128");
static_assert(__is_same(decltype(1.0Q),__float128), "Q literal");
static_assert(__is_same(decltype(1.0F128),_Float128), "F128 literal");
static_assert(__is_same(decltype(1.0Q + 1.0L),long double), "legacy common type");
static_assert(__is_same(decltype(1.0Q + 1.0F128),_Float128), "extended common type");
int gf_rank(__float128);
int gf_rank(long double);
template<class T, class = void> struct unambiguous { static constexpr bool value = false; };
template<class T> struct unambiguous<T, decltype(void(gf_rank(T{})))> { static constexpr bool value = true; };
static_assert(unambiguous<__float128>::value && unambiguous<long double>::value, "exact legacy matches");
static_assert(!unambiguous<_Float128>::value, "equal-rank conversions remain ambiguous");
__attribute__((noinline)) int gf_overload(__float128 x) { return 10 + (int)x; }
__attribute__((noinline)) int gf_overload(long double x) { return 20 + (int)x; }
__attribute__((noinline)) int gf_overload(_Float128 x) { return 30 + (int)x; }
static volatile __float128 value = 1.0Q + 0x1p-100Q;
int main(void) {
  __float128 q = value; _Float128 f = q; long double l = f;
  printf("%d %d %d %d\\n", gf_overload(1.0Q), gf_overload(1.0L),
    gf_overload(1.0F128), (__float128)l == q && f - 1 == 0x1p-100F128);
  return 0;
}
` }, stdin: '', stdout: '11 21 31 1\n',
  });
}
