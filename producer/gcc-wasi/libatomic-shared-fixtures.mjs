// Freestanding consumers of the production GNU archive, never helper providers.
// A cohort shares one module, one fixed memory and its single LLD data/BSS
// initialization. Every worker receives its own stack before entering run().
const linkage = text => `#ifdef __cplusplus\nextern "C" {\n#endif\n${text}\n#ifdef __cplusplus\n}\n#endif`;
const common = `typedef unsigned __int128 u128;
typedef unsigned char byte;
${linkage(`
u128 rt_load16(const volatile void *, int) __asm__("__atomic_load_16");
u128 rt_fetch_add16(volatile void *, u128, int) __asm__("__atomic_fetch_add_16");
void rt_load(unsigned, const volatile void *, void *, int) __asm__("__atomic_load");
bool rt_cas(unsigned, volatile void *, void *, const void *, int, int) __asm__("__atomic_compare_exchange");
void rt_lock(void *, unsigned) __asm__("libat_lock_n");
void rt_unlock(void *, unsigned) __asm__("libat_unlock_n");
`)}
static unsigned ready, done, initialized;
static unsigned results[8];
static void barrier(unsigned *value, unsigned workers) {
  __atomic_fetch_add(value, 1, __ATOMIC_SEQ_CST);
  while (__atomic_load_n(value, __ATOMIC_SEQ_CST) != workers) {}
}
`;
const prefix = `#ifndef __cplusplus\n#include <stdbool.h>\n#endif\n${common}`;
const functionPrefix = '#ifdef __cplusplus\nextern "C"\n#endif\n__attribute__((used,visibility("default")))\nint run(unsigned id, unsigned iterations, unsigned workers)';

const mixed16 = `${prefix}
static u128 counter __attribute__((aligned(16)));
${functionPrefix} {
  if (workers != 2 || id >= workers || iterations != 1000) return -1;
  const u128 increment = ((u128)1 << 64) | 1;
  barrier(&ready, workers);
  for (unsigned i = 0; i < iterations; ++i) {
    if (id == 0) {
      u128 old = rt_fetch_add16(&counter, increment, __ATOMIC_SEQ_CST);
      if ((unsigned long long)old != (unsigned long long)(old >> 64)) return -2;
    } else {
      u128 old, next;
      rt_load(16, &counter, &old, __ATOMIC_ACQUIRE);
      do {
        if ((unsigned long long)old != (unsigned long long)(old >> 64)) return -3;
        next = old + increment;
      } while (!rt_cas(16, &counter, &old, &next, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE));
    }
  }
  barrier(&done, workers);
  u128 final = rt_load16(&counter, __ATOMIC_SEQ_CST);
  if (final != increment * (iterations * workers)) return -4;
  results[id] = (unsigned)final;
  return (int)(unsigned)results;
}
`;

function genericRange(size, iterations) {
  return `${prefix}
// 4095 crosses both watch region 64 and the lock hash period 4096.
static byte storage[8192] __attribute__((aligned(4096)));
static unsigned read_count(const byte *value) {
  return (unsigned)value[0] | ((unsigned)value[1] << 8) |
    ((unsigned)value[2] << 16) | ((unsigned)value[3] << 24);
}
static void set_value(byte *value, unsigned count) {
  for (unsigned i = 0; i < 4; ++i) value[i] = (byte)(count >> (i * 8));
  for (unsigned i = 4; i < ${size}; ++i) value[i] = (byte)((count ^ (i * 37)) + i * 11);
}
static int valid(const byte *value) {
  unsigned count = read_count(value);
  for (unsigned i = 4; i < ${size}; ++i)
    if (value[i] != (byte)((count ^ (i * 37)) + i * 11)) return 0;
  return 1;
}
${functionPrefix} {
  if (workers != 2 || id >= workers || iterations != ${iterations}) return -1;
  byte *object = storage + 4095;
  if (id == 0) {
    for (unsigned i = 0; i < sizeof(storage); ++i) storage[i] = 0xa5;
    set_value(object, 0);
    __atomic_store_n(&initialized, 1, __ATOMIC_RELEASE);
  }
  while (!__atomic_load_n(&initialized, __ATOMIC_ACQUIRE)) {}
  barrier(&ready, workers);
  for (unsigned i = 0; i < iterations; ++i) {
    byte observed[${size}], desired[${size}];
    rt_load(${size}, object, observed, __ATOMIC_ACQUIRE);
    do {
      if (!valid(observed)) return -2;
      set_value(desired, read_count(observed) + 1);
    } while (!rt_cas(${size}, object, observed, desired, __ATOMIC_SEQ_CST, __ATOMIC_ACQUIRE));
  }
  barrier(&done, workers);
  byte observed[${size}];
  rt_load(${size}, object, observed, __ATOMIC_SEQ_CST);
  if (!valid(observed) || read_count(observed) != iterations * workers) return -3;
  for (unsigned i = 0; i < sizeof(storage); ++i)
    if ((i < 4095 || i >= 4095 + ${size}) && storage[i] != 0xa5) return -4;
  results[id] = read_count(observed);
  return (int)(unsigned)results;
}
`;
}

const rangeLocks = `${prefix}
static byte ranges[8192] __attribute__((aligned(4096)));
static unsigned protected_counter;
${functionPrefix} {
  if (workers != 2 || id >= workers || iterations != 1000) return -1;
  void *range = ranges + (id == 0 ? 4095 : 4096);
  unsigned size = id == 0 ? 2 : 4096;
  barrier(&ready, workers);
  // This tests the runtime's internal mutex protocol, not overlapping C/C++
  // atomic objects of different types. Both ranges lock slot zero; the first
  // wraps from slot 63 and the second covers all slots exactly once.
  for (unsigned i = 0; i < iterations; ++i) {
    rt_lock(range, size);
    unsigned next = protected_counter + 1;
    __asm__ volatile("" : : : "memory");
    protected_counter = next;
    rt_unlock(range, size);
  }
  barrier(&done, workers);
  if (protected_counter != iterations * workers) return -2;
  results[id] = protected_counter;
  return (int)(unsigned)results;
}
`;

const families = [
  { name: 'mixed-sized-generic-16', code: mixed16, iterations: 1000,
    requiredSymbols: ['__atomic_load_16', '__atomic_fetch_add_16', '__atomic_load', '__atomic_compare_exchange'] },
  { name: 'generic-17-wrap', code: genericRange(17, 100), iterations: 100,
    requiredSymbols: ['__atomic_load', '__atomic_compare_exchange'] },
  { name: 'generic-4097-all-slots', code: genericRange(4097, 8), iterations: 8,
    requiredSymbols: ['__atomic_load', '__atomic_compare_exchange'] },
  { name: 'range-lock-overlap', code: rangeLocks, iterations: 1000,
    requiredSymbols: ['libat_lock_n', 'libat_unlock_n'] },
];

export const sharedCases = families.flatMap(family => ['c', 'cpp'].flatMap(language => ['0', '2'].map(optimization => ({
  id: `libatomic-shared-${family.name}-${language}-o${optimization}`,
  kind: 'libatomic-shared', family: family.name,
  request: { language, standard: language === 'c' ? 'gnu11' : 'gnu++17', optimization,
    atomics: true, code: family.code,
    sharedMemory: { entry: 'run', initialPages: 8, maximumPages: 8 } },
  run: { workerArguments: [[0, family.iterations, 2], [1, family.iterations, 2]], stackBytes: 65536 },
  expected: { resultsAreSamePointer: true, memory: { type: 'u32', offsetFromResult: 0,
    values: [family.iterations * 2, family.iterations * 2] } },
  requiredSymbols: family.requiredSymbols,
}))));

export function assertSharedLibatomicResult(fixture, result) {
  const values = result.values;
  if (!Array.isArray(values) || values.length !== 2 || !values.every(Number.isInteger)
      || values[0] <= 0 || values[0] !== values[1]) throw new Error(`${fixture.id}: workers did not return one valid result address`);
  const bytes = result.memory instanceof Uint8Array ? result.memory : new Uint8Array(result.memory);
  const address = values[0] + fixture.expected.memory.offsetFromResult;
  if (address % 4 || address + 8 > bytes.byteLength) throw new Error(`${fixture.id}: result address is outside memory`);
  const view = new DataView(bytes.buffer, bytes.byteOffset + address, 8);
  for (let i = 0; i < 2; i++) if (view.getUint32(i * 4, true) !== fixture.expected.memory.values[i]) {
    throw new Error(`${fixture.id}: shared runtime lost updates or corrupted the final result`);
  }
  return { address, values: [view.getUint32(0, true), view.getUint32(4, true)] };
}
