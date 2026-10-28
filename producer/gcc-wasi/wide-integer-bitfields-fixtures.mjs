// Wide GNU bitfields. Layout expectations are explicit little-endian Wasm ABI
// observations, compared with the pinned Clang. Padding bytes are never asserted.
const profiles=[];
const add=(id,body,extra={})=>profiles.push({id,body,...extra});
const mask=bits=>(1n<<BigInt(bits))-1n;
const u=value=>{value=BigInt.asUintN(128,value);return `(((U)0x${(value>>64n).toString(16)}ULL<<64)|(U)0x${(value&mask(64)).toString(16)}ULL)`;};
const words=(name,value,count=2)=>Array.from({length:count},(_,index)=>`${name}[${index}]==0x${((value>>BigInt(index*64))&mask(64)).toString(16)}ULL`).join('&&');
const common=`#include <stdio.h>\n#include <stddef.h>\n#include <stdint.h>\n#include <string.h>\n#include <stdlib.h>\ntypedef unsigned __int128 U;typedef __int128 I;\n#ifdef __cplusplus\n#define WIDE_ALIGNOF(T) alignof(T)\n#else\n#define WIDE_ALIGNOF(T) _Alignof(T)\n#endif\n`;
const low61=mask(61),middle19=(1n<<18n)+7n,high48=0x123456789abcn;
add('unsigned-cross64',`struct Bits{U low:61;U middle:19;U high:48;};
static volatile struct Bits value={${u(low61)},3,${u(high48)}};
int main(void){unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;
 value.middle=((U)1<<18)+n;struct Bits copy;copy.low=value.low;copy.middle=value.middle;copy.high=value.high;
 unsigned long long raw[2];memcpy(raw,&copy,16);
 printf("%d %d %d %d %d %d\\n",sizeof(copy)==16,WIDE_ALIGNOF(struct Bits)==16,
   value.low==${u(low61)},value.middle==${u(middle19)},value.high==${u(high48)},${words('raw',low61|(middle19<<61n)|(high48<<80n))});return 0;}
`,{stdin:'7\n',stdout:'1 1 1 1 1 1\n',features:['unsigned-bitfields','cross64','neighbor-preservation','exact-128-named-bits']});
const negative65=-(1n<<64n)+14n,low32=0xdeadbeefn,high31=0x76543210n;
add('signed65',`struct Bits{U low:32;I middle:65;U high:31;};
static volatile struct Bits value={0xdeadbeef,-((I)1<<64)+7,0x76543210};
int main(void){unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;value.middle+=n;
 I got=value.middle;struct Bits copy;copy.low=value.low;copy.middle=value.middle;copy.high=value.high;
 unsigned long long raw[2];memcpy(raw,&copy,16);
 printf("%d %d %d %d %d %d\\n",sizeof(copy)==16,got==-((I)1<<64)+14,got<0,
  value.low==0xdeadbeef,value.high==0x76543210,${words('raw',low32|(BigInt.asUintN(65,negative65)<<32n)|(high31<<97n))});return 0;}
`,{stdin:'7\n',stdout:'1 1 1 1 1 1\n',features:['signed65','sign-extension','cross64','compound-update','neighbor-preservation']});
const final127=(1n<<100n)+7n;
add('unsigned127',`struct Bits{U neighbor:1;U wide:127;};static volatile struct Bits value={1,((U)1<<126)+7};
int main(void){value.wide^=(U)1<<100;value.wide+=(U)1<<126;
 U got=value.wide;struct Bits copy;copy.neighbor=value.neighbor;copy.wide=value.wide;
 unsigned long long raw[2];memcpy(raw,&copy,16);
 printf("%d %d %d %d\\n",sizeof(copy)==16,value.neighbor==1,got==((U)1<<100)+7,${words('raw',1n|(final127<<1n))});return 0;}
`,{stdout:'1 1 1 1\n',features:['unsigned127','defined-truncation-to-field-width','compound-xor','neighbor-preservation']});
const packedMiddle=-(1n<<70n)+44n,packedRight=0x123456789abcn;
const packedBits=0x12an|(BigInt.asUintN(73,packedMiddle)<<9n)|(packedRight<<82n);
const packedBytes=Array.from({length:16},(_,index)=>Number((packedBits>>BigInt(index*8))&255n));
add('packed-unaligned73',`struct __attribute__((packed)) Packed{unsigned char before;U left:9;I middle:73;U right:46;unsigned char after;};
int main(void){unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;
 unsigned char *allocation=(unsigned char*)malloc(sizeof(struct Packed)+3);if(!allocation)return 2;
 struct Packed *value=(struct Packed*)(allocation+3);memset(value,0,sizeof(*value));
 value->before=0x5a;value->left=0x12a;value->middle=-((I)1<<70)+37;value->right=0x123456789abcULL;value->after=0xc3;value->middle+=n;
 unsigned char raw[sizeof(*value)];memcpy(raw,value,sizeof(*value));const unsigned char expected[16]={${packedBytes.join(',')}};int bytes=1;
 for(unsigned k=0;k<16;++k)if(raw[1+k]!=expected[k])bytes=0;
 printf("%d %d %d %d %d %d %d %d\\n",sizeof(*value)==18,WIDE_ALIGNOF(struct Packed)==1,offsetof(struct Packed,after)==17,
  value->before==0x5a&&value->after==0xc3,value->left==0x12a,value->middle==-((I)1<<70)+44,
  value->right==0x123456789abcULL,bytes);free(allocation);return 0;}
`,{stdin:'7\n',stdout:'1 1 1 1 1 1 1 1\n',features:['packed','unaligned-memory','signed73','cross64','neighbor-preservation','byte-layout']});
const a100=(1n<<99n)+0x1234567n,b100=((1n<<98n)+0xfedcba98n)^((1n<<70n)+7n),c56=0xabcdef01234567n;
add('packed-cross128',`struct __attribute__((packed)) Bits{U a:100;U b:100;U c:56;};
static volatile struct Bits value={${u(a100)},${u((1n<<98n)+0xfedcba98n)},0xabcdef01234567ULL};
int main(void){value.b^=((U)1<<70)+7;struct Bits copy;copy.a=value.a;copy.b=value.b;copy.c=value.c;
 unsigned long long raw[4];memcpy(raw,&copy,32);
 printf("%d %d %d %d %d %d\\n",sizeof(copy)==32,WIDE_ALIGNOF(struct Bits)==1,value.a==${u(a100)},value.b==${u(b100)},
 value.c==0xabcdef01234567ULL,${words('raw',a100|(b100<<100n)|(c56<<200n),4)});return 0;}
`,{stdout:'1 1 1 1 1 1\n',features:['packed','100-bit-fields','cross64','cross128-storage-boundary','neighbor-preservation']});
add('aligned32',`struct __attribute__((aligned(32))) Bits{U low:61;I middle:19;U high:48;};
static volatile struct Bits value={${u(low61)},-13,${u(high48)}};
int main(void){unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;value.middle+=n;
 printf("%d %d %d %d %d\\n",sizeof(struct Bits)==32,WIDE_ALIGNOF(struct Bits)==32,value.low==${u(low61)},value.middle==-6,value.high==${u(high48)});return 0;}
`,{stdin:'7\n',stdout:'1 1 1 1 1\n',features:['aligned32','signed-cross64','named-neighbors-only','no-padding-byte-assumption']});
add('union-word-views',`union Bits{struct{U low:64;I high:64;} fields;U raw;};
static volatile U input=((U)0x8000000000000000ULL<<64)|0x123456789abcdef0ULL;
int main(void){union Bits value;value.raw=input;I before=value.fields.high;value.fields.low=0xfedcba9876543210ULL;
 printf("%d %d %d %d %d\\n",sizeof(value)==16,before==-((I)1<<63),value.fields.high==before,
  value.fields.low==0xfedcba9876543210ULL,value.raw==(((U)0x8000000000000000ULL<<64)|0xfedcba9876543210ULL));return 0;}
`,{stdout:'1 1 1 1 1\n',features:['gnu-union-type-punning','64-bit-fields','sign-extension','neighbor-preservation']});
add('cpp-members',`struct Bits{volatile U low:32;volatile I middle:65;volatile U high:31;
 void bump(I n){middle+=n;} I read()const{return middle;}};
int main(){unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;Bits value;value.low=0xdeadbeef;value.middle=-((I)1<<64)+7;value.high=0x76543210;
 value.bump(n);Bits copy=value;
 printf("%d %d %d %d %d\\n",sizeof(Bits)==16,value.read()==-((I)1<<64)+14,copy.read()==value.read(),copy.low==0xdeadbeef,copy.high==0x76543210);return 0;}
`,{language:'cpp',stdin:'7\n',stdout:'1 1 1 1 1\n',features:['cpp','volatile-bitfield-members','copy','member-call','signed65']});
const layoutControls=`struct NamedInt{unsigned char before;unsigned int field:5;unsigned char after;};
struct NamedShort{unsigned char before;unsigned short field:5;unsigned char after;};
struct Unnamed{unsigned char before;U:17;unsigned char after;};
struct ZeroWidth{unsigned char before;U:0;unsigned char after;};
struct Mixed{unsigned char before;U:17;unsigned int named:5;unsigned char after;};
struct Boundary{unsigned int a:31;unsigned int b:2;};
struct __attribute__((packed)) PackedBoundary{unsigned char before;unsigned int a:31;unsigned int b:2;unsigned char after;};
int main(void){struct Boundary boundary={0x7fffffff,3};unsigned raw[2]={0};memcpy(raw,&boundary,sizeof boundary<sizeof raw?sizeof boundary:sizeof raw);
 printf("%d %d %d %d %d %d %d\\n",
 sizeof(struct NamedInt)==4&&WIDE_ALIGNOF(struct NamedInt)==4&&offsetof(struct NamedInt,after)==2,
 sizeof(struct NamedShort)==4&&WIDE_ALIGNOF(struct NamedShort)==2&&offsetof(struct NamedShort,after)==2,
 sizeof(struct Unnamed)==5&&WIDE_ALIGNOF(struct Unnamed)==1&&offsetof(struct Unnamed,after)==4,
 sizeof(struct ZeroWidth)==17&&WIDE_ALIGNOF(struct ZeroWidth)==1&&offsetof(struct ZeroWidth,after)==16,
 sizeof(struct Mixed)==8&&WIDE_ALIGNOF(struct Mixed)==4&&offsetof(struct Mixed,after)==4,
 sizeof(struct Boundary)==8&&WIDE_ALIGNOF(struct Boundary)==4&&(raw[0]&0x7fffffff)==0x7fffffff&&(raw[1]&3)==3,
 sizeof(struct PackedBoundary)==7&&WIDE_ALIGNOF(struct PackedBoundary)==1&&offsetof(struct PackedBoundary,after)==6);return 0;}
`;
for(const language of ['c','cpp'])add('layout-controls-'+language,layoutControls,{language,stdout:'1 1 1 1 1 1 1\n',features:['named-int-alignment','named-short-alignment','unnamed-type-does-not-align-record','zero-width-boundary','storage-unit-boundary','packed-boundary','basic-c-abi']});
const nestedHeader=`typedef unsigned __int128 U;typedef struct{U low:61;U middle:19;U high:48;} Bits;
typedef struct{unsigned char before;Bits bits;unsigned char after;} Nested;
void bf_nested_store(Nested*,unsigned);int bf_nested_check(const Nested*,unsigned);
`;
add('abi-nested',`#include "wide-nested.h"
static void(*volatile store)(Nested*,unsigned)=bf_nested_store;
static int(*volatile check)(const Nested*,unsigned)=bf_nested_check;
static int local(const Nested*x,unsigned n){return x->before==0x5a&&x->bits.low==7&&x->bits.middle==n&&x->bits.high==0x123456789abcULL&&x->after==0xc3;}
int main(void){unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;
 union{Nested value;U alignment;unsigned char bytes[96];} allocation;memset(&allocation,0,sizeof allocation);
 bf_nested_store(&allocation.value,n);int a=local(&allocation.value,n);
 memset(&allocation,0,sizeof allocation);store(&allocation.value,n);int b=local(&allocation.value,n);
 memset(&allocation,0,sizeof allocation);allocation.value.before=0x5a;allocation.value.bits.low=7;allocation.value.bits.middle=n;allocation.value.bits.high=0x123456789abcULL;allocation.value.after=0xc3;
 printf("%d %d %d %d\\n",a,b,bf_nested_check(&allocation.value,n),check(&allocation.value,n));return 0;}
`,{stdin:'7\n',stdout:'1 1 1 1\n',interop:true,files:[{path:'wide-nested.h',contents:nestedHeader},{path:'provider.c',contents:`#include "wide-nested.h"
__attribute__((noinline)) void bf_nested_store(Nested*x,unsigned n){x->before=0x5a;x->bits.low=7;x->bits.middle=n;x->bits.high=0x123456789abcULL;x->after=0xc3;}
__attribute__((noinline)) int bf_nested_check(const Nested*x,unsigned n){return x->before==0x5a&&x->bits.low==7&&x->bits.middle==n&&x->bits.high==0x123456789abcULL&&x->after==0xc3;}
`}],sources:['provider.c'],signatures:{bf_nested_store:{params:['i32','i32'],results:[]},bf_nested_check:{params:['i32','i32'],results:['i32']}},features:['nested-bitfield-record','pointer-abi','multi-tu','direct-and-indirect','no-clang-layout-assumption','zeroed-oversized-storage']});
for(const shape of [
 {id:'ordinary',decl:'typedef struct{U low:32;I middle:65;U high:31;} Box;'},
 {id:'packed',decl:'typedef struct __attribute__((packed)){unsigned char before;U low:9;I middle:73;U high:46;unsigned char after;} Box;',packed:true},
 {id:'aligned',decl:'typedef struct __attribute__((aligned(32))){U low:32;I middle:65;U high:31;} Box;'},
]){
 const header=`typedef unsigned __int128 U;typedef __int128 I;\n${shape.decl}\nBox bf_make(int);Box bf_change(Box);I bf_read(Box);Box bf_invoke(Box,Box(*)(Box));\n`;
 const low=shape.packed?'0x12a':'0xdeadbeef',high=shape.packed?'0x123456789abcULL':'0x76543210';
 add('abi-'+shape.id,`#include "wide-bitfield.h"
static Box callback(Box x){x.middle+=7;return x;}static Box(*volatile make_ptr)(int)=bf_make;static I(*volatile read_ptr)(Box)=bf_read;
int main(void){int n;if(scanf("%d",&n)!=1||n!=7)return 1;Box a=bf_make(n),b=make_ptr(n),c=bf_change(a),d=bf_invoke(b,callback);
 if(a.middle!=-((I)1<<64)+7||b.middle!=a.middle||c.middle!=a.middle+7||d.middle!=c.middle)return 2;
 if(bf_read(c)!=c.middle||read_ptr(d)!=d.middle)return 3;
 if(a.low!=${low}||b.low!=${low}||c.low!=${low}||d.low!=${low})return 4;
 if(a.high!=${high}||d.high!=${high})return 5;
 ${shape.packed?'if(a.before!=0x5a||d.before!=0x5a||a.after!=0xc3||d.after!=0xc3)return 6;':''}
 puts("wide bitfield ABI ok");return 0;}
`,{stdin:'7\n',stdout:'wide bitfield ABI ok\n',interop:true,files:[{path:'wide-bitfield.h',contents:header},{path:'provider.c',contents:`#include "wide-bitfield.h"\n__attribute__((noinline)) Box bf_make(int n){Box x;x.low=${low};x.middle=-((I)1<<64)+n;x.high=${high};${shape.packed?'x.before=0x5a;x.after=0xc3;':''}return x;}
__attribute__((noinline)) Box bf_change(Box x){x.middle+=7;return x;}
__attribute__((noinline)) I bf_read(Box x){return x.middle;}
__attribute__((noinline)) Box bf_invoke(Box x,Box(*f)(Box)){return f(x);}
`}],sources:['provider.c'],signatures:{bf_make:{params:['i32','i32'],results:[]},bf_change:{params:['i32','i32'],results:[]},bf_read:{params:['i32','i32'],results:[]},bf_invoke:{params:['i32','i32','i32'],results:[]}},features:['bitfield-abi',shape.id,'multi-tu','direct','indirect','callback']});
}
export const cases=profiles.flatMap(profile=>['0','2'].map(optimization=>({
 id:`wide-bitfield-${profile.id}-o${optimization}`,features:profile.features,interop:Boolean(profile.interop),printscan:false,stdcpp:false,signatures:profile.signatures||{},oracleKind:'same-source-clang',
 request:{language:profile.language||'c',standard:profile.language==='cpp'?'gnu++17':'gnu11',optimization,emit:'executable',simd:false,defines:['ONLINE_JUDGE=1'],code:'#ifndef ONLINE_JUDGE\n#error missing real macro option\n#endif\n'+common+profile.body,...(profile.files?{files:profile.files,sources:profile.sources}:{})},stdin:profile.stdin||'',stdout:profile.stdout,
})));
