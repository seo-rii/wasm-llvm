// Source-level GCC __int128 builtins. GCC spelling is always compiled by GCC.
// Explicit portable Clang oracle programs are separate test inputs, never a GCC fallback.
// Independent BigInt expectations cover only defined zero/overflow/shift conditions.
const profiles=[];
const add=(id,body,extra={})=>profiles.push({id,body,...extra});
const UMAX=(1n<<128n)-1n;
const u=value=>{value=BigInt.asUintN(128,value);return `(((U)0x${(value>>64n).toString(16)}ULL<<64)|(U)0x${(value&((1n<<64n)-1n)).toString(16)}ULL)`;};
const signed=value=>value===-(1n<<127n)?'(-((I)(((U)1<<127)-1))-1)':value<0n?`(-((I)${u(-value)}))`:`((I)${u(value)})`;
const input=[0n,1n,2n,1n<<31n,1n<<63n,1n<<64n,(1n<<100n)+8n,1n<<127n,UMAX,0xfedcba98765432100123456789abcdefn];
const lead=value=>value===0n?128:128-value.toString(2).length;
const trail=value=>{if(!value)return 128;let n=0;while(!(value&1n)){value>>=1n;n++;}return n;};
const ones=value=>value.toString(2).replaceAll('0','').length;
const common=`#include <stdio.h>\ntypedef unsigned __int128 U;typedef __int128 I;\n`;
const values=`static volatile U values[]={${input.map(u).join(',')}};\n`;
const reference=`static int ref_clz(U x){int n=0;for(int bit=127;bit>=0;--bit){if((x>>bit)&1)break;++n;}return n;}
static int ref_ctz(U x){int n=0;while(n<128&&!(x&1)){++n;x>>=1;}return n;}
static int ref_pop(U x){int n=0;while(x){n+=(unsigned)(x&1);x>>=1;}return n;}
static int ref_sign(I x){U bits=(U)x;unsigned sign=(unsigned)(bits>>127);int n=0;for(int bit=126;bit>=0;--bit){if(((bits>>bit)&1)!=sign)break;++n;}return n;}
`;
const checks=(name,expression,expected,{oracle,features=[]}={})=>{
 const body=values+`__attribute__((noinline)) static int operation(U x){return ${expression};}
int main(void){unsigned token;if(scanf("%u",&token)!=1||token!=7)return 1;const int expected[]={${expected.join(',')}};
 for(unsigned k=0;k<sizeof(values)/sizeof(values[0]);++k){U value=values[k];if(operation(value)!=expected[k])return 10+k;}
 puts("wide builtin ok");return 0;}\n`;
 add(name,body,{stdin:'7\n',stdout:'wide builtin ok\n',features,oracleBody:oracle?reference+body.replace(expression,oracle):undefined});
};
checks('clzg-defined-zero','__builtin_clzg(x,128)',input.map(lead),{features:['clzg','defined-zero-fallback','variable-input']});
checks('ctzg-defined-zero','__builtin_ctzg(x,128)',input.map(trail),{features:['ctzg','defined-zero-fallback','variable-input']});
checks('popcountg','__builtin_popcountg(x)',input.map(ones),{features:['popcountg','variable-input']});
checks('parityg','__builtin_parityg(x)',input.map(v=>ones(v)&1),{oracle:'ref_pop(x)&1',features:['parityg','variable-input','portable-clang-reference']});
checks('ffsg','__builtin_ffsg((I)x)',input.map(v=>v===0n?0:trail(v)+1),{oracle:'x==0?0:ref_ctz(x)+1',features:['ffsg','variable-input','portable-clang-reference']});
const signedValues=[0n,-1n,1n,-2n,1n<<63n,-(1n<<63n),1n<<64n,-(1n<<100n),(1n<<127n)-1n,-(1n<<127n)];
const redundant=value=>{const bits=BigInt.asUintN(128,value),sign=(bits>>127n)&1n;let n=0;for(let bit=126n;bit>=0n;--bit){if(((bits>>bit)&1n)!==sign)break;n++;}return n;};
const signBody=`static volatile I values[]={${signedValues.map(signed).join(',')}};
__attribute__((noinline)) static int operation(I x){return __builtin_clrsbg(x);}
int main(void){unsigned token;if(scanf("%u",&token)!=1||token!=7)return 1;const int expected[]={${signedValues.map(redundant).join(',')}};
 for(unsigned k=0;k<sizeof(values)/sizeof(values[0]);++k){I value=values[k];if(operation(value)!=expected[k])return 10+k;}
 puts("wide sign count ok");return 0;}
`;
add('clrsbg',signBody,{oracleBody:reference+signBody.replace('__builtin_clrsbg(x)','ref_sign(x)'),stdin:'7\n',stdout:'wide sign count ok\n',features:['clrsbg','zero','negative-one','signed-extremes','no-required-clrsbti2-assumption']});
add('constant-folding',`static volatile I maximum=(I)(((U)1<<127)-1),scale=(I)1<<100;
int main(void){
 if(__builtin_clzg((U)0,73)!=73||__builtin_ctzg((U)0,91)!=91)return 1;
 if(__builtin_clzg((U)1<<100)!=27||__builtin_ctzg((U)1<<100)!=100)return 2;
 if(__builtin_popcountg(~(U)0)!=128||__builtin_parityg(((U)1<<127)|1)!=0)return 3;
 if(__builtin_clrsbg((I)0)!=127||__builtin_clrsbg((I)-1)!=127||__builtin_ffsg((I)0)!=0)return 4;
 I max=maximum,wide=scale;
 if(!__builtin_add_overflow_p(max,(I)1,(I)0)||__builtin_sub_overflow_p(wide,(I)7,(I)0)||__builtin_mul_overflow_p(wide,(I)7,(I)0))return 5;
 puts("wide constants ok");return 0;}
`,{clang:false,clangReason:'This constant profile combines GCC-specific builtin spellings; no Clang result is claimed.',stdout:'wide constants ok\n',features:['constant-input','zero-fallback','constant-folding','overflow-p-variable-input']});
const bswap=value=>{let r=0n;for(let k=0;k<16;k++){r=(r<<8n)|(value&255n);value>>=8n;}return r;};
const swapBody=values+`__attribute__((noinline)) static U operation(U x){return __builtin_bswap128(x);}
int main(void){const U expected[]={${input.map(v=>u(bswap(v))).join(',')}};
 for(unsigned k=0;k<sizeof(values)/sizeof(values[0]);++k){U value=values[k];if(operation(value)!=expected[k])return 10+k;}
 puts("wide swap ok");return 0;}
`;
add('bswap128',swapBody,{oracleBody:`static U ref_swap(U x){U r=0;for(int k=0;k<16;k++){r=(r<<8)|(x&255);x>>=8;}return r;}\n`+swapBody.replace('__builtin_bswap128(x)','ref_swap(x)'),stdout:'wide swap ok\n',features:['bswap128','word-order','actual-bswap-helper-resolution']});
add('overflow-builtins',`static volatile I maximum=(I)(((U)1<<127)-1),minimum=-((I)(((U)1<<127)-1))-1;
static volatile U all=~(U)0;static volatile I scale=(I)1<<100;
int main(void){I s;U u;I max=maximum,min=minimum,wide=scale;U top=all;
 int a=__builtin_add_overflow(max,(I)1,&s)&&s==min;
 int b=__builtin_sub_overflow(min,(I)1,&s)&&s==max;
 int c=__builtin_mul_overflow(min,(I)-1,&s)&&s==min;
 int d=!__builtin_mul_overflow(wide,(I)7,&s)&&s==((I)7<<100);
 int e=__builtin_add_overflow(top,(U)7,&u)&&u==6;
 int f=__builtin_sub_overflow((U)0,top,&u)&&u==1;
 int g=__builtin_mul_overflow(top,(U)2,&u)&&u==top-1;
 printf("%d %d %d %d %d %d %d\\n",a,b,c,d,e,f,g);return 0;}
`,{stdout:'1 1 1 1 1 1 1\n',features:['add-overflow','sub-overflow','mul-overflow','defined-builtin-result','variable-input']});
const stdcBody=values+`__attribute__((noinline)) static unsigned width(U x){return __builtin_stdc_bit_width(x);}
__attribute__((noinline)) static unsigned count(U x){return __builtin_stdc_count_ones(x);}
__attribute__((noinline)) static U floor_value(U x){return __builtin_stdc_bit_floor(x);}
int main(void){const unsigned widths[]={${input.map(v=>128-lead(v)).join(',')}};const unsigned counts[]={${input.map(ones).join(',')}};
 const U floors[]={${input.map(v=>u(v===0n?0n:1n<<BigInt(v.toString(2).length-1))).join(',')}};
 for(unsigned k=0;k<sizeof(values)/sizeof(values[0]);++k){U x=values[k];if(width(x)!=widths[k]||count(x)!=counts[k]||floor_value(x)!=floors[k])return 10+k;
  if(__builtin_stdc_count_zeros(x)!=128-counts[k]||__builtin_stdc_has_single_bit(x)!=(counts[k]==1))return 30+k;
  unsigned leading=__builtin_clzg(x,128),trailing=__builtin_ctzg(x,128);
  if(__builtin_stdc_leading_zeros(x)!=leading||__builtin_stdc_trailing_zeros(x)!=trailing)return 50+k;
  if(__builtin_stdc_leading_ones(x)!=(unsigned)__builtin_clzg((U)~x,128)||__builtin_stdc_trailing_ones(x)!=(unsigned)__builtin_ctzg((U)~x,128))return 70+k;
  if(__builtin_stdc_first_leading_one(x)!=(leading==128?0:leading+1)||__builtin_stdc_first_trailing_one(x)!=(trailing==128?0:trailing+1))return 90+k;
  unsigned inverse_leading=__builtin_clzg((U)~x,128),inverse_trailing=__builtin_ctzg((U)~x,128);
  if(__builtin_stdc_first_leading_zero(x)!=(inverse_leading==128?0:inverse_leading+1)||__builtin_stdc_first_trailing_zero(x)!=(inverse_trailing==128?0:inverse_trailing+1))return 110+k;
  if(x<=((U)1<<127)){U ceil=__builtin_stdc_bit_ceil(x);U expected=x<=1?1:(U)1<<(128-__builtin_clzg(x-1));if(ceil!=expected)return 130+k;}
 }
 puts("wide stdc bits ok");return 0;}
`;
const stdcOracle=reference+`static U ref_ceil(U x){return x<=1?1:(U)1<<(128-ref_clz(x-1));}
static unsigned ref_first_leading(U x){return x?ref_clz(x)+1:0;}
static unsigned ref_first_trailing(U x){return x?ref_ctz(x)+1:0;}
`+stdcBody
 .replaceAll('__builtin_stdc_bit_width(x)','128-ref_clz(x)').replaceAll('__builtin_stdc_count_ones(x)','ref_pop(x)')
 .replaceAll('__builtin_stdc_bit_floor(x)','x==0?0:(U)1<<(127-ref_clz(x))').replaceAll('__builtin_stdc_count_zeros(x)','128-ref_pop(x)')
 .replaceAll('__builtin_stdc_has_single_bit(x)','(ref_pop(x)==1)').replaceAll('__builtin_stdc_leading_zeros(x)','ref_clz(x)').replaceAll('__builtin_stdc_trailing_zeros(x)','ref_ctz(x)')
 .replaceAll('__builtin_stdc_leading_ones(x)','ref_clz((U)~x)').replaceAll('__builtin_stdc_trailing_ones(x)','ref_ctz((U)~x)')
 .replaceAll('__builtin_stdc_first_leading_one(x)','ref_first_leading(x)').replaceAll('__builtin_stdc_first_trailing_one(x)','ref_first_trailing(x)')
 .replaceAll('__builtin_stdc_first_leading_zero(x)','ref_first_leading((U)~x)').replaceAll('__builtin_stdc_first_trailing_zero(x)','ref_first_trailing((U)~x)')
 .replaceAll('__builtin_stdc_bit_ceil(x)','ref_ceil(x)').replaceAll('__builtin_clzg','ref_clz').replaceAll('__builtin_ctzg','ref_ctz')
 .replaceAll('ref_clz(x,128)','ref_clz(x)').replaceAll('ref_ctz(x,128)','ref_ctz(x)').replaceAll('ref_clz((U)~x,128)','ref_clz((U)~x)').replaceAll('ref_ctz((U)~x,128)','ref_ctz((U)~x)');
add('stdc-bit-operations',stdcBody,{oracleBody:stdcOracle,stdout:'wide stdc bits ok\n',features:['c-only-stdc-bit-functions','defined-zero-results','representable-bit-ceil','variable-input']});
const pattern=0xfedcba98765432100123456789abcdefn,rotations=[0,1,31,63,64,65,100,127,128,129,255];
const rotate=(value,n)=>{n=BigInt(n%128);return BigInt.asUintN(128,(value<<n)|(value>>((128n-n)%128n)));};
const rotateBody=`static volatile U pattern=${u(pattern)};static volatile unsigned rotations[]={${rotations.join(',')}};
__attribute__((noinline)) static U operation(U x,unsigned n){return __builtin_stdc_rotate_left(x,n);}
int main(void){const U expected[]={${rotations.map(n=>u(rotate(pattern,n))).join(',')}};const U right_expected[]={${rotations.map(n=>u(rotate(pattern,128-(n%128)))).join(',')}};
 for(unsigned k=0;k<sizeof(rotations)/sizeof(rotations[0]);++k){U x=pattern;unsigned n=rotations[k];if(operation(x,n)!=expected[k]||__builtin_stdc_rotate_right(x,n)!=right_expected[k])return 10+k;}
 U side=pattern;unsigned n=65;U r=__builtin_stdc_rotate_left(side++,n++);
 if(r!=expected[5]||side!=pattern+1||n!=66)return 50;
 side=pattern;n=65;r=__builtin_stdc_rotate_right(side++,n++);if(r!=right_expected[5]||side!=pattern+1||n!=66)return 51;
 puts("wide rotation ok");return 0;}
`;
add('stdc-rotate',rotateBody,{oracleBody:`static U ref_rotate(U x,unsigned n){n%=128;return n?(x<<n)|(x>>(128-n)):x;}
static U ref_right(U x,unsigned n){n%=128;return n?(x>>n)|(x<<(128-n)):x;}\n`+rotateBody.replaceAll('__builtin_stdc_rotate_left','ref_rotate').replaceAll('__builtin_stdc_rotate_right','ref_right'),stdout:'wide rotation ok\n',features:['c-only-stdc-rotate','modulo-width-counts','single-evaluation']});
// The provider source is genuinely compiled independently in all four ABI directions.
const header='typedef unsigned __int128 U;\n#ifdef __cplusplus\nextern "C" {\n#endif\nint wide_pop(U);int wide_clz(U);\n#ifdef __cplusplus\n}\n#endif\n';
add('builtin-provider-abi',`#include "wide-builtin.h"
static int(*volatile pop)(U)=wide_pop;static int(*volatile clz)(U)=wide_clz;
int main(void){U x=((U)1<<100)|((U)1<<64)|7;
 printf("%d %d %d %d\\n",wide_pop(x),pop(x),wide_clz(x),clz(x));return 0;}
`,{stdout:'5 5 27 27\n',interop:true,files:[{path:'wide-builtin.h',contents:header},{path:'provider.c',contents:'#include "wide-builtin.h"\n__attribute__((noinline)) int wide_pop(U x){return __builtin_popcountg(x);}\n__attribute__((noinline)) int wide_clz(U x){return __builtin_clzg(x,128);}\n'}],sources:['provider.c'],signatures:{wide_pop:{params:['i64','i64'],results:['i32']},wide_clz:{params:['i64','i64'],results:['i32']}},features:['builtin-helper-abi','multi-tu','direct-and-indirect-calls']});
export const cases=profiles.flatMap(profile=>['0','2'].map(optimization=>({
 id:`wide-builtin-${profile.id}-o${optimization}`,features:profile.features||[],interop:Boolean(profile.interop),printscan:false,stdcpp:false,signatures:profile.signatures||{},
 clang:profile.clang!==false,...(profile.clangReason?{clangReason:profile.clangReason}:{}),
 oracleKind:profile.oracleBody?(profile.oracleKind||'explicit-portable-clang-reference'):'same-source-clang',
 ...(profile.oracleBody?{oracle:{code:common+profile.oracleBody}}:{}),
 request:{language:'c',standard:'gnu11',optimization,emit:'executable',simd:false,defines:['ONLINE_JUDGE=1'],code:'#ifndef ONLINE_JUDGE\n#error missing real macro option\n#endif\n'+common+profile.body,...(profile.files?{files:profile.files,sources:profile.sources}:{})},stdin:profile.stdin||'',stdout:profile.stdout,
})));
