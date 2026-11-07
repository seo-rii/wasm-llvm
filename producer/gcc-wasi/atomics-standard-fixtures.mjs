// Exercise the installed standard C/C++ headers against the real GNU runtime.
import assert from 'node:assert/strict';

const adapters = language => language === 'cpp' ? `#include <atomic>
#define ATOMIC(T) std::atomic<T>
#define LOAD(P) (P)->load(std::memory_order_acquire)
#define STORE(P,V) (P)->store((V),std::memory_order_release)
#define ADD(P,V) (P)->fetch_add((V),std::memory_order_seq_cst)
#define CAS(P,E,V) (P)->compare_exchange_strong(*(E),(V),std::memory_order_acq_rel,std::memory_order_acquire)
#define LOCK_FREE(P) (P)->is_lock_free()
#define EXTERN extern "C"
` : `#include <stdatomic.h>
#define ATOMIC(T) _Atomic(T)
#define LOAD(P) atomic_load_explicit((P),memory_order_acquire)
#define STORE(P,V) atomic_store_explicit((P),(V),memory_order_release)
#define ADD(P,V) atomic_fetch_add_explicit((P),(V),memory_order_seq_cst)
#define CAS(P,E,V) atomic_compare_exchange_strong_explicit((P),(E),(V),memory_order_acq_rel,memory_order_acquire)
#define LOCK_FREE(P) atomic_is_lock_free(P)
#define EXTERN
`;
const objects = `#include <stdint.h>
typedef unsigned __int128 wide_t;
static ATOMIC(uint8_t) a8 = 0;
static ATOMIC(uint16_t) a16 = 0;
static ATOMIC(uint32_t) a32 = 0;
static ATOMIC(uint64_t) a64 = 0;
static ATOMIC(wide_t) wide = (wide_t)1 << 96;
`;
const single = `#include <stdio.h>
#define CHECK(P,T) do { \\
  STORE((P),(T)~(T)0); \\
  if (ADD((P),(T)1) != (T)~(T)0 || LOAD(P) != 0) return 11; \\
  T expected = 1; \\
  if (CAS((P),&expected,(T)n) || expected != 0) return 12; \\
  if (!CAS((P),&expected,(T)(n+5)) || LOAD(P) != (T)(n+5)) return 13; \\
  if (!LOCK_FREE(P)) return 14; \\
} while (0)
int main(void) {
  unsigned n;
  if (scanf("%u",&n) != 1 || n > 100) return 10;
  CHECK(&a8,uint8_t); CHECK(&a16,uint16_t);
  CHECK(&a32,uint32_t); CHECK(&a64,uint64_t);
  wide_t initial = (wide_t)1 << 96, expected = 0;
  if (LOCK_FREE(&wide) || CAS(&wide,&expected,initial+1) || expected != initial) return 15;
  if (!CAS(&wide,&expected,initial+n) || LOAD(&wide) != initial+n) return 16;
  printf("atomic-headers %u %u %u %u %u %u\\n",n,(unsigned)LOAD(&a8),
    (unsigned)LOAD(&a16),(unsigned)LOAD(&a32),(unsigned)LOAD(&a64),
    (unsigned)(LOAD(&wide) >> 96));
  return 0;
}
`;
const shared = `static ATOMIC(uint32_t) ready = 0;
static uint32_t results[16];
EXTERN int probe_entry(int id,int workers,int rounds) {
  if (id < 0 || id >= 2 || workers != 2 || rounds != 64) return -1;
  ADD(&ready,1);
  while (LOAD(&ready) < 2) { }
  for (int i=0;i<rounds;i++) {
    ADD(&a8,1); ADD(&a16,1); ADD(&a32,1); ADD(&a64,1);
    wide_t expected = LOAD(&wide);
    while (!CAS(&wide,&expected,expected+1)) { }
  }
  ADD(&ready,1);
  while (LOAD(&ready) < 4) { }
  uint32_t *r = results + id*8;
  r[0]=0x41544f4d; r[1]=(uint32_t)(workers*rounds);
  r[2]=(!LOCK_FREE(&a8) || !LOCK_FREE(&a16) || !LOCK_FREE(&a32) ||
         !LOCK_FREE(&a64) || LOCK_FREE(&wide)) ? 1 : 0;
  r[3]=LOAD(&a8); r[4]=LOAD(&a16); r[5]=LOAD(&a32);
  wide_t value=LOAD(&wide);
  r[6]=(uint32_t)value; r[7]=(uint32_t)(value >> 96);
  if (LOAD(&a64) != (uint64_t)(workers*rounds)) r[2] |= 2;
  return (int)(uintptr_t)results;
}
`;

export const standardAtomicCases = ['c', 'cpp'].flatMap(language => ['0', '2'].flatMap(optimization => {
  const request = { language, optimization, standard: language === 'cpp' ? 'gnu++23' : 'gnu11', atomics: true };
  const prefix = adapters(language) + objects;
  return [
    { id: `atomic-standard-${language}-o${optimization}`, request: { ...request, code: prefix + single }, stdin: '37\n', stdout: 'atomic-headers 37 42 42 42 42 1\n' },
    { id: `atomic-standard-shared-${language}-o${optimization}`, request: { ...request, code: prefix + shared,
      sharedMemory: { entry: 'probe_entry', initialPages: 4, maximumPages: 4 } },
      run: { workerArguments: [[0, 2, 64], [1, 2, 64]], stackBytes: 32768, timeoutMs: 15000 } },
  ];
}));

export function verifyStandardAtomicShared(fixture, result) {
  assert(fixture.request.sharedMemory);
  assert.equal(result.values.length, 2);
  assert.equal(result.values[0], result.values[1]);
  const offset = result.values[0];
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset % 4 === 0);
  assert(offset + 64 <= result.memory.byteLength);
  const view = new DataView(result.memory.buffer, result.memory.byteOffset + offset, 64);
  const rows = [0, 1].map(worker => Array.from({ length: 8 }, (_, word) => view.getUint32((worker*8+word)*4, true)));
  for (const row of rows) assert.deepEqual(row, [0x41544f4d, 128, 0, 128, 128, 128, 128, 1]);
  return { standardHeaders: true, workers: 2, incrementsPerWidth: 128, lockFreeSizes: [1, 2, 4, 8], lockFree16: false, rows };
}
