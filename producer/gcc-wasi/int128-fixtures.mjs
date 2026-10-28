// Real signed/unsigned __int128 programs, shared by native GCC/Clang and the
// actual wasm-idle Chromium compiler harness. Integer reference literals below
// are generated with independent JavaScript BigInt arithmetic, not by executing
// or translating submitted source. Signed overflow/division by zero and shifts
// outside 0..127 are excluded. Unsigned arithmetic deliberately wraps modulo2^128.
const profiles = [];
const add = (id, code, extra = {}) => profiles.push({ id, code, ...extra });
const types = 'typedef __int128 I; typedef unsigned __int128 U;\n';
const u = value => {
  const wrapped = BigInt.asUintN(128, value);
  return `(((U)0x${(wrapped >> 64n).toString(16)}ULL<<64)|(U)0x${(wrapped & ((1n<<64n)-1n)).toString(16)}ULL)`;
};
const i = value => value < 0n ? `(-((I)${u(-value)}))` : `((I)${u(value)})`;
const large = (1n << 100n) + 97n;
const shiftCounts=[0,1,31,32,63,64,65,100,126,127];
const shiftPattern=0xfedcba98765432100123456789abcdefn;
const factorial30 = Array.from({length:30},(_,index)=>BigInt(index+1)).reduce((a,b)=>a*b,1n);

add('layout', `#include <stdio.h>
#include <stddef.h>
${types}
struct Layout { char before; I value; char after; };
int main(void) {
  printf("%u %u %u %u %u %d\\n",(unsigned)sizeof(I),(unsigned)_Alignof(I),
    (unsigned)sizeof(U),(unsigned)offsetof(struct Layout,value),
    (unsigned)sizeof(struct Layout),__SIZEOF_INT128__==16);
  return 0;
}
`, {stdout:'16 16 16 16 48 1\n',features:['layout','alignment','predefined-size-macro']});

add('add-subtract', `#include <stdio.h>
${types}
static volatile U x=((U)5<<64)-1;
static volatile I negative=-((I)1<<100);
static volatile I maximum=(I)(((U)1<<127)-1),minimum=-((I)(((U)1<<127)-1))-1;
int main(void) {
  unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;
  U a=x, sum=a+n, difference=sum-(n+1);
  I b=negative+n, c=b-((I)1<<80),max=maximum,min=minimum;
  printf("%d %d %d %d %d %d %d %d %d %d\\n",sum==((U)5<<64)+6,
    difference==((U)5<<64)-2,b==-((I)1<<100)+7,
    c==-((I)1<<100)-((I)1<<80)+7,sum>a,difference<a,
    min+n==-max+6,max-n==((I)(((U)1<<127)-1))-7,
    (U)min==((U)1<<127),min<negative);
  return 0;
}
`, {stdin:'7\n',stdout:'1 1 1 1 1 1 1 1 1 1\n',features:['add','subtract','carry','borrow','signed-negative','signed-minimum','signed-maximum']});

add('multiply', `#include <stdio.h>
${types}
static volatile U high=((U)1<<100)+7, wrap=((U)1<<100)+3;
__attribute__((noinline)) static U product(U a,U b){return a*b;}
__attribute__((noinline)) static I signed_product(I a,I b){return a*b;}
int main(void) {
  unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;
  U result=product(high,n+2), wrapped=product(wrap,(U)1<<40);
  I signed_result=signed_product(-((I)1<<90)+n,-5);
  printf("%d %d %d %d\\n",result==((U)9<<100)+63,
    wrapped==((U)3<<40),signed_result==((I)5<<90)-35,
    product((U)0xffffffffffffffffULL,(U)0xffffffffffffffffULL)==${u(((1n<<64n)-1n)**2n)});
  return 0;
}
`, {stdin:'7\n',stdout:'1 1 1 1\n',features:['multiply','unsigned-wrap','signed-multiply','full-width-product']});

add('divide-remainder', `#include <stdio.h>
${types}
static volatile U numerator=${u(large)}, maximum=~(U)0;
static volatile I negative=${i(-large)};
int main(void) {
  unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;
  U a=numerator, d=n+10, q=a/d, r=a%d;
  I b=negative, sd=(I)d, sq=b/sd, sr=b%sd;
  U max=maximum, near=(U)1<<127;
  printf("%d %d %d %d %d %d %d %d\\n",q==${u(large/17n)},r==${u(large%17n)},
    sq==${i(-(large/17n))},sr==${i(-(large%17n))},
    b/-sd==${i(large/17n)},b%-sd==${i(-(large%17n))},
    max/near==1,max%near==near-1);
  return 0;
}
`, {stdin:'7\n',stdout:'1 1 1 1 1 1 1 1\n',features:['signed-division','unsigned-division','signed-remainder','unsigned-remainder','high-bit']});

add('shifts', `#include <stdio.h>
${types}
static volatile U one=1, pattern=${u(0xfedcba98765432100123456789abcdefn)};
__attribute__((noinline)) static U left(U a,unsigned n){return a<<n;}
__attribute__((noinline)) static U right(U a,unsigned n){return a>>n;}
__attribute__((noinline)) static I signed_right(I a,unsigned n){return a>>n;}
int main(void) {
  const unsigned counts[]={0,1,31,32,63,64,65,100,126,127};
  const U expected_left[]={${shiftCounts.map(n=>u(1n<<BigInt(n))).join(',')}};
  const U expected_right[]={${shiftCounts.map(n=>u(shiftPattern>>BigInt(n))).join(',')}};
  int ok=1;U start=one,p=pattern;
  for(unsigned k=0;k<sizeof(counts)/sizeof(counts[0]);++k) {
    unsigned n=counts[k];U bit=left(start,n);
    if(bit!=expected_left[k]||right(bit,n)!=1||right(p,n)!=expected_right[k])ok=0;
    if(n<127 && signed_right(-((I)1<<126),n)!=-((I)1<<(126-n)))ok=0;
  }
  printf("%d %d %d %d\\n",ok,left(start,64)==((U)1<<64),
    right((U)1<<127,127)==1,signed_right(-1,127)==-1);
  return 0;
}
`, {stdout:'1 1 1 1\n',features:['left-shift','logical-right-shift','arithmetic-right-shift','defined-shift-counts']});

add('bitwise-compare', `#include <stdio.h>
${types}
static volatile U a=${u(0xfedcba98765432100123456789abcdefn)}, b=${u(0x8000000000000000ffffffffffffffffn)};
static volatile I negative=-((I)1<<100), positive=((I)1<<100);
int main(void) {
  U x=a,y=b;I n=negative,p=positive;
  printf("%d %d %d %d %d %d %d %d %d %d %d\\n",
    (x&y)==${u(0xfedcba98765432100123456789abcdefn&0x8000000000000000ffffffffffffffffn)},
    (x|y)==${u(0xfedcba98765432100123456789abcdefn|0x8000000000000000ffffffffffffffffn)},
    (x^y)==${u(0xfedcba98765432100123456789abcdefn^0x8000000000000000ffffffffffffffffn)},
    ~x==${u(~0xfedcba98765432100123456789abcdefn)},x>y,x!=y,n<p,n<0,p>=0,
    x>((U)1<<100),!(((U)1<<100)>x));
  return 0;
}
`, {stdout:'1 1 1 1 1 1 1 1 1 1 1\n',features:['and','or','xor','not','signed-comparison','unsigned-comparison']});

add('integer-conversions', `#include <stdio.h>
#include <limits.h>
${types}
static volatile long long smallest=LLONG_MIN;
static volatile unsigned long long largest=ULLONG_MAX;
static volatile I small=-123;
static volatile U wide=((U)1<<110)+0x123456789abcdef0ULL;
int main(void) {
  I a=smallest;U b=largest,w=wide;I c=small;
  printf("%d %d %d %d %d %d %d %d\\n",a==-((I)1<<63),
    b==((U)1<<64)-1,(long long)a==LLONG_MIN,(unsigned long long)b==ULLONG_MAX,
    (int)c==-123,(signed char)c==-123,(unsigned short)w==0xdef0,
    (unsigned long long)w==0x123456789abcdef0ULL);
  return 0;
}
`, {stdout:'1 1 1 1 1 1 1 1\n',features:['integer-conversion','sign-extension','zero-extension','narrow-truncation']});

add('floating-conversions', `#include <stdio.h>
${types}
static volatile I negative=-((I)1<<60);
static volatile U large=(U)1<<100;
static volatile float f=0x1p80f, fractional=-3.75f;
static volatile double d=0x1p100, mixed=1099511627777.5;
int main(void) {
  I a=negative;U b=large;
  printf("%d %d %d %d %d %d %d %d\\n",(float)a==-0x1p60f,
    (double)a==-0x1p60,(float)b==0x1p100f,(double)b==0x1p100,
    (U)f==((U)1<<80),(U)d==((U)1<<100),(I)fractional==-3,
    (I)mixed==((I)1<<40)+1);
  return 0;
}
`, {stdout:'1 1 1 1 1 1 1 1\n',features:['float-conversion','double-conversion','truncation-towards-zero','in-range-conversions']});

add('storage', `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
${types}
struct __attribute__((packed)) Packed { char tag; U value; };
static volatile U values[3]={((U)1<<100)+7,~(U)0,(U)1<<127};
static volatile struct Packed packed={9,((U)1<<100)+7};
int main(void) {
  U local[3],*heap=malloc(sizeof(local));if(!heap)return 1;
  for(unsigned k=0;k<3;++k)local[k]=values[k];
  memcpy(heap,local,sizeof(local));packed.value=heap[0]+1;
  U unaligned=packed.value;unsigned long long words[2];memcpy(words,&heap[0],16);
  printf("%d %d %d %d %d %d\\n",((unsigned long)heap&15)==0,
    heap[1]==~(U)0,heap[2]==((U)1<<127),unaligned==((U)1<<100)+8,
    packed.tag==9,words[0]==7&&words[1]==((unsigned long long)1<<36));
  free(heap);return 0;
}
`, {stdout:'1 1 1 1 1 1\n',features:['global','heap','stack','packed','memcpy','little-endian-words']});

add('control-flow', `#include <stdio.h>
${types}
__attribute__((noinline)) static U factorial(unsigned n){U x=1;for(unsigned k=2;k<=n;++k)x*=k;return x;}
__attribute__((noinline)) static unsigned bits(U x){unsigned n=0;while(x){++n;x>>=1;}return n;}
int main(void){unsigned n;if(scanf("%u",&n)!=1||n!=30)return 1;
  U x=factorial(n);I signed_sum=0;
  for(int k=-9;k<=9;++k){I value=(I)k*((I)1<<90);if(value<0)signed_sum-=value;else signed_sum+=value;}
  printf("%d %d %d\\n",x==${u(factorial30)},bits(x)==108,signed_sum==((I)90<<90));return 0;}
`, {stdin:'30\n',stdout:'1 1 1\n',features:['branches','loops','wide-multiply','wide-conditions']});

const shapes=[
  {id:'scalar',declaration:'typedef I Value;',member:'',direct:true},
  {id:'singleton',declaration:'typedef struct { I value; } Value;',member:'.value',direct:true},
  {id:'nested',declaration:'typedef struct { union { struct { I value; } inner[1]; } outer; } Value;',member:'.outer.inner[0].value',direct:true},
  {id:'multiple',declaration:'typedef struct { I value; int tag; } Value;',member:'.value',direct:false,tag:true},
  {id:'packed-offset',declaration:'typedef struct __attribute__((packed)) { char tag; I value; } Value;',member:'.value',direct:false,tag:true},
  {id:'cpp-nontrivial',declaration:'struct Value { I value; Value() {} Value(const Value &x): value(x.value) {} ~Value() {} };',member:'.value',direct:false,cpp:true},
];
for(const shape of shapes){
  const get=name=>name+shape.member;
  const header=`#ifndef INT128_ABI_H\n#define INT128_ABI_H\n${types}${shape.declaration}\n#ifdef __cplusplus\nextern "C" {\n#endif\nValue ti_make(int);\nValue ti_modify(Value);\nint ti_inspect(Value);\nValue ti_invoke(Value,Value(*)(Value));\nU ti_mixed(int,U,long long,U,int);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
  const args=shape.direct?['i64','i64']:['i32'];
  add(`abi-${shape.id}`,`#include <stdio.h>
#include "int128-abi.h"
static Value callback(Value x){${get('x')}+=((I)1<<80)+9;return x;}
static Value(*volatile maker)(int)=ti_make;
static Value(*volatile modifier)(Value)=ti_modify;
static int(*volatile inspector)(Value)=ti_inspect;
static U(*volatile mixer)(int,U,long long,U,int)=ti_mixed;
int main(void){int n;if(scanf("%d",&n)!=1||n!=7)return 1;
  Value a=ti_make(n),b=maker(n),c=ti_modify(a),d=modifier(b),e=ti_invoke(a,callback);
  if(${get('a')}!=-((I)1<<100)+7||${get('b')}!=${get('a')})return 2;
  if(${get('c')}!=${get('a')}+((I)1<<80)+9||${get('d')}!=${get('c')}||${get('e')}!=${get('c')})return 3;
  if(!ti_inspect(a)||!inspector(b)||${get('a')}!=-((I)1<<100)+7)return 4;
  ${shape.tag?'if(a.tag!=93||c.tag!=93||e.tag!=93)return 5;':''}
  U x=ti_mixed(3,((U)1<<127)+5,4294967303LL,((U)1<<100)+7,9);
  U y=mixer(3,((U)1<<127)+5,4294967303LL,((U)1<<100)+7,9);
  if(x!=((U)1<<127)+((U)1<<100)+12||y!=x)return 6;
  puts("int128 ABI ok");return 0;}
`,{language:shape.cpp?'cpp':'c',stdin:'7\n',stdout:'int128 ABI ok\n',interop:true,
    features:['int128-abi',shape.id,'direct','indirect','callback','mixed-signed-unsigned'],
    files:[{path:'int128-abi.h',contents:header},{path:shape.cpp?'provider.cpp':'provider.c',contents:`#include "int128-abi.h"
__attribute__((noinline)) Value ti_make(int n){Value r;${get('r')}=-((I)1<<100)+n;${shape.tag?'r.tag=93;':''}return r;}
__attribute__((noinline)) Value ti_modify(Value x){${get('x')}+=((I)1<<80)+9;return x;}
__attribute__((noinline)) int ti_inspect(Value x){return ${get('x')}==-((I)1<<100)+7;}
__attribute__((noinline)) Value ti_invoke(Value x,Value(*f)(Value)){return f(x);}
__attribute__((noinline)) U ti_mixed(int a,U x,long long cookie,U y,int b){return a==3&&cookie==4294967303LL&&b==9?x+y:0;}
`}],sources:[shape.cpp?'provider.cpp':'provider.c'],signatures:{
      ti_make:{params:['i32','i32'],results:[]},ti_modify:{params:['i32',...args],results:[]},
      ti_inspect:{params:args,results:['i32']},ti_invoke:{params:['i32',...args,'i32'],results:[]},
      ti_mixed:{params:['i32','i32','i64','i64','i64','i64','i64','i32'],results:[]},
    }});
}

add('varargs',`#include <stdio.h>
#include "int128-varargs.h"
static U(*volatile indirect)(int,...)=ti_variadic;
int main(void){Box box={((U)1<<127)+7};I negative=-((I)1<<100)+3;
  U a=ti_variadic(7,31,negative,4294967303LL,1.5,box,19);
  U b=indirect(7,31,negative,4294967303LL,1.5,box,19);
  printf("%d %d\\n",a==((U)1<<127)-((U)1<<100)+10,b==a);return 0;}
`,{stdout:'1 1\n',interop:true,features:['varargs','va-copy','singleton-varargs','alignment16','mixed-arguments'],
  files:[{path:'int128-varargs.h',contents:types+'typedef struct { U value; } Box;\nU ti_variadic(int,...);\n'},
    {path:'provider.c',contents:`#include <stdarg.h>
#include "int128-varargs.h"
static U read_values(va_list ap){int a=va_arg(ap,int);I x=va_arg(ap,I);long long cookie=va_arg(ap,long long);
  double d=va_arg(ap,double);Box y=va_arg(ap,Box);int b=va_arg(ap,int);
  return a==31&&cookie==4294967303LL&&d==1.5&&b==19?(U)x+y.value:0;}
__attribute__((noinline)) U ti_variadic(int tag,...){va_list ap,copy;va_start(ap,tag);va_copy(copy,ap);
  U a=read_values(ap),b=read_values(copy);va_end(copy);va_end(ap);return tag==7&&a==b?a:0;}
`}],sources:['provider.c'],signatures:{ti_variadic:{params:['i32','i32','i32'],results:[]}}});

add('abi-simd-mixed',`#include <stdio.h>
#include "int128-simd.h"
static U callback(U a,Vector v,U b){return a+b+(U)(v[1]+v[2]);}
static U(*volatile indirect)(U,Vector,U)=ti_vector_mix;
int main(void){int n;if(scanf("%d",&n)!=1||n!=7)return 1;
  U a=((U)1<<127)+n,b=((U)1<<100)+9;Vector v={n,-7,11,13};
  U x=ti_vector_mix(a,v,b),y=indirect(a,v,b),z=ti_vector_invoke(a,v,b,callback);
  printf("%d %d %d\\n",x==((U)1<<127)+((U)1<<100)+23,y==x,z==((U)1<<127)+((U)1<<100)+20);return 0;}
`,{stdin:'7\n',stdout:'1 1 1\n',interop:true,simd:true,features:['int128-abi','simd128-abi','direct','indirect','callback'],
  files:[{path:'int128-simd.h',contents:types+'typedef int Vector __attribute__((vector_size(16)));\nU ti_vector_mix(U,Vector,U);\nU ti_vector_invoke(U,Vector,U,U(*)(U,Vector,U));\n'},
    {path:'provider.c',contents:`#include "int128-simd.h"
__attribute__((noinline)) U ti_vector_mix(U a,Vector v,U b){return v[1]==-7&&v[2]==11&&v[3]==13?a+b+(U)v[0]:0;}
__attribute__((noinline)) U ti_vector_invoke(U a,Vector v,U b,U(*f)(U,Vector,U)){return f(a,v,b);}
`}],sources:['provider.c'],signatures:{ti_vector_mix:{params:['i32','i64','i64','v128','i64','i64'],results:[]},
    ti_vector_invoke:{params:['i32','i64','i64','v128','i64','i64','i32'],results:[]}}});

add('cpp-initialization',`#include <stdio.h>
#include "int128-cpp.h"
struct Init {Init(){global_value=((I)1<<100)+7;}~Init(){puts("destroyed");}} init;
int main(){printf("%d\\n",twice(global_value)==((I)1<<101)+14);return 0;}
`,{language:'cpp',stdout:'1\ndestroyed\n',features:['cpp','static-initialization','destruction','multi-tu','template'],
  files:[{path:'int128-cpp.h',contents:types+'extern I global_value;\nI twice(I);\n'},
    {path:'provider.cpp',contents:'#include "int128-cpp.h"\nI global_value;\ntemplate<class T>T multiply(T x){return x*2;}\nI twice(I x){return multiply(x);}\n'}],sources:['provider.cpp']});

add('cpp-library',`#include <limits>
#include <vector>
#include <numeric>
#include <algorithm>
#include <iostream>
${types}
int main(){int n;if(!(std::cin>>n)||n!=7)return 1;
  std::vector<I> values={((I)1<<100)+n,-((I)1<<100),((I)1<<80)};
  I sum=std::accumulate(values.begin(),values.end(),(I)0);std::sort(values.begin(),values.end());
  std::cout<<std::numeric_limits<I>::digits<<" "<<std::numeric_limits<U>::digits<<" "
    <<(sum==((I)1<<80)+7)<<" "<<(values[0]==-((I)1<<100))<<" "
    <<(values[2]==((I)1<<100)+7)<<" "<<(std::numeric_limits<I>::is_integer)<<"\\n";return 0;}
`,{language:'cpp',stdin:'7\n',stdout:'127 128 1 1 1 1\n',stdcpp:true,features:['cpp','numeric-limits','vector','accumulate','sort','iostream']});

add('binary128-conversions',`#include <stdio.h>
${types}
static volatile I signed_value=-((I)1<<100)-((I)1<<47);
static volatile U unsigned_value=((U)1<<127)+((U)1<<100);
static volatile long double signed_real=-0x1.00000000000008p100L;
static volatile long double unsigned_real=0x1.0000002p127L;
int main(void){I x=signed_value;U y=unsigned_value;long double a=x,b=y;
  printf("%d %d %d %d %d %d\\n",a==-0x1.00000000000008p100L,
    b==0x1.0000002p127L,(I)a==x,(U)b==y,
    (I)signed_real==-((I)1<<100)-((I)1<<47),
    (U)unsigned_real==((U)1<<127)+((U)1<<100));return 0;}
`,{stdout:'1 1 1 1 1 1\n',features:['binary128','signed-conversion','unsigned-conversion','in-range-conversions']});

export const cases=profiles.flatMap(profile=>['0','2'].map(optimization=>({
  id:`int128-${profile.id}-o${optimization}`,features:profile.features,interop:Boolean(profile.interop),
  printscan:false,stdcpp:Boolean(profile.stdcpp),signatures:profile.signatures||{},
  request:{language:profile.language||'c',standard:profile.language==='cpp'?'gnu++17':'gnu11',optimization,
    emit:'executable',simd:Boolean(profile.simd),defines:['ONLINE_JUDGE=1'],
    code:'#ifndef ONLINE_JUDGE\n#error ONLINE_JUDGE was not passed as a compiler option\n#endif\n'+profile.code,
    ...(profile.files?{files:profile.files,sources:profile.sources}:{})},stdin:profile.stdin||'',stdout:profile.stdout,
})));
