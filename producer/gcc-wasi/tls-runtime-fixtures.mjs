// Actual libc errno, GNU allocated cleanup lists and ordinary exit semantics.
const sharedErrnoCode=String.raw`#ifndef __wasm_tls__
#error Native TLS profile is required
#endif
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" { int *__errno_location(void); unsigned run(unsigned,unsigned); }
#else
extern int *__errno_location(void);
#endif
struct observation {
  uint32_t address, location, completed, failures;
  int result, error;
};
static struct observation results[2];
static unsigned arrived, phase;

static void barrier(void) {
  unsigned ticket = __atomic_fetch_add(&arrived, 1, __ATOMIC_SEQ_CST);
  if (ticket & 1)
    __atomic_store_n(&phase, ticket / 2 + 1, __ATOMIC_SEQ_CST);
  else
    while (__atomic_load_n(&phase, __ATOMIC_SEQ_CST) <= ticket / 2) {}
}

unsigned run(unsigned id, unsigned iterations) {
  if (id > 1 || iterations != 128) __builtin_trap();
  struct observation *out = &results[id];
  out->address = (uintptr_t)&errno;
  out->location = (uintptr_t)__errno_location();
  if (out->address != out->location) ++out->failures;
  for (unsigned i = 0; i < iterations; ++i) {
    int marker = 700 + (int)id;
    errno = marker;
    barrier();
    if (errno != marker) ++out->failures;
    char *end;
    long value = strtol(id ? "17" : "999999999999999999999999999999999999", &end, 10);
    barrier();
    if (value != (id ? 17 : 2147483647L)) ++out->failures;
    if (*end != 0 || errno != (id ? marker : ERANGE)) ++out->failures;
    out->result = value;
    out->error = errno;
    ++out->completed;
    barrier();
  }
  return (uintptr_t)results;
}
`;

const sharedGnuCode=String.raw`#ifndef __wasm_tls__
#error Native TLS profile is required
#endif
#include <cstdlib>
#include <cerrno>
#include <cstddef>
#include <cxxabi.h>
#include <unistd.h>

extern "C" int *__errno_location(void);
extern "C" char __heap_base;
extern "C" char __heap_end;

struct Row {
  unsigned errors, worker, errno_address, errno_function_address;
  unsigned constructor_count, destructor_count, registration_count, allocation_rounds;
  unsigned memory_pages, overflow_errno, ordinary_errno, oom_errno;
  unsigned events[516];
};
struct Output { unsigned magic, workers, row_bytes, registrations; Row rows[2]; };
static Output output;
static unsigned arrivals;
// Exercise the libc allocation ABI even when the result is only inspected for
// failure: an optimizer may elide an otherwise unobserved malloc call.
static void *(*volatile allocate_for_failure)(std::size_t) = std::malloc;
static thread_local unsigned worker_id;
static thread_local unsigned registration_ids[514];

static void direct_destructor(void *pointer) {
  const unsigned id = *static_cast<unsigned *>(pointer);
  Row &row = output.rows[worker_id];
  if (row.destructor_count >= 516) __builtin_trap();
  row.events[row.destructor_count++] = id;
  if (id == 512) {
    registration_ids[513] = 9000;
    if (__cxxabiv1::__cxa_thread_atexit(direct_destructor, &registration_ids[513], nullptr)) row.errors |= 1;
  }
}

struct Guard {
  unsigned id;
  explicit Guard(unsigned value): id(value) { ++output.rows[worker_id].constructor_count; }
  ~Guard() { direct_destructor(&id); }
};
static thread_local Guard first(10000), second(10001);

extern "C" int run(int worker, int count) {
  if (worker < 0 || worker > 1 || count != 2) return -1;
  worker_id = static_cast<unsigned>(worker);
  Row &row = output.rows[worker]; row.worker = worker;
  row.errno_address = reinterpret_cast<unsigned>(&errno);
  row.errno_function_address = reinterpret_cast<unsigned>(__errno_location());
  if (first.id != 10000 || second.id != 10001 || row.constructor_count != 2) row.errors |= 2;
  errno = 700 + worker;
  char *end;
  const long value = std::strtol(worker ? "17" : "99999999999999999999999", &end, 10);
  if (worker) { row.ordinary_errno = errno; if (value != 17 || errno != 701) row.errors |= 4; }
  else { row.overflow_errno = errno; if (value != 2147483647L || errno != ERANGE) row.errors |= 8; }
  __atomic_fetch_add(&arrivals, 1, __ATOMIC_ACQ_REL);
  while (__atomic_load_n(&arrivals, __ATOMIC_ACQUIRE) != 2) {}
  for (unsigned round = 0; round < 64; ++round) {
    unsigned char *blocks[64];
    for (unsigned i = 0; i < 64; ++i) {
      blocks[i] = static_cast<unsigned char *>(std::malloc(128 + i));
      if (!blocks[i]) __builtin_trap();
      if (reinterpret_cast<unsigned>(blocks[i]) < reinterpret_cast<unsigned>(&__heap_base) || reinterpret_cast<unsigned>(blocks[i]) + 128 + i > reinterpret_cast<unsigned>(&__heap_end)) row.errors |= 16;
      for (unsigned j = 0; j < 128 + i; ++j) blocks[i][j] = static_cast<unsigned char>(worker * 71 + round + j);
    }
    for (unsigned i = 0; i < 64; ++i) {
      for (unsigned j = 0; j < 128 + i; ++j)
        if (blocks[i][j] != static_cast<unsigned char>(worker * 71 + round + j)) row.errors |= 32;
      std::free(blocks[i]);
    }
    ++row.allocation_rounds;
  }
  for (unsigned i = 0; i < 513; ++i) {
    registration_ids[i] = i;
    if (__cxxabiv1::__cxa_thread_atexit(direct_destructor, &registration_ids[i], nullptr)) row.errors |= 64;
    ++row.registration_count;
  }
  void *memory_end = sbrk(0);
  row.memory_pages = reinterpret_cast<unsigned>(memory_end) / 65536;
  void *too_large = allocate_for_failure(row.memory_pages * 65536);
  row.oom_errno = errno;
  if (too_large || errno != ENOMEM || sbrk(0) != memory_end) row.errors |= 128;
  if (!worker) { output.magic = 0x544c5347; output.workers = 2; output.row_bytes = sizeof(Row); output.registrations = 513; }
  return reinterpret_cast<int>(&output);
}
`;

const ordinaryGnuCode=String.raw`#ifndef __wasm_tls__
#error Native TLS profile is required
#endif
#include <cstdlib>
#include <cstdio>
#include <cerrno>
#include <cxxabi.h>

extern "C" int *__errno_location(void);
static unsigned errors, constructors, destructors;
static thread_local unsigned ids[514];
static void process_check(const char *label) {
  std::printf("%s %u\n",label,destructors);
  if (errors || destructors != 516) __builtin_trap();
}
struct StaticGuard { ~StaticGuard() { process_check("static cleanup"); } };
static StaticGuard static_guard;
static void before() { process_check("process registered before TLS"); }
static void after() { process_check("process registered after TLS"); }
static void quick() {
  std::printf("quick cleanup %u\n",destructors); std::fflush(stdout);
  if (destructors != 0) __builtin_trap();
}
static unsigned expected(unsigned at) {
  if (at == 0) return 512;
  if (at == 1) return 9000;
  if (at < 514) return 513-at;
  return at == 514 ? 10001 : 10000;
}
static void destroy(void *pointer) {
  unsigned id = *static_cast<unsigned *>(pointer);
  if (destructors >= 516 || id != expected(destructors)) ++errors;
  ++destructors;
  if (id == 512) {
    ids[513] = 9000;
    if (__cxxabiv1::__cxa_thread_atexit(destroy,&ids[513],nullptr)) ++errors;
  }
}
struct Guard {
  unsigned id;
  explicit Guard(unsigned value):id(value) { ++constructors; }
  ~Guard() { destroy(&id); }
};
static thread_local Guard first(10000), second(10001);
static void check_cleanup(void *) {
  if (destructors != 516) ++errors;
  std::printf("tls ordinary cleanup %u %u\n",destructors,errors);
}
int main(int argc,char **argv) {
  if (argc != 2) return 20;
  const int mode=std::atoi(argv[1]);
  if (std::atexit(before) || std::at_quick_exit(quick)) return 21;
  if (__cxxabiv1::__cxa_thread_atexit(check_cleanup,nullptr,nullptr)) return 22;
  if (first.id != 10000 || second.id != 10001 || constructors != 2) return 23;
  if (std::atexit(after)) return 24;
  errno = 0; char *end;
  const long result = std::strtol("9999999999999999999999",&end,10);
  if (result != 2147483647L || errno != ERANGE || &errno != __errno_location()) return 25;
  for (unsigned i=0;i<513;++i) {
    ids[i]=i;
    if (__cxxabiv1::__cxa_thread_atexit(destroy,&ids[i],nullptr)) return 26;
  }
  std::printf("tls ordinary body %u 513 %d mode %d\n",constructors,errno,mode);
  std::fflush(stdout);
  if (mode == 1) std::exit(7);
  if (mode == 2) std::abort();
  if (mode == 3) std::_Exit(9);
  if (mode == 4) std::quick_exit(11);
}
`;

const ordinaryErrnoCode=String.raw`#ifndef __wasm_tls__
#error Native TLS profile is required
#endif
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#ifdef __cplusplus
extern "C" int *__errno_location(void);
#define TLS thread_local
#else
extern int *__errno_location(void);
#define TLS _Thread_local
#endif
static TLS unsigned marker=71;
int main(void) {
  char text[128], *end;
  if (scanf("%127s",text)!=1 || marker!=71) return 20;
  errno=709;
  long value=strtol(text,&end,10);
  if (*end || &errno!=__errno_location()) return 21;
  int observed=errno;
  unsigned char *p=(unsigned char *)malloc(4096);
  if (!p) return 22;
  for (unsigned i=0;i<4096;++i) p[i]=(unsigned char)(i*17+11);
  for (unsigned i=0;i<4096;++i) if(p[i]!=(unsigned char)(i*17+11)) return 23;
  free(p);
  printf("errno %ld %d %u\n",value,observed,marker);
  if (fflush(stdout)) return 24;
  fputs("stderr intact\n",stderr);
  return 0;
}
`;

const longDoubleCode=String.raw`#ifndef __wasm_tls__
#error Native TLS profile is required
#endif
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <float.h>
#ifdef __cplusplus
extern "C" int *__errno_location(void);
#else
extern int *__errno_location(void);
#endif
int main(void) {
  long double value, overflow; char *end, rendered[32];
  errno=701;
  if(scanf("%Lf",&value)!=1 || value!=1.25L || errno!=701) return 20;
  if(snprintf(rendered,sizeof rendered,"%.6Lf",value)!=8) return 21;
  long double copy=0;
  if(sscanf(rendered,"%Lf",&copy)!=1 || copy!=value) return 22;
  errno=0; overflow=strtold("1e99999",&end);
  int range=errno;
  if(*end || !(overflow>LDBL_MAX) || range!=ERANGE) return 23;
  const char *invalid="invalid";errno=0;
  if(strtold(invalid,&end)!=0 || end!=invalid || errno!=EINVAL) return 24;
  int invalid_error=errno;
  errno=0;
  if(scanf("%Lf",&overflow)!=1 || !(overflow>LDBL_MAX) || errno!=ERANGE) return 25;
  if(&errno!=__errno_location()) return 26;
  printf("long double %.6Lf %d %d %d\n",value,range,invalid_error,errno);
  return fflush(stdout)!=0;
}
`;

const inlineHeader=String.raw`#ifndef GNU_TLS_INLINE_FIXTURE_H
#define GNU_TLS_INLINE_FIXTURE_H
#ifndef __wasm_tls__
#error Native TLS profile is required
#endif
void constructed(unsigned);
void destroyed(unsigned);
struct InlineGuard {
  unsigned id;
  explicit InlineGuard(unsigned value):id(value) { constructed(id); }
  ~InlineGuard() { destroyed(id); }
};
inline thread_local InlineGuard inline_first(20), inline_second(21);
unsigned peer_first();
unsigned peer_second();
#endif
`;
const inlinePeer=String.raw`#include "inline-tls.h"
unsigned peer_first() { return reinterpret_cast<unsigned>(&inline_first); }
unsigned peer_second() { return reinterpret_cast<unsigned>(&inline_second); }
`;
function inlineRequest(optimization,shared) {
 const prefix=String.raw`#include "inline-tls.h"
#include <cstdlib>
#include <cstdio>
struct Row { unsigned ctors,dtors,events[2],first,second,peer_first,peer_second,errors; };
static Row rows[2];
static thread_local unsigned worker_id;
void constructed(unsigned id) {
  Row &row=rows[worker_id];
  if(id!=20+row.ctors) ++row.errors;
  ++row.ctors;
}
void destroyed(unsigned id) {
  Row &row=rows[worker_id];
  if(row.dtors>=2) __builtin_trap();
  row.events[row.dtors++]=id;
}
static void touch() {
  Row &row=rows[worker_id];
  if(inline_first.id!=20 || inline_second.id!=21) ++row.errors;
  row.first=reinterpret_cast<unsigned>(&inline_first);
  row.second=reinterpret_cast<unsigned>(&inline_second);
  row.peer_first=peer_first(); row.peer_second=peer_second();
  if(row.ctors!=2 || row.first!=row.peer_first || row.second!=row.peer_second) ++row.errors;
}
`;
 const tail=shared?String.raw`static unsigned inline_arrived;
extern "C" int run(int worker,int count) {
  if(worker<0 || worker>1 || count!=2) return -1;
  worker_id=worker; touch();
  __atomic_fetch_add(&inline_arrived,1,__ATOMIC_ACQ_REL);
  while(__atomic_load_n(&inline_arrived,__ATOMIC_ACQUIRE)!=2) {}
  return reinterpret_cast<int>(rows);
}
`:String.raw`static void cleanup() {
  Row &row=rows[0];
  if(row.errors || row.dtors!=2 || row.events[0]!=21 || row.events[1]!=20) __builtin_trap();
  std::printf("inline cleanup 2 21 20\n");
}
int main() {
  touch();if(rows[0].errors || std::atexit(cleanup)) return 20;
  std::printf("inline body 2\n");return 0;
}
`;
 return {code:prefix+tail,files:[{path:'inline-tls.h',contents:inlineHeader},{path:'peer.cpp',contents:inlinePeer}],
  sources:['peer.cpp'],language:'cpp',optimization,standard:'c++17',tls:true,
  ...(shared?{atomics:true,sharedMemory:{entry:'run',initialPages:8,maximumPages:8,reservedBytes:131072}}:{})};
}

const variants=code=>['c','cpp'].flatMap(language=>['0','2'].map(optimization=>({code,language,optimization,standard:language==='cpp'?'c++17':'c11',tls:true})));
export const tlsRuntimeOrdinaryCases=Object.freeze([
 ...variants(longDoubleCode).map(request=>({id:`tls-long-double-ordinary-${request.language}-o${request.optimization}`,
  kind:'tls-long-double-ordinary',request:{...request,longDouble:true},stdin:'1.25 1e99999\n',
  expected:{exitCode:0,stdout:'long double 1.250000 68 28 68\n',stderr:''},
  requiredSymbols:['__errno_location','strtold'],
 })),
 ...['0','2'].map(optimization=>({id:`tls-inline-ordinary-o${optimization}`,kind:'tls-inline-ordinary',
  request:inlineRequest(optimization,false),stdin:'',
  expected:{exitCode:0,stdout:'inline body 2\ninline cleanup 2 21 20\n',stderr:''},
  requiredSymbols:['__cxa_thread_atexit'],
 })),
 ...variants(ordinaryErrnoCode).flatMap(request=>[false,true].map(overflow=>({
  id:`tls-errno-ordinary-${request.language}-o${request.optimization}-${overflow?'overflow':'valid'}`,
  kind:'tls-errno-ordinary',request,
  stdin:overflow?'99999999999999999999999\n':'17\n',
  expected:{exitCode:0,stdout:overflow?'errno 2147483647 68 71\n':'errno 17 709 71\n',stderr:'stderr intact\n'},
  requiredSymbols:['__errno_location','strtol'],
 }))),
 ...['0','2'].flatMap(optimization=>[0,1,2,3,4].map(mode=>({
  id:`tls-gnu-exit-o${optimization}-${['return','exit','abort','immediate','quick'][mode]}`,
  kind:'tls-gnu-exit',request:{code:ordinaryGnuCode,language:'cpp',optimization,standard:'c++17',tls:true},
  run:{args:[String(mode)]},stdin:'',
  expected:{exitCode:[0,7,null,9,11][mode],trap:mode===2,
   stdout:`tls ordinary body 2 513 68 mode ${mode}\n`+(mode<2?'tls ordinary cleanup 516 0\nprocess registered after TLS 516\nprocess registered before TLS 516\nstatic cleanup 516\n':mode===4?'quick cleanup 0\n':''),stderr:''},
  requiredSymbols:['__cxa_thread_atexit','__errno_location','strtol'],
 }))),
]);
export const tlsRuntimeSharedCases=Object.freeze([
 ...['0','2'].map(optimization=>({id:`tls-inline-shared-o${optimization}`,kind:'tls-inline-shared',
  request:inlineRequest(optimization,true),run:{workerArguments:[[0,2],[1,2]],stackBytes:32768,timeoutMs:45000},
  requiredSymbols:['__cxa_thread_atexit'],
 })),
 ...variants(sharedErrnoCode).map(request=>({
  id:`tls-errno-shared-${request.language}-o${request.optimization}`,kind:'tls-errno-shared',
  request:{...request,atomics:true,sharedMemory:{entry:'run',initialPages:8,maximumPages:8,reservedBytes:131072}},
  run:{workerArguments:[[0,128],[1,128]],stackBytes:32768,timeoutMs:45000},
  requiredSymbols:['__errno_location','strtol'],
 })),
 ...['0','2'].map(optimization=>({
  id:`tls-gnu-shared-o${optimization}`,kind:'tls-gnu-shared',
  request:{code:sharedGnuCode,language:'cpp',optimization,standard:'c++17',tls:true,atomics:true,
   sharedMemory:{entry:'run',initialPages:32,maximumPages:32,reservedBytes:262144}},
  run:{workerArguments:[[0,2],[1,2]],stackBytes:65536,timeoutMs:45000},
  requiredSymbols:['__cxa_thread_atexit','__errno_location','strtol','malloc','free','sbrk'],
 })),
]);
export const tlsRuntimeCases=Object.freeze([...tlsRuntimeOrdinaryCases,...tlsRuntimeSharedCases]);
const check=(ok,message)=>{if(!ok)throw Error(message);};
export function assertTlsRuntimeOrdinaryResult(fixture,result) {
 const expected=fixture.expected;
 check(result.stdout===expected.stdout,fixture.id+': stdout mismatch');
 check(result.stderr===expected.stderr,fixture.id+': stderr mismatch');
 if(expected.trap)check(result.trap===true,fixture.id+': actual unreachable trap required');
 else check(result.exitCode===expected.exitCode,fixture.id+': exit status mismatch');
 return {exitCode:expected.exitCode,trap:expected.trap===true,exactStdout:true,exactStderr:true};
}
export function assertTlsRuntimeSharedResult(fixture,result) {
 const fail=message=>check(false,fixture.id+': '+message);
 if(!Array.isArray(result.values)||result.values.length!==2||result.values[0]!==result.values[1]||!Number.isSafeInteger(result.values[0])||result.values[0]<=0)fail('two equal output pointers required');
 if(!(result.memory instanceof Uint8Array)||!Array.isArray(result.tlsRegions)||result.tlsRegions.length!==2)fail('copied memory and TLS regions required');
 const pointer=result.values[0],size=fixture.kind==='tls-errno-shared'?48:fixture.kind==='tls-inline-shared'?72:4240;
 if(pointer%4||pointer+size>result.memory.byteLength)fail('output bounds');
 const view=new DataView(result.memory.buffer,result.memory.byteOffset+pointer,size),word=index=>view.getUint32(index*4,true);
 if(fixture.kind==='tls-errno-shared') {
  const addresses=[];
  for(let id=0;id<2;id++) {
   const offset=id*6,region=result.tlsRegions[id],address=word(offset);addresses.push(address);
   check(address===word(offset+1)&&address>=region.low&&address+4<=region.high,fixture.id+': actual libc errno TLS address');
   check(word(offset+2)===128&&word(offset+3)===0,fixture.id+': errno rounds');
   check(word(offset+4)===(id?17:2147483647)&&word(offset+5)===(id?701:68),fixture.id+': libc conversion result/errno');
  }
  check(addresses[0]!==addresses[1],fixture.id+': Worker errno objects alias');
  return {workers:2,errnoRoundsPerWorker:128,actualErrnoLocation:true};
 }
 if(fixture.kind==='tls-inline-shared') {
  const addresses=[];
  for(let id=0;id<2;id++) {
   const offset=id*9,region=result.tlsRegions[id],first=word(offset+4),second=word(offset+5);
   check(word(offset)===2&&word(offset+1)===2&&word(offset+2)===21&&word(offset+3)===20&&word(offset+8)===0,fixture.id+': inline initialization/cleanup must occur once');
   check(first===word(offset+6)&&second===word(offset+7)&&first!==second,fixture.id+': inline objects must coalesce across translation units');
   for(const address of [first,second])check(address>=region.low&&address+4<=region.high,fixture.id+': inline object TLS bounds');
   addresses.push(first,second);
  }
  check(new Set(addresses).size===4,fixture.id+': inline objects alias across Workers');
  return {workers:2,translationUnits:2,frontendObjectsPerWorker:2,destructorsPerWorker:2,exactLifo:true};
 }
 check(fixture.kind==='tls-gnu-shared','Unknown TLS runtime fixture');
 check(word(0)===0x544c5347&&word(1)===2&&word(2)===2112&&word(3)===513,fixture.id+': GNU output ABI');
 const expected=[512,9000,...Array.from({length:512},(_,i)=>511-i),10001,10000];
 const addresses=[];
 for(let id=0;id<2;id++) {
  const offset=4+id*528,region=result.tlsRegions[id],address=word(offset+2);addresses.push(address);
  check(word(offset)===0&&word(offset+1)===id,fixture.id+': guest allocator checks');
  check(address===word(offset+3)&&address>=region.low&&address+4<=region.high,fixture.id+': GNU errno address');
  check(word(offset+4)===2&&word(offset+5)===516&&word(offset+6)===513,fixture.id+': GNU allocated registration/cleanup counts');
  check(word(offset+7)===64&&word(offset+8)===32&&word(offset+11)===48,fixture.id+': real allocator/fixed-memory ENOMEM');
  check(word(offset+9)===(id?0:68)&&word(offset+10)===(id?701:0),fixture.id+': conversion errno');
  expected.forEach((value,i)=>check(word(offset+12+i)===value,fixture.id+': GNU cleanup LIFO order at '+i));
 }
 check(addresses[0]!==addresses[1],fixture.id+': Worker errno objects alias');
 return {workers:2,allocationsPerWorker:4096,directRegistrationsPerWorker:513,frontendObjectsPerWorker:2,destructorsPerWorker:516,registrationDuringCleanup:true,exactLifo:true};
}
