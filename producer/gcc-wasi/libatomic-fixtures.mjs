// Actual GNU libatomic consumers. This file never defines atomic providers.
// Sized helper pointers retain their natural-alignment precondition. Only the
// explicit generic external ABI below tests arbitrary byte alignments; GCC can
// specialize an overloaded __atomic_* builtin before it reaches that ABI.
const widths = [
  [1, 'unsigned char'], [2, 'unsigned short'], [4, 'unsigned int'],
  [8, 'unsigned long long'], [16, 'unsigned __int128'],
];
const variants = source => ['c', 'cpp'].flatMap(language => ['0', '2'].map(optimization => ({
  language, optimization, standard: language === 'c' ? 'gnu11' : 'gnu++17', atomics: true, code: source,
})));
const linkage = declarations => `#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif`;
const literal = (value, width) => width === 16
  ? `(((value_t)0x${(value >> 64n).toString(16)}ULL << 64) | (value_t)0x${(value & ((1n << 64n) - 1n)).toString(16)}ULL)`
  : `((value_t)0x${value.toString(16)}ULL)`;
const row = (value, width) => `${(width === 16 ? value >> 64n : 0n).toString(16).padStart(16, '0')}:${(value & ((1n << 64n) - 1n)).toString(16).padStart(16, '0')}\n`;

function sizedFixture(width, type) {
  const mask = (1n << BigInt(8 * width)) - 1n;
  const first = 0xfedcba98765432100123456789abcdefn & mask;
  const operations = ['fetch_add', 'add_fetch', 'fetch_sub', 'sub_fetch', 'fetch_and', 'and_fetch',
    'fetch_or', 'or_fetch', 'fetch_xor', 'xor_fetch', 'fetch_nand', 'nand_fetch'];
  const declarations = `typedef ${type} value_t;\n${linkage(`
value_t rt_load(const volatile void *, int) __asm__("__atomic_load_${width}");
void rt_store(volatile void *, value_t, int) __asm__("__atomic_store_${width}");
value_t rt_exchange(volatile void *, value_t, int) __asm__("__atomic_exchange_${width}");
bool rt_cas(volatile void *, void *, value_t, int, int) __asm__("__atomic_compare_exchange_${width}");
bool rt_tas(volatile void *, int) __asm__("__atomic_test_and_set_${width}");
${operations.map(name => `value_t rt_${name}(volatile void *, value_t, int) __asm__("__atomic_${name}_${width}");`).join('\n')}
`)}`;
  const actions = [], observations = [];
  let number = 10;
  const observe = (expression, value) => {
    actions.push(`  OBSERVE(${expression}, ${literal(value, width)}, ${number++});`);
    observations.push(row(value, width));
  };
  actions.push(`  rt_store(&value, ${literal((first - 3n) & mask, width)} + seed, __ATOMIC_SEQ_CST);`);
  observe('rt_load(&value, __ATOMIC_ACQUIRE)', first);
  observe('rt_exchange(&value, 5, __ATOMIC_ACQ_REL)', first);
  observe('rt_load(&value, __ATOMIC_RELAXED)', 5n);
  actions.push('  expected = 0;');
  observe('rt_cas(&value, &expected, 7, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)', 0n);
  observe('expected', 5n);
  observe('rt_cas(&value, &expected, 7, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)', 1n);
  observe('expected', 5n);
  actions.push('  expected = 7;');
  // This also exercises GCC's ordinary builtin lowering. In the Wasm profile
  // weak CAS uses the same strong instruction/helper and cannot fail spuriously.
  observe('__atomic_compare_exchange_n(&value, &expected, (value_t)9, 1, __ATOMIC_SEQ_CST, __ATOMIC_ACQUIRE)', 1n);
  const sequence = [
    ['fetch_add', 5n, 9n, 14n], ['add_fetch', 2n, 16n, 16n],
    ['fetch_sub', 3n, 16n, 13n], ['sub_fetch', 1n, 12n, 12n],
    ['fetch_and', 10n, 12n, 8n], ['and_fetch', 3n, 0n, 0n],
    ['fetch_or', 240n, 0n, 240n], ['or_fetch', 3n, 243n, 243n],
    ['fetch_xor', 170n, 243n, 89n], ['xor_fetch', 85n, 12n, 12n],
    ['fetch_nand', 15n, 12n, mask ^ 12n], ['nand_fetch', mask, 12n, 12n],
  ];
  const orders = ['RELAXED', 'CONSUME', 'ACQUIRE', 'RELEASE', 'ACQ_REL', 'SEQ_CST'];
  for (const [index, [operation, operand, result, stored]] of sequence.entries()) {
    observe(`rt_${operation}(&value, ${literal(operand, width)}, __ATOMIC_${orders[index % orders.length]})`, result);
    observe('rt_load(&value, __ATOMIC_SEQ_CST)', stored);
  }
  actions.push(`  rt_store(&value, ${literal(mask - 1n, width)}, __ATOMIC_RELEASE);`);
  observe('rt_add_fetch(&value, 5, __ATOMIC_SEQ_CST)', 3n);
  actions.push('  rt_store(&value, 0, __ATOMIC_RELAXED);');
  observe('rt_tas(&value, __ATOMIC_ACQUIRE)', 0n);
  observe('rt_tas(&value, __ATOMIC_ACQUIRE)', 1n);
  observe('rt_load(&value, __ATOMIC_SEQ_CST)', 1n);
  const source = `#include <stdio.h>
#include <stdbool.h>
${declarations}
static void observe(value_t value) {
  unsigned long long high = ${width === 16 ? '(unsigned long long)(value >> 64)' : '0'};
  printf("%016llx:%016llx\\n", high, (unsigned long long)value);
}
#define OBSERVE(expression, wanted, error) do { value_t actual = (value_t)(expression); if (actual != (wanted)) return (error); observe(actual); } while (0)
int main(void) {
  unsigned seed;
  if (scanf("%u", &seed) != 1 || seed != 3) return 2;
  value_t value __attribute__((aligned(16))) = 0, expected = 0;
${actions.join('\n')}
  return 0;
}
`;
  return variants(source).map(request => ({
    id: `libatomic-sized-${width}-${request.language}-o${request.optimization}`,
    kind: 'sized', width, request, stdin: '3\n', stdout: observations.join(''),
    requiredSymbols: ['load', 'store', 'exchange', 'compare_exchange', 'test_and_set', ...operations]
      .map(operation => `__atomic_${operation}_${width}`),
  }));
}

const genericRanges = [[0, 0], [3, 0], [3, 1], [5, 63], [7, 61], [9, 63],
  [15, 63], [16, 0], [16, 1], [17, 4095], [63, 63], [65, 4095], [4097, 4095]];
const genericDeclarations = linkage(`
void rt_load(unsigned, const volatile void *, void *, int) __asm__("__atomic_load");
void rt_store(unsigned, volatile void *, const void *, int) __asm__("__atomic_store");
void rt_exchange(unsigned, volatile void *, const void *, void *, int) __asm__("__atomic_exchange");
bool rt_cas(unsigned, volatile void *, void *, const void *, int, int) __asm__("__atomic_compare_exchange");
`);
const genericSource = `#include <stdio.h>
#include <stdbool.h>
${genericDeclarations}
static unsigned char data[12352] __attribute__((aligned(64)));
static unsigned char value[4100], observed[4100], desired[4100];
static const unsigned ranges[][2] = {${genericRanges.map(range => `{${range}}`).join(',')}};
static int same(const unsigned char *a, const unsigned char *b, unsigned n) {
  for (unsigned i = 0; i < n; ++i) if (a[i] != b[i]) return 0;
  return 1;
}
int main(void) {
  unsigned seed;
  if (scanf("%u", &seed) != 1 || seed != 7) return 2;
  for (unsigned k = 0; k < sizeof(ranges)/sizeof(ranges[0]); ++k) {
    unsigned n = ranges[k][0], offset = ranges[k][1];
    unsigned char *p = data + offset;
    for (unsigned i = 0; i < sizeof(data); ++i) data[i] = 0xa5;
    for (unsigned i = 0; i < n; ++i) {
      value[i] = (unsigned char)(i * 37 + seed);
      desired[i] = (unsigned char)(i * 19 + 11);
      observed[i] = 0;
    }
    rt_store(n, p, value, __ATOMIC_RELEASE);
    rt_load(n, p, observed, __ATOMIC_ACQUIRE);
    if (!same(observed, value, n)) return 10;
    rt_exchange(n, p, desired, observed, __ATOMIC_ACQ_REL);
    if (!same(observed, value, n)) return 11;
    rt_load(n, p, observed, __ATOMIC_SEQ_CST);
    if (!same(observed, desired, n)) return 12;
    if (n && rt_cas(n, p, value, observed, __ATOMIC_SEQ_CST, __ATOMIC_ACQUIRE)) return 13;
    if (n && !same(value, desired, n)) return 14;
    if (!rt_cas(n, p, observed, value, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) return 15;
    for (unsigned i = 0; i < n; ++i) value[i] = (unsigned char)(i * 23 + 5);
    // Upstream explicitly supports vptr == rptr for generic exchange.
    rt_exchange(n, p, value, value, __ATOMIC_SEQ_CST);
    if (!same(value, desired, n)) return 16;
    rt_store(n, p, desired, __ATOMIC_SEQ_CST);
    rt_load(n, p, observed, __ATOMIC_SEQ_CST);
    if (!same(observed, desired, n)) return 17;
    unsigned checksum = 0;
    for (unsigned i = 0; i < sizeof(data); ++i)
      if (i < offset || i >= offset + n) { if (data[i] != 0xa5) return 18; }
    for (unsigned i = 0; i < n; ++i) checksum += observed[i];
    printf("generic %u %u %u\\n", n, offset, checksum);
  }
  return 0;
}
`;
const genericStdout = genericRanges.map(([size, offset]) => {
  let checksum = 0;
  for (let i = 0; i < size; i++) checksum += (i * 19 + 11) & 255;
  return `generic ${size} ${offset} ${checksum}\n`;
}).join('');

const lockFreeSource = `#include <stdio.h>
#include <stdbool.h>
${linkage('bool rt_lock_free(unsigned, const volatile void *) __asm__("__atomic_is_lock_free");')}
static unsigned char data[128] __attribute__((aligned(64)));
int main(void) {
  unsigned seed;
  if (scanf("%u", &seed) != 1 || seed != 1) return 2;
  const unsigned sizes[] = {0, 1, 2, 3, 4, 5, 8, 16, 17};
  for (unsigned k = 0; k < sizeof(sizes)/sizeof(sizes[0]); ++k) {
    unsigned n = sizes[k];
    bool expected = n == 0 || n == 1 || n == 2 || n == 4 || n == 8;
    bool aligned = rt_lock_free(n, data), unaligned = rt_lock_free(n, data + seed);
    if (aligned != expected || unaligned != (n <= 1)) return 10 + k;
    printf("lock-free %u %u %u\\n", n, (unsigned)aligned, (unsigned)unaligned);
  }
  if (__atomic_always_lock_free(16, 0)) return 30;
  if (!__atomic_always_lock_free(4, 0)) return 31;
  return 0;
}
`;
const lockFreeStdout = [0, 1, 2, 3, 4, 5, 8, 16, 17].map(size =>
  `lock-free ${size} ${[0, 1, 2, 4, 8].includes(size) ? 1 : 0} ${size <= 1 ? 1 : 0}\n`).join('');

export const cases = [
  ...widths.flatMap(([width, type]) => sizedFixture(width, type)),
  ...variants(genericSource).map(request => ({
    id: `libatomic-generic-${request.language}-o${request.optimization}`, kind: 'generic', request,
    stdin: '7\n', stdout: genericStdout,
    requiredSymbols: ['__atomic_load', '__atomic_store', '__atomic_exchange', '__atomic_compare_exchange'],
  })),
  ...variants(lockFreeSource).map(request => ({
    id: `libatomic-lock-free-${request.language}-o${request.optimization}`, kind: 'lock-free', request,
    stdin: '1\n', stdout: lockFreeStdout, requiredSymbols: ['__atomic_is_lock_free'],
  })),
];
