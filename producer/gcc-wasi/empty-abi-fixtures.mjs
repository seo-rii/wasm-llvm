// Shared real-source regressions for native GCC/Clang object interoperation and
// the actual wasm-idle Chromium compiler. Empty object padding is never read.
// Nontrivial copy/destruction and nonempty controls must remain indirect.
const profiles = [
  { id: 'cpp-plain', declaration: 'struct Type {};', size: 1, align: 1 },
  { id: 'cpp-aligned16', declaration: 'struct alignas(16) Type {};', size: 16, align: 16 },
  { id: 'cpp-nested', declaration: 'struct Leaf {}; struct Type { Leaf first; Leaf rest[2]; };', size: 3, align: 1, indirect: true },
  { id: 'cpp-bases', declaration: 'struct First {}; struct Second {}; struct Type : First, Second {};', size: 1, align: 1 },
  { id: 'cpp-empty-array', declaration: 'struct alignas(16) Leaf {}; struct Type { Leaf values[2]; };', size: 32, align: 16, indirect: true },
  { id: 'cpp-empty-union', declaration: 'struct First {}; struct Second {}; union Type { First first; Second second; };', size: 1, align: 1, indirect: true },
  { id: 'cpp-zero-width', declaration: 'struct alignas(16) Type { int : 0; };', size: 16, align: 16 },
  { id: 'cpp-unnamed-bitfield', declaration: 'struct alignas(16) Type { unsigned int : 3; };', size: 16, align: 16 },
  { id: 'cpp-no-unique-address', declaration: 'struct Leaf {}; struct Type { [[no_unique_address]] Leaf value; };', size: 1, align: 1, standard: 'gnu++20' },
  { id: 'cpp-default-constructor', declaration: 'struct alignas(16) Type { Type() { ++constructions; } };', size: 16, align: 16, constructed: true },
  { id: 'cpp-nontrivial-control', declaration: `struct alignas(16) Type {
    Type() { ++live_objects; ++constructions; }
    Type(const Type &) { ++live_objects; ++copies; }
    ~Type() { --live_objects; }
  };`, size: 16, align: 16, indirect: true, nontrivial: true },
  { id: 'cpp-nonempty-control', declaration: 'struct alignas(16) Type { int value; };', size: 16, align: 16, indirect: true, payload: 7 },
  { id: 'c-zero-size', declaration: 'typedef struct {} Type;', size: 0, align: 1, c: true },
  { id: 'c-zero-size-aligned16', declaration: 'typedef struct __attribute__((aligned(16))) {} Type;', size: 0, align: 16, c: true },
];

function fixture(profile, optimization) {
  const payload = profile.payload || 0;
  const initialization = payload ? '{7}' : '{}';
  const read = value => payload ? `${value}.value` : '0';
  const externBegin = '#ifdef __cplusplus\nextern "C" {\n#endif\n';
  const externEnd = '#ifdef __cplusplus\n}\n#endif\n';
  const header = `#ifndef EMPTY_ABI_H
#define EMPTY_ABI_H
#if !defined(ONLINE_JUDGE) || ONLINE_JUDGE != 23
#error ONLINE_JUDGE=23 must be passed as a real compiler option
#endif
${externBegin}extern int live_objects, copies, constructions;
${externEnd}${profile.declaration}
#ifdef __cplusplus
static_assert(sizeof(Type) == ${profile.size}, "object size");
static_assert(alignof(Type) == ${profile.align}, "object alignment");
#else
_Static_assert(sizeof(Type) == ${profile.size}, "object size");
_Static_assert(_Alignof(Type) == ${profile.align}, "object alignment");
#endif
${externBegin}typedef Type (*Maker)(void);
typedef int (*Taker)(Type, int);
Type make_empty(void);
int take_empty(Type, int);
Type call_make(Maker);
int call_take(Taker, Type, int);
int direct(int);
int invoke_callbacks(Maker, Taker, Taker, int);
${externEnd}#endif
`;
  const provider = `#include "empty-abi.h"
int live_objects, copies, constructions;
__attribute__((noinline)) Type make_empty(void) { Type value = ${initialization}; return value; }
__attribute__((noinline)) int take_empty(Type value, int n) { return n + 1 + ${read('value')}; }
__attribute__((noinline)) Type call_make(Maker maker) { return maker(); }
__attribute__((noinline)) int call_take(Taker taker, Type value, int n) { return taker(value, n); }
__attribute__((noinline)) int direct(int n) { return take_empty(make_empty(), n); }
__attribute__((noinline)) int invoke_callbacks(Maker maker, Taker taker, Taker callback, int n) {
  Type value = maker(); return taker(value, n) + callback(value, n);
}
`;
  const main = `#include <stdio.h>
#include "empty-abi.h"
__attribute__((noinline)) static Type local_make(void) { Type value = ${initialization}; return value; }
__attribute__((noinline)) static int local_take(Type value, int n) { return n + 5 + ${read('value')}; }
static Maker volatile maker = make_empty;
static Taker volatile taker = take_empty;
static int exercise(int n) {
  Type a = make_empty();
  if (${read('a')} != ${payload} || take_empty(a,n) != n+1+${payload}) return 10;
  if (taker(a,n+1) != n+2+${payload}) return 11;
  Type b = maker();
  if (${read('b')} != ${payload}) return 12;
  Type c = call_make(maker);
  if (${read('c')} != ${payload} || call_take(taker,c,n+2) != n+3+${payload}) return 13;
  if (direct(n+3) != n+4+${payload}) return 14;
  if (invoke_callbacks(local_make,taker,local_take,n+4) != 2*(n+4)+6+2*${payload}) return 15;
  return 0;
}
int main(void) {
  int n;
  if (scanf("%d", &n) != 1 || n != 17) return 1;
  int status = exercise(n);
  if (status) return status;
  if (live_objects != 0) return 20;
  ${profile.nontrivial ? 'if (copies == 0 || constructions == 0) return 21;' : ''}
  ${profile.constructed ? 'if (constructions < 3) return 22;' : ''}
  printf("${profile.id} %u %u %d\\n", (unsigned)sizeof(Type), (unsigned)__alignof__(Type), n+1+${payload});
  return 0;
}
`;
  const signature = (params, results = []) => ({ params, results });
  return {
    id: `empty-abi-${profile.id}-o${optimization}`,
    features: ['basic-c-abi', 'empty-record', 'direct-call', 'indirect-call', 'cross-compiler-callback',
      ...(profile.c ? ['c-zero-size'] : ['cpp']), ...(profile.indirect ? ['indirect-control'] : ['ignored-argument-result'])],
    interop: true,
    expectedClassification: profile.indirect ? 'indirect' : 'ignored',
    signatures: {
      make_empty: signature(profile.indirect ? ['i32'] : []),
      take_empty: signature(profile.indirect ? ['i32', 'i32'] : ['i32'], ['i32']),
      call_make: signature(profile.indirect ? ['i32', 'i32'] : ['i32']),
      call_take: signature(profile.indirect ? ['i32', 'i32', 'i32'] : ['i32', 'i32'], ['i32']),
      direct: signature(['i32'], ['i32']),
      invoke_callbacks: signature(['i32', 'i32', 'i32', 'i32'], ['i32']),
    },
    request: {
      language: profile.c ? 'c' : 'cpp', standard: profile.standard || (profile.c ? 'gnu11' : 'gnu++17'),
      optimization, emit: 'executable', defines: ['ONLINE_JUDGE=23'],
      code: main,
      files: [{ path: 'empty-abi.h', contents: header }, { path: profile.c ? 'provider.c' : 'provider.cpp', contents: provider }],
      sources: [profile.c ? 'provider.c' : 'provider.cpp'],
    },
    stdin: '17\n', stdout: `${profile.id} ${profile.size} ${profile.align} ${18 + payload}\n`,
  };
}

export const cases = profiles.flatMap(profile => ['0', '2'].map(optimization => fixture(profile, optimization)));
