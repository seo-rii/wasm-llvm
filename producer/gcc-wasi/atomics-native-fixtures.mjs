// Aligned 1/2/4/8-byte GCC builtin consumers. No helper implementations or host
// Atomics implement guest work. These fixtures need two instances sharing the
// same fixed memory, one-time LLD initialization, and separate per-instance stacks.
export const nativeAtomicLayout = Object.freeze({
  magic: 0x41363931, version: 1, bytes: 12696, workers: 2, iterations: 64,
  final: 32, casFailures: 128, forcedFailures: 176, batches: 224,
  interleaved: 272, transitions: 320, messages: 368, litmus: 392, tickets: 408,
  maximumBatches: 64,
});
const orders = ['RELAXED', 'CONSUME', 'ACQUIRE', 'RELEASE', 'ACQ_REL', 'SEQ_CST'];
const failures = ['RELAXED', 'CONSUME', 'ACQUIRE', 'RELAXED', 'ACQUIRE', 'SEQ_CST'];
const widths = [[1, 'unsigned char'], [2, 'unsigned short'], [4, 'unsigned int'], [8, 'unsigned long long']];

function source(width, type) {
  const minimumBatches = width < 4 ? 8 : 32;
  return `#ifndef __wasm_atomics__
#error atomics must be enabled
#endif
#ifdef __cplusplus
#define ASSERT static_assert
#else
#define ASSERT _Static_assert
#endif
typedef ${type} value_t;
ASSERT(sizeof(unsigned) == 4, "u32 output ABI");
ASSERT(__atomic_always_lock_free(sizeof(value_t), 0), "native width");
ASSERT(!__atomic_always_lock_free(16, 0), "no native 128-bit claim");
enum { WORKERS=2, ITERATIONS=64, MIN_BATCHES=${minimumBatches}, MAX_BATCHES=64 };
struct output {
  unsigned magic, width, workers, iterations, bytes, version, errors[2];
  unsigned final[2][6][2], cas_failures[6][2], forced_failures[6][2];
  unsigned batches[2][6], interleaved[2][6], transitions[2][6];
  unsigned messages[3][2], litmus[4], tickets[2][6][2][64][2];
};
ASSERT(sizeof(struct output) == ${nativeAtomicLayout.bytes}, "output bytes");
ASSERT(__builtin_offsetof(struct output, tickets) == ${nativeAtomicLayout.tickets}, "ticket offset");
static struct output result;
static unsigned initialized, arrivals, epoch, stop_batch, payload, observations[2];
static unsigned scratch[2][64][2];
static value_t counter, publication, x, y;
static void barrier(unsigned *phase) {
  unsigned next = ++*phase;
  if (__atomic_fetch_add(&arrivals, 1, __ATOMIC_ACQ_REL) == 1) {
    __atomic_store_n(&arrivals, 0, __ATOMIC_RELAXED);
    __atomic_store_n(&epoch, next, __ATOMIC_RELEASE);
  } else while (__atomic_load_n(&epoch, __ATOMIC_ACQUIRE) != next) {}
}
static void split(unsigned *out, value_t value) {
  unsigned long long n = (unsigned long long)value;
  out[0] = (unsigned)n; out[1] = (unsigned)(n >> 32);
}
static unsigned long long join(const unsigned *in) {
  return (unsigned long long)in[0] | ((unsigned long long)in[1] << 32);
}
static value_t fetch(unsigned order) {
  switch (order) {
${orders.map((order, i) => `    case ${i}: return __atomic_fetch_add(&counter, (value_t)1, __ATOMIC_${order});`).join('\n')}
  }
  return 0;
}
static int cas(value_t *expected, value_t desired, unsigned order) {
  switch (order) {
${orders.map((order, i) => `    case ${i}: return __atomic_compare_exchange_n(&counter, expected, desired, 0, __ATOMIC_${order}, __ATOMIC_${failures[i]});`).join('\n')}
  }
  return 0;
}
// Validate every bounded batch in the guest. Retain a complete interleaved
// window for the independent host oracle, including both workers' ticket order.
static unsigned inspect_window(unsigned scenario, unsigned order, value_t base, unsigned *errors) {
  unsigned owners[128];
  for (unsigned i=0; i<128; ++i) owners[i]=0;
  for (unsigned worker=0; worker<2; ++worker) {
    unsigned previous=0;
    for (unsigned i=0; i<64; ++i) {
      unsigned long long ticket=join(scratch[worker][i]);
      unsigned long long index=ticket-(unsigned long long)base;
      if (index>=128 || (i && index<=previous)) { *errors|=1; continue; }
      if (owners[(unsigned)index]) *errors|=1;
      owners[(unsigned)index]=worker+1; previous=(unsigned)index;
    }
  }
  unsigned transitions=0;
  for (unsigned i=0; i<128; ++i) {
    if (!owners[i]) *errors|=1;
    if (i && owners[i]!=owners[i-1]) ++transitions;
  }
  value_t final=__atomic_load_n(&counter, __ATOMIC_SEQ_CST);
  if (final!=(value_t)(base+128)) *errors|=2;
  if (transitions>1 || !result.batches[scenario][order]) {
    split(result.final[scenario][order], final);
    for (unsigned worker=0; worker<2; ++worker)
      for (unsigned i=0; i<64; ++i)
        for (unsigned half=0; half<2; ++half)
          result.tickets[scenario][order][worker][i][half]=scratch[worker][i][half];
    result.transitions[scenario][order]=transitions;
  }
  ++result.batches[scenario][order];
  if (transitions>1) ++result.interleaved[scenario][order];
  return transitions;
}
#ifdef __cplusplus
extern "C"
#endif
__attribute__((used,visibility("default")))
int probe_entry(unsigned id, unsigned workers, unsigned iterations) {
  if (workers!=WORKERS || id>=WORKERS || iterations!=ITERATIONS) return -1;
  unsigned phase=0, errors=0;
  const value_t base=(value_t)((unsigned long long)1 << (${width * 8}-1));
  if (id==0) {
    result.magic=${nativeAtomicLayout.magic}U; result.width=sizeof(value_t);
    result.workers=workers; result.iterations=iterations;
    result.bytes=sizeof(result); result.version=${nativeAtomicLayout.version};
    __atomic_store_n(&initialized, 1, __ATOMIC_RELEASE);
  }
  while (!__atomic_load_n(&initialized, __ATOMIC_ACQUIRE)) {}
  for (unsigned scenario=0; scenario<2; ++scenario) for (unsigned order=0; order<6; ++order) {
    for (unsigned batch=0; batch<MAX_BATCHES; ++batch) {
      if (id==0) { __atomic_store_n(&counter, base, __ATOMIC_SEQ_CST); stop_batch=0; }
      barrier(&phase);
      if (scenario) {
        value_t expected=42;
        if (cas(&expected, (value_t)1, order) || expected==42 ||
            (unsigned long long)expected<(unsigned long long)base ||
            (unsigned long long)expected>(unsigned long long)base+64) errors|=4;
        else ++result.forced_failures[order][id];
      }
      for (unsigned i=0; i<iterations; ++i) {
        value_t old;
        if (!scenario) old=fetch(order);
        else {
          old=__atomic_load_n(&counter, __ATOMIC_RELAXED);
          for (;;) {
            value_t expected=old;
            if (cas(&expected, (value_t)(old+1), order)) break;
            ++result.cas_failures[order][id];
            if (expected==old) errors|=8;
            old=expected;
          }
        }
        split(scratch[id][i], old);
      }
      barrier(&phase);
      if (id==0) {
        inspect_window(scenario, order, base, &errors);
        stop_batch=(batch+1>=MIN_BATCHES && result.interleaved[scenario][order]) || batch+1==MAX_BATCHES;
        if (stop_batch && !result.interleaved[scenario][order]) errors|=16;
      }
      barrier(&phase);
      unsigned finished=stop_batch;
      // Both workers must read this batch decision before the next reset.
      barrier(&phase);
      if (finished) break;
    }
  }
  // Release/acquire, seq_cst, and fence+relaxed publication of ordinary data.
  // The reverse flag handoff keeps the next writer access after the prior read.
  for (unsigned mode=0; mode<3; ++mode) {
    if (id==0) __atomic_store_n(&publication, 0, __ATOMIC_RELAXED);
    barrier(&phase);
    for (unsigned i=0; i<iterations; ++i) {
      unsigned wanted=0xa5690000U+mode*iterations+i;
      if (id==0) {
        while (__atomic_load_n(&publication, __ATOMIC_ACQUIRE)!=0) {}
        payload=wanted;
        if (mode==0) __atomic_store_n(&publication, 1, __ATOMIC_RELEASE);
        else if (mode==1) __atomic_store_n(&publication, 1, __ATOMIC_SEQ_CST);
        else { __atomic_thread_fence(__ATOMIC_RELEASE); __atomic_store_n(&publication, 1, __ATOMIC_RELAXED); }
      } else {
        if (mode==0) while (__atomic_load_n(&publication, __ATOMIC_ACQUIRE)!=1) {}
        else if (mode==1) while (__atomic_load_n(&publication, __ATOMIC_SEQ_CST)!=1) {}
        else { while (__atomic_load_n(&publication, __ATOMIC_RELAXED)!=1) {} __atomic_thread_fence(__ATOMIC_ACQUIRE); }
        if (payload!=wanted) errors|=32;
        __atomic_store_n(&publication, 0, __ATOMIC_RELEASE);
      }
      ++result.messages[mode][id];
    }
    barrier(&phase);
  }
  // Store-buffering: no inter-worker synchronization between each store/load.
  // Sequential consistency prohibits both loads observing zero in a round.
  for (unsigned round=0; round<iterations*2; ++round) {
    if (id==0) { __atomic_store_n(&x, 0, __ATOMIC_SEQ_CST); __atomic_store_n(&y, 0, __ATOMIC_SEQ_CST); }
    barrier(&phase);
    if (id==0) { __atomic_store_n(&x, 1, __ATOMIC_SEQ_CST); observations[0]=__atomic_load_n(&y, __ATOMIC_SEQ_CST); }
    else { __atomic_store_n(&y, 1, __ATOMIC_SEQ_CST); observations[1]=__atomic_load_n(&x, __ATOMIC_SEQ_CST); }
    barrier(&phase);
    if (id==0) {
      if (observations[0]>1 || observations[1]>1) errors|=64;
      else { unsigned outcome=observations[0]*2+observations[1]; ++result.litmus[outcome]; if (!outcome) errors|=64; }
    }
    barrier(&phase);
  }
  result.errors[id]=errors;
  barrier(&phase);
  return (int)(unsigned long)&result;
}
`;
}

export const nativeAtomicSharedCases = widths.flatMap(([width, type]) => ['c', 'cpp'].flatMap(language => ['0', '2'].map(optimization => ({
  id: `atomics-native-shared-${width}-${language}-o${optimization}`,
  kind: 'atomics-native-shared', width,
  request: { language, standard: language === 'c' ? 'gnu11' : 'gnu++17', optimization,
    atomics: true, code: source(width, type),
    sharedMemory: { entry: 'probe_entry', initialPages: 4, maximumPages: 4 } },
  run: { workerArguments: [[0, 2, 64], [1, 2, 64]], stackBytes: 32768, timeoutMs: 60000 },
  minimumBatches: width < 4 ? 8 : 32, requiredSymbols: [],
}))));

export function assertNativeAtomicSharedResult(fixture, result) {
  const fail = message => { throw new Error(`${fixture.id}: ${message}`); };
  const { values } = result;
  if (!Array.isArray(values) || values.length!==2 || !values.every(Number.isInteger)
      || values[0]<=0 || values[0]!==values[1]) fail('workers did not return one valid result address');
  if (!(result.memory instanceof ArrayBuffer) && !ArrayBuffer.isView(result.memory)) fail('missing final memory copy');
  const bytes = ArrayBuffer.isView(result.memory)
    ? new Uint8Array(result.memory.buffer, result.memory.byteOffset, result.memory.byteLength)
    : new Uint8Array(result.memory);
  const address=values[0], layout=nativeAtomicLayout;
  if (address%4 || address+layout.bytes>bytes.byteLength) fail('result address is outside memory');
  const view=new DataView(bytes.buffer, bytes.byteOffset+address, layout.bytes);
  const u32=offset => view.getUint32(offset, true);
  const u64=offset => BigInt(u32(offset)) | (BigInt(u32(offset+4))<<32n);
  const expectedHeader=[layout.magic, fixture.width, layout.workers, layout.iterations, layout.bytes, layout.version];
  if (expectedHeader.some((n,i)=>u32(i*4)!==n)) fail('invalid result layout or cohort');
  const errors=[u32(24),u32(28)];
  if (errors.some(Boolean)) fail(`guest failure codes ${errors.join(',')}`);
  const base=1n<<BigInt(fixture.width*8-1), mask=(1n<<BigInt(fixture.width*8))-1n;
  const windows=[];
  for (let scenario=0;scenario<2;scenario++) for(let order=0;order<6;order++) {
    const caseIndex=scenario*6+order;
    const batches=u32(layout.batches+caseIndex*4), interleaved=u32(layout.interleaved+caseIndex*4);
    if (batches<fixture.minimumBatches || batches>layout.maximumBatches || interleaved<1 || interleaved>batches)
      fail(`missing bounded contention evidence in ${scenario}/${order}`);
    if (u64(layout.final+caseIndex*8)!==((base+128n)&mask)) fail(`wrong final counter in ${scenario}/${order}`);
    const owners=Array(128).fill(-1), tickets=[];
    for(let worker=0;worker<2;worker++) {
      const workerTickets=[];
      for(let i=0;i<64;i++) {
        const ticket=u64(layout.tickets+(((caseIndex*2+worker)*64+i)*8));
        const index=ticket-base;
        if(index<0n || index>=128n || owners[Number(index)]!==-1) fail(`invalid or duplicate ticket in ${scenario}/${order}`);
        if(i && ticket<=workerTickets[i-1]) fail(`reordered worker tickets in ${scenario}/${order}`);
        owners[Number(index)]=worker; workerTickets.push(ticket);
      }
      tickets.push(workerTickets.map(n=>n.toString()));
    }
    if(owners.some(owner=>owner===-1)) fail(`missing ticket in ${scenario}/${order}`);
    const transitions=owners.slice(1).reduce((n,owner,i)=>n+(owner!==owners[i]),0);
    if(transitions<=1) fail(`sequential-only ticket ranges in ${scenario}/${order}`);
    if(u32(layout.transitions+caseIndex*4)!==transitions) fail(`incorrect interleaving metric in ${scenario}/${order}`);
    const casFailures=scenario ? [0,1].map(id=>u32(layout.casFailures+(order*2+id)*4)) : undefined;
    if(scenario && [0,1].some(id=>u32(layout.forcedFailures+(order*2+id)*4)!==batches))
      fail(`missing failed-CAS expected updates in ${order}`);
    windows.push({scenario:scenario?'compare-exchange':'fetch-add',order:orders[order].toLowerCase(),batches,interleaved,transitions,tickets,...(casFailures?{casFailures}:{})});
  }
  const messages=Array.from({length:3},(_,mode)=>[0,1].map(id=>u32(layout.messages+(mode*2+id)*4)));
  if(messages.some(counts=>counts.some(n=>n!==layout.iterations))) fail('incomplete publication phases');
  const litmus=Array.from({length:4},(_,i)=>u32(layout.litmus+i*4));
  if(litmus[0]!==0 || litmus.reduce((a,b)=>a+b,0)!==layout.iterations*2) fail('forbidden or incomplete seq_cst litmus observations');
  return {address,width:fixture.width,workers:2,errors,windows,messages,litmus};
}
