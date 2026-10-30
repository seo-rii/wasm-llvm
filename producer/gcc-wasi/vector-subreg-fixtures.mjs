// Partial memcpy read/write must keep the surrounding bytes of a v128 local.
// These fixtures use no header intrinsics, independently covering the target's
// scalar SUBREG legalization at both optimization levels.
export const cases = [];
const types = [['u8','uint8_t',1],['u16','uint16_t',2],['u32','uint32_t',4],['u64','uint64_t',8],['f32','float',4],['f64','double',8]];
for (const [name,type,size] of types) for (const language of ['c','cpp']) for (const optimization of ['0','2']) {
  const bytes=Buffer.from(Array.from({length:16},(_,i)=>i+17));
  for(const [offset,value]of[[0,3],[16-size,4]]) {
    if(name==='f32')bytes.writeFloatLE(value,offset);
    else if(name==='f64')bytes.writeDoubleLE(value,offset);
    else for(let i=0;i<size;i++)bytes[offset+i]=Number((BigInt(value)>>BigInt(8*i))&255n);
  }
  cases.push({id:`vector-subreg-${name}-${language}-o${optimization}`,features:['simd128','scalar-vector-subreg','partial-memcpy','preserve-other-lanes'],interop:false,signatures:{},
    request:{language,standard:language==='cpp'?'gnu++17':'gnu11',optimization,simd:true,emit:'executable',code:`
#include <stdio.h>
#include <stdint.h>
#include <string.h>
typedef int32_t V __attribute__((vector_size(16)));
typedef ${type} S;
__attribute__((noinline)) static V write_lanes(V value,S first,S last) {
  memcpy(&value,&first,sizeof(first));
  memcpy((unsigned char*)&value+16-sizeof(last),&last,sizeof(last));
  return value;
}
__attribute__((noinline)) static S read_first(V value) { S scalar;memcpy(&scalar,&value,sizeof(scalar));return scalar; }
__attribute__((noinline)) static S read_last(V value) { S scalar;memcpy(&scalar,(unsigned char*)&value+16-sizeof(scalar),sizeof(scalar));return scalar; }
static V (*volatile write_values)(V,S,S)=write_lanes;
static S (*volatile first_value)(V)=read_first;
static S (*volatile last_value)(V)=read_last;
int main(void) { unsigned n;if(scanf("%u",&n)!=1||n!=3)return 2;
  unsigned char raw[16];for(unsigned i=0;i<16;i++)raw[i]=(unsigned char)(i+17);
  V original;memcpy(&original,raw,16);V result=write_values(original,(S)n,(S)(n+1));
  memcpy(raw,&result,16);for(unsigned i=0;i<16;i++)printf("%02x",raw[i]);
  printf(" %d %d\\n",first_value(result)==(S)n,last_value(result)==(S)(n+1));return 0;
}
`},stdin:'3\n',stdout:bytes.toString('hex')+' 1 1\n'});
}
