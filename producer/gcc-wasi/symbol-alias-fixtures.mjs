// Strong aliases use original GCC/Clang source and separate caller/provider TUs.
// Values are small exact integers; runtime input and volatile pointers prevent
// compile-time address comparisons from replacing the linking contract.
const profiles = [];
const add = (id, declarations, provider, main, stdout, aliasGroups, extra = {}) =>
  profiles.push({ id, declarations, provider, main, stdout, aliasGroups, ...extra });
const group = (kind, names, extra = {}) => ({ kind, names, ...extra });

add('forward-chains', `int target(int), alias_fn(int), chain_fn(int);`, `
extern int alias_fn(int) __attribute__((alias("target")));
extern int chain_fn(int) __attribute__((alias("alias_fn")));
__attribute__((noinline)) int target(int n) { return n * 7 + 2; }
`, `
int (*volatile functions[3])(int) = { target, alias_fn, chain_fn };
printf("%d %d %d %d %d\\n", functions[0] == functions[1], functions[1] == functions[2],
  functions[0](n), functions[1](n + 1), chain_fn(n + 2));
`, '1 1 23 30 37\n', [group('function', ['target', 'alias_fn', 'chain_fn'])]);

add('data-storage', `
struct Record { int tag; long long value; };
extern int target_data, alias_data, chain_data, zero_data, zero_alias;
extern int values[4], values_alias[4];
extern const int constants[3], constants_alias[3];
extern struct Record record, record_alias;
`, `
int target_data = 11;
extern int alias_data __attribute__((alias("target_data")));
extern int chain_data __attribute__((alias("alias_data")));
int zero_data;
extern int zero_alias __attribute__((alias("zero_data")));
int values[4] = { 2, 4, 6, 8 };
extern int values_alias[4] __attribute__((alias("values")));
const int constants[3] = { 5, 7, 9 };
extern const int constants_alias[3] __attribute__((alias("constants")));
struct Record record = { 4, 100 };
extern struct Record record_alias __attribute__((alias("record")));
`, `
int *volatile pointers[3] = { &target_data, &alias_data, &chain_data };
int *volatile zero_pointers[2] = { &zero_data, &zero_alias };
int *volatile end = &values_alias[3];
const int *volatile fixed = constants_alias;
struct Record *volatile records[2] = { &record, &record_alias };
*pointers[1] += n; *pointers[2] += n; zero_alias = n + 1;
*end += n; records[1]->value += n;
printf("%d %d %d %d %d %d %d %d %lld %d\\n", pointers[0] == pointers[1], pointers[1] == pointers[2],
 *pointers[0], zero_pointers[0] == zero_pointers[1], zero_data, values[3], fixed[n - 1],
 records[0] == records[1], records[0]->value, records[0]->tag);
`, '1 1 17 1 4 11 9 1 103 4\n', [
  group('data', ['target_data', 'alias_data', 'chain_data'], { size: 4 }),
  group('data', ['zero_data', 'zero_alias'], { size: 4 }),
  group('data', ['values', 'values_alias'], { size: 16 }),
  group('data', ['constants', 'constants_alias'], { size: 12 }),
  group('data', ['record', 'record_alias'], { size: 16 })
]);

add('visibility', `
int hidden_fn(int), public_fn(int), local_identity(void);
extern int hidden_data, public_data;
`, `
#define LOCAL_FUNCTION "local.target"
#define LOCAL_DATA "local.storage"
static __attribute__((used,noinline)) int internal(int) __asm__(LOCAL_FUNCTION);
static __attribute__((used,noinline)) int internal(int n) { return n + 100; }
static int local_alias(int) __asm__("local.alias") __attribute__((used,alias(LOCAL_FUNCTION)));
extern int hidden_fn(int) __attribute__((alias(LOCAL_FUNCTION),visibility("hidden")));
extern int public_fn(int) __attribute__((alias(LOCAL_FUNCTION),visibility("default")));
static __attribute__((used)) int private_data __asm__(LOCAL_DATA) = 37;
static int local_data __asm__("local.data.alias") __attribute__((used,alias(LOCAL_DATA)));
extern int hidden_data __attribute__((alias(LOCAL_DATA),visibility("hidden")));
extern int public_data __attribute__((alias(LOCAL_DATA),visibility("default")));
int local_identity(void) {
  int (*volatile f[4])(int) = { internal, local_alias, hidden_fn, public_fn };
  int *volatile p[4] = { &private_data, &local_data, &hidden_data, &public_data };
  return f[0] == f[1] && f[1] == f[2] && f[2] == f[3]
    && p[0] == p[1] && p[1] == p[2] && p[2] == p[3];
}
`, `
int (*volatile f[2])(int) = { hidden_fn, public_fn };
int *volatile p[2] = { &hidden_data, &public_data };
*p[1] += n;
printf("%d %d %d %d %d %d\\n", f[0] == f[1], p[0] == p[1], local_identity(),
  f[0](n), f[1](n + 1), *p[0]);
`, '1 1 1 103 104 40\n', [
  group('function', ['hidden_fn', 'public_fn']),
  group('data', ['hidden_data', 'public_data'], { size: 4 })
], { visibility: { hidden_fn: 'hidden', public_fn: 'default', hidden_data: 'hidden', public_data: 'default' },
  localSymbols: ['local.alias', 'local.data.alias'] });

add('pointer-relocations', `
int target(int), alias_fn(int), chain_fn(int);
extern int target_data[4], alias_data[4];
extern int (*callbacks[3])(int);
extern int *data_pointers[3];
`, `
__attribute__((noinline)) int target(int n) { return n * 3; }
extern int alias_fn(int) __attribute__((alias("target")));
extern int chain_fn(int) __attribute__((alias("alias_fn")));
int target_data[4] = { 5, 10, 15, 20 };
extern int alias_data[4] __attribute__((alias("target_data")));
int (*callbacks[3])(int) = { target, alias_fn, chain_fn };
int *data_pointers[3] = { &target_data[0], &alias_data[1], &alias_data[3] };
`, `
int (*volatile a)(int) = callbacks[0], (*volatile b)(int) = callbacks[1], (*volatile c)(int) = callbacks[2];
int *volatile p = data_pointers[2]; *p += n;
printf("%d %d %d %d %d %d %d\\n", a == b, b == c, a(n) + b(n + 1) + c(n + 2),
 data_pointers[0] == &alias_data[0], data_pointers[1] == &target_data[1],
 data_pointers[2] == &target_data[3], target_data[3]);
`, '1 1 36 1 1 1 23\n', [group('function', ['target', 'alias_fn', 'chain_fn']), group('data', ['target_data', 'alias_data'], { size: 16 })]);

add('function-abi', `
struct Pair { long long integer; double real; };
struct Pair aggregate(struct Pair, int), aggregate_alias(struct Pair, int);
long long wide(long long, int), wide_alias(long long, int);
float floating(float), floating_alias(float);
`, `
__attribute__((noinline)) struct Pair aggregate(struct Pair p, int n) { p.integer += n; p.real += n; return p; }
extern struct Pair aggregate_alias(struct Pair, int) __attribute__((alias("aggregate")));
__attribute__((noinline)) long long wide(long long p, int n) { return p + n; }
extern long long wide_alias(long long, int) __attribute__((alias("wide")));
__attribute__((noinline)) float floating(float p) { return p * 2; }
extern float floating_alias(float) __attribute__((alias("floating")));
`, `
struct Pair (*volatile ap[2])(struct Pair,int) = { aggregate, aggregate_alias };
long long (*volatile wp[2])(long long,int) = { wide, wide_alias };
float (*volatile fp[2])(float) = { floating, floating_alias };
struct Pair input = { 0x100000000LL, 1.5 }, first = ap[0](input,n), second = ap[1](input,n);
printf("%d %d %d %d %d %d %d\\n", ap[0] == ap[1], wp[0] == wp[1], fp[0] == fp[1],
 first.integer == second.integer && first.integer == 0x100000003LL,
 first.real == second.real && first.real == 4.5, wp[1](0x100000000LL,n) == 0x100000003LL, fp[1]((float)n) == 6.0f);
`, '1 1 1 1 1 1 1\n', [group('function', ['aggregate', 'aggregate_alias']), group('function', ['wide', 'wide_alias']), group('function', ['floating', 'floating_alias'])]);

add('asm-symbol-names', `
int target(int) __asm__("custom.target");
int alias_fn(int) __asm__("custom.alias");
extern int target_data __asm__("custom.storage");
extern int alias_data __asm__("custom.storage.alias");
`, `
__attribute__((noinline)) int target(int n) { return n + 11; }
extern int alias_fn(int) __attribute__((alias("custom.target")));
int target_data = 7;
extern int alias_data __attribute__((alias("custom.storage")));
`, `
int (*volatile f[2])(int) = { target, alias_fn };
int *volatile p[2] = { &target_data, &alias_data }; *p[1] += n;
printf("%d %d %d %d\\n", f[0] == f[1], p[0] == p[1], f[1](n), *p[0]);
`, '1 1 14 10\n', [group('function', ['custom.target', 'custom.alias']), group('data', ['custom.storage', 'custom.storage.alias'], { size: 4 })]);

export const cases = [];
for (const profile of profiles) for (const language of ['c', 'cpp']) for (const optimization of ['0', '2']) {
  const header = `#ifndef ALIAS_FIXTURE_H\n#define ALIAS_FIXTURE_H\n#ifdef __cplusplus\nextern "C" {\n#endif\n${profile.declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
  const provider = `#include "aliases.h"\n#ifdef __cplusplus\nextern "C" {\n#endif\n${profile.provider}\n#ifdef __cplusplus\n}\n#endif\n`;
  const main = `#include <stdio.h>\n#include "aliases.h"\nint main(void) { int n; if (scanf("%d", &n) != 1 || n != 3) return 2;\n${profile.main}\nreturn 0; }\n`;
  const providerName = language === 'cpp' ? 'provider.cpp' : 'provider.c';
  cases.push({ id: `symbol-alias-${profile.id}-${language}-o${optimization}`, features: ['strong-alias', 'multi-tu', profile.id],
    interop: true, signatures: {}, aliasGroups: profile.aliasGroups, visibility: profile.visibility || {},
    localSymbols: profile.localSymbols || [],
    request: { language, standard: language === 'cpp' ? 'gnu++17' : 'gnu11', optimization, emit: 'executable', simd: false,
      code: main, files: [{ path: 'aliases.h', contents: header }, { path: providerName, contents: provider }], sources: [providerName] },
    stdin: '3\n', stdout: profile.stdout });
}

for (const optimization of ['0', '2']) {
  const header = `namespace Alias { int value(int); double value(double); extern int store; }\nint alias_int(int); double alias_real(double); extern int alias_store;\n`;
  cases.push({ id: `symbol-alias-cpp-mangling-o${optimization}`, features: ['strong-alias', 'multi-tu', 'cpp-mangling', 'overloads'],
    interop: true, signatures: {}, visibility: {}, localSymbols: [], aliasGroups: [
      group('function', ['_ZN5Alias5valueEi', '_Z9alias_inti']),
      group('function', ['_ZN5Alias5valueEd', '_Z10alias_reald']),
      group('data', ['_ZN5Alias5storeE', 'alias_store'], { size: 4 })],
    request: { language: 'cpp', standard: 'gnu++17', optimization, emit: 'executable', simd: false,
      code: `#include <stdio.h>\n#include "aliases.h"\nint main() { int n; if (scanf("%d",&n)!=1 || n!=3) return 2;
int (*volatile ip[2])(int) = { Alias::value, alias_int };
double (*volatile fp[2])(double) = { Alias::value, alias_real };
int *volatile dp[2] = { &Alias::store, &alias_store }; *dp[1] += n;
printf("%d %d %d %d %d %d\\n", ip[0]==ip[1], fp[0]==fp[1], dp[0]==dp[1], ip[1](n), fp[1](n)==3.5, *dp[0]); return 0; }\n`,
      files: [{ path: 'aliases.h', contents: header }, { path: 'provider.cpp', contents: `#include "aliases.h"
namespace Alias { __attribute__((noinline)) int value(int n) { return n+10; }
__attribute__((noinline)) double value(double n) { return n+0.5; } int store=5; }
int alias_int(int) __attribute__((alias("_ZN5Alias5valueEi")));
double alias_real(double) __attribute__((alias("_ZN5Alias5valueEd")));
extern int alias_store __attribute__((alias("_ZN5Alias5storeE")));
` }], sources: ['provider.cpp'] }, stdin: '3\n', stdout: '1 1 1 13 1 8\n' });
  cases.push({ id: `symbol-alias-gnu-typeinfo-o${optimization}`, features: ['strong-alias', 'gnu-runtime', 'type-info-equality'],
    clang: false, clangReason: 'This control requires GNU libsupc++ and its private __equal alias; the pinned Clang runtime is libc++.',
    stdcpp: true, interop: false, signatures: {}, aliasGroups: [], visibility: {}, localSymbols: [],
    runtimeAliasGroups: [group('function', ['_ZNKSt9type_infoeqERKS_', '_ZNKSt9type_info7__equalERKS_'])],
    request: { language: 'cpp', standard: 'gnu++17', optimization, emit: 'executable', simd: false, code: `
#include <stdio.h>
#include <typeinfo>
struct Named : std::type_info { explicit Named(const char* name) : std::type_info(name) {} };
extern "C" bool eq_entry(const std::type_info*, const std::type_info*) __asm__("_ZNKSt9type_infoeqERKS_");
extern "C" bool alias_entry(const std::type_info*, const std::type_info*) __asm__("_ZNKSt9type_info7__equalERKS_");
int main() { char first[]="fixture", second[]="fixture", third[]="different"; Named a(first), b(second), c(third);
bool (*volatile f[2])(const std::type_info*,const std::type_info*) = { eq_entry, alias_entry };
printf("%d %d %d %d %d\\n", f[0]==f[1], f[0](&a,&b), f[0](&a,&c), f[1](&a,&b), f[1](&a,&c)); return 0; }
` }, stdin: '', stdout: '1 1 0 1 0\n' });
}

export const diagnosticCases = [];
const invalid = [
  ['undefined-function', 'int missing(int); int other(int) __attribute__((alias("missing")));', 'undefined'],
  ['undefined-data', 'extern int missing; extern int other __attribute__((alias("missing")));', 'undefined'],
  ['function-cycle', 'int first(int) __attribute__((alias("second"))); int second(int) __attribute__((alias("first")));', 'cycle|cyclic'],
  ['data-cycle', 'extern int first __attribute__((alias("second"))); extern int second __attribute__((alias("first")));', 'cycle|cyclic'],
  ['function-to-data', 'int data; int other(int) __attribute__((alias("data")));', 'function.*variable|function.*data|different kind|not a function'],
  ['data-to-function', 'int fn(int x){return x;} extern int other __attribute__((alias("fn")));', 'function.*variable|variable.*function|data.*function|different kind|not a variable']
];
for (const [name, code, diagnosticPattern] of invalid) for (const language of ['c','cpp']) for (const optimization of ['0','2']) {
  diagnosticCases.push({ id: `symbol-alias-invalid-${name}-${language}-o${optimization}`, diagnosticPattern,
    ...(['function-to-data','data-to-function'].includes(name) ? { clang: false,
      clangReason: 'Pinned Clang permits aliases between function and data symbols; this negative contract belongs to the GCC target and annotated WAT implementation.' } : {}),
    request: { language, standard: language === 'cpp' ? 'gnu++17' : 'gnu11', optimization, simd: false,
      code: `#ifdef __cplusplus\nextern "C" {\n#endif\n${code}\n#ifdef __cplusplus\n}\n#endif\n` } });
}
