// Native TLS ABI fixtures. Guest values live in real compiler TLS variables;
// the host only allocates regions and invokes the linker's TLS initializer.
export const nativeTlsLayout = Object.freeze({ magic: 0x544c5331, version: 1, bytes: 272, workers: 2, rowWords: 32 });

const header = `#ifndef TLS_NATIVE_FIXTURE_H
#define TLS_NATIVE_FIXTURE_H
#ifndef __wasm_tls__
#error TLS profile must be enabled
#endif
#ifdef __cplusplus
#define TLS thread_local
#define EXTERN_C extern "C"
#define ASSERT static_assert
#else
#define TLS _Thread_local
#define EXTERN_C
#define ASSERT _Static_assert
#endif
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned u32;
typedef unsigned long long u64;
typedef unsigned __int128 u128;
extern TLS u8 byte_value;
extern TLS u16 short_value;
extern TLS u32 word_value;
extern TLS u64 wide_value;
extern TLS u128 largest_value;
extern TLS unsigned char aligned_bytes[64];
extern TLS u32 zero_value;
struct row { u32 errors, worker, addresses[8], before[10], after[10], other_address, local_value; };
struct output { u32 magic, version, workers, bytes; struct row rows[2]; };
ASSERT(sizeof(struct row)==128, "row ABI");
ASSERT(sizeof(struct output)==272, "output ABI");
void mutate(unsigned id);
unsigned other_address(void);
unsigned *local_address(void);
#endif
`;

function definition(zeroOnly) {
  return `#include "tls-fixture.h"
TLS u8 byte_value${zeroOnly ? '' : '=17'};
TLS u16 short_value${zeroOnly ? '' : '=0x2345'};
TLS u32 word_value${zeroOnly ? '' : '=0x76543210'};
TLS u64 wide_value${zeroOnly ? '' : '=0x1122334455667788ULL'};
TLS u128 largest_value${zeroOnly ? '' : '=((u128)0x123456789abcdef0ULL<<64)|0x0fedcba987654321ULL'};
TLS unsigned char aligned_bytes[64] __attribute__((aligned(64)));
TLS u32 zero_value;
unsigned *local_address(void) { static TLS unsigned local; return &local; }
unsigned other_address(void) { return (unsigned)&word_value; }
void mutate(unsigned id) {
  byte_value=(u8)(31+id); short_value=(u16)(0x4567+id); word_value=0x34567890+id;
  wide_value=0x23456789abcdef01ULL+id;
  largest_value=(((u128)0x3456789abcdef012ULL<<64)|0xfedcba9876543210ULL)+id;
  zero_value=100+id; aligned_bytes[0]=(unsigned char)(61+id);
  aligned_bytes[63]=(unsigned char)(71+id); ++*local_address();
}
`;
}

const entry = `#include "tls-fixture.h"
static struct output output;
static unsigned arrivals;
static void snapshot(unsigned *values) {
  values[0]=byte_value; values[1]=short_value; values[2]=word_value;
  values[3]=(u32)wide_value; values[4]=(u32)(wide_value>>32);
  values[5]=(u32)largest_value; values[6]=(u32)(largest_value>>32);
  values[7]=(u32)(largest_value>>64); values[8]=(u32)(largest_value>>96);
  values[9]=zero_value;
}
EXTERN_C int probe_entry(int worker, int count) {
  if ((unsigned)worker>=2 || count!=2) return -1;
  struct row *row=&output.rows[worker];
  row->worker=(unsigned)worker;
  row->addresses[0]=(unsigned)&byte_value; row->addresses[1]=(unsigned)&short_value;
  row->addresses[2]=(unsigned)&word_value; row->addresses[3]=(unsigned)&wide_value;
  row->addresses[4]=(unsigned)&largest_value; row->addresses[5]=(unsigned)&aligned_bytes[0];
  row->addresses[6]=(unsigned)&zero_value; row->addresses[7]=(unsigned)local_address();
  row->other_address=other_address();
  for (unsigned i=0;i<64;++i) if (aligned_bytes[i]) row->errors|=1;
  if (*local_address()) row->errors|=2;
  snapshot(row->before);
  __atomic_fetch_add(&arrivals,1,__ATOMIC_ACQ_REL);
  while (__atomic_load_n(&arrivals,__ATOMIC_ACQUIRE)!=2) {}
  mutate((unsigned)worker);
  row->local_value=*local_address();
  if (aligned_bytes[0]!=61+worker || aligned_bytes[63]!=71+worker) row->errors|=4;
  snapshot(row->after);
  if (!worker) { output.magic=0x544c5331; output.version=1; output.workers=2; output.bytes=sizeof output; }
  return (int)&output;
}
`;

export const nativeTlsSharedCases = Object.freeze(['c', 'cpp'].flatMap(language => ['0', '2'].flatMap(optimization => [false, true].map(zeroOnly => ({
  id: `tls-native-${zeroOnly ? 'zero' : 'layout'}-${language}-o${optimization}`,
  kind: 'native-tls',
  request: {
    code: entry, language, standard: language === 'cpp' ? 'c++17' : 'c11', optimization,
    tls: true, atomics: true, sharedMemory: { entry: 'probe_entry', initialPages: 4, maximumPages: 4, reservedBytes: 131072 },
    files: [{ path: 'tls-fixture.h', contents: header }, { path: language === 'cpp' ? 'other.cpp' : 'other.c', contents: definition(zeroOnly) }],
    sources: [language === 'cpp' ? 'other.cpp' : 'other.c'],
  },
  run: { workerArguments: [[0, 2], [1, 2]], stackBytes: 32768, timeoutMs: 30000 },
  expected: { zeroOnly },
})))));

export function assertNativeTlsSharedResult(fixture, result) {
  const check = (ok, message) => { if (!ok) throw new Error(`${fixture.id}: ${message}`); };
  check(Array.isArray(result.values) && result.values.length === 2, 'two Worker results required');
  check(Number.isSafeInteger(result.values[0]) && result.values[0] > 0 && result.values[0] === result.values[1], 'same output pointer required');
  check(result.memory instanceof Uint8Array, 'copied guest memory required');
  const address = result.values[0];
  check(address % 4 === 0 && address + nativeTlsLayout.bytes <= result.memory.byteLength, 'output bounds');
  const view = new DataView(result.memory.buffer, result.memory.byteOffset + address, nativeTlsLayout.bytes);
  const word = index => view.getUint32(index * 4, true);
  check(word(0) === nativeTlsLayout.magic && word(1) === 1 && word(2) === 2 && word(3) === nativeTlsLayout.bytes, 'output ABI');
  check(Array.isArray(result.tlsRegions) && result.tlsRegions.length === 2, 'TLS region receipt required');
  const initial = fixture.expected.zeroOnly ? Array(10).fill(0) : [17,0x2345,0x76543210,0x55667788,0x11223344,0x87654321,0x0fedcba9,0x9abcdef0,0x12345678,0];
  const widths = [1,2,4,8,16,64,4,4], alignments = [1,2,4,8,16,64,4,4];
  const addressRows = [];
  for (let id=0; id<2; id++) {
    const offset = 4+id*32, region = result.tlsRegions[id];
    check(Number.isSafeInteger(region.low) && Number.isSafeInteger(region.high) && region.low > 0 && region.high > region.low && region.high <= result.memory.byteLength, `Worker ${id} TLS bounds`);
    check(Number.isSafeInteger(region.alignment) && region.alignment >= 64 && (region.alignment & (region.alignment-1)) === 0 && region.low % region.alignment === 0, `Worker ${id} TLS alignment`);
    check(word(offset) === 0 && word(offset+1) === id, `Worker ${id} guest checks`);
    const addresses = widths.map((width,i) => word(offset+2+i));
    addressRows.push(addresses);
    addresses.forEach((value,i) => check(value >= region.low && value+widths[i] <= region.high && value%alignments[i] === 0, `Worker ${id} TLS address ${i}`));
    check(word(offset+30) === addresses[2] && word(offset+31) === 1, `Worker ${id} cross-TU/local storage`);
    const after = [31+id,0x4567+id,0x34567890+id,0xabcdef01+id,0x23456789,0x76543210+id,0xfedcba98,0xbcdef012,0x3456789a,100+id];
    for (let i=0;i<10;i++) {
      check(word(offset+10+i) === initial[i], `Worker ${id} initial word ${i}`);
      check(word(offset+20+i) === (after[i] >>> 0), `Worker ${id} changed word ${i}`);
    }
  }
  const [left,right] = result.tlsRegions;
  check(left.high <= right.low || right.high <= left.low, 'Worker TLS regions overlap');
  for (let i=0;i<8;i++) check(addressRows[0][i] !== addressRows[1][i], `TLS object ${i} aliases across Workers`);
  return { workers:2, tlsObjectsPerWorker:8, comparedValueWords:40, multipleTranslationUnits:true };
}
