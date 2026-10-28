// Existing GCC C _Float128 and GNU complex long double qualification.
// GCC always compiles the subject literal source. Clang cannot parse C
// _Float128 on this target: explicit reference headers use WASI binary128
// long double. They are an independent test oracle, never a GCC fallback.
const profiles = [
{"group": "float128", "name": "layout-literals", "code": `#include <stdio.h>
#include "fp-types.h"
#include <stddef.h>
struct Layout { char first; Q value; char last; };
static volatile Q one=QC(1.0),tiny=QC(0x1p-100);
int main(void) {
 Q v=one+tiny;
 printf("%u %u %u %u %d %d %d %d\\n",(unsigned)sizeof(Q),(unsigned)_Alignof(Q),
 (unsigned)offsetof(struct Layout,value),(unsigned)sizeof(struct Layout),
 Q_MANT_DIG,Q_MAX_EXP,v>one,v-one==tiny);return 0;
}
`, "stdout": `16 16 16 48 113 16384 1 1
`, "stdin": "", "signatures": {}, "features": ["C-_Float128-spelling", "F128-literals", "layout", "alignment", "precision"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "arithmetic", "code": `#include <stdio.h>
#include "fp-types.h"
static volatile Q tiny=QC(0x1p-100);
__attribute__((noinline)) static Q calc(Q a,Q b){Q p=a*b;return p/b-a;}
int main(void) {
 int n;if(scanf("%d",&n)!=1||n!=3)return 1;
 Q a=(Q)n+tiny,b=QC(4.0),s=a+tiny;
 printf("%d %d %d %d %d %d\\n",s>a,s-(Q)n==2*tiny,calc(a,b)==0,
 -a<0,-(-a)==a,Q_FABS(-a)==a);return 0;
}
`, "stdout": `1 1 1 1 1 1
`, "stdin": `3
`, "signatures": {}, "features": ["add", "subtract", "multiply", "divide", "negate", "fabs-builtin", "stdin"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "conversions", "code": `#include <stdio.h>
#include "fp-types.h"
#include <limits.h>
typedef __int128 I;typedef unsigned __int128 U;
static volatile I wide=-(((I)1<<100)+9);
static volatile Q fractional=QC(-3.75),p=QC(4294967295.75),n=QC(-2147483648.75);
static volatile double d=0x1.0000000000001p0;
static volatile float f=1.5f;
int main(void) {
 Q a=LLONG_MIN,b=ULLONG_MAX,c=d,e=f,w=wide;long double l=(long double)c;
 printf("%d %d %d %d %d %d %d %d %d %d\\n",
 (long long)a==LLONG_MIN,(unsigned long long)b==ULLONG_MAX,b+1==QC(0x1p64),
 (double)c==d&&c>1,(float)e==f,(int)fractional==-3,(unsigned)p==UINT_MAX,
 (int)n==INT_MIN,(I)w==wide,(Q)l==c);return 0;
}
`, "stdout": `1 1 1 1 1 1 1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["integer-conversions", "int128-conversion", "float-conversion", "double-conversion", "long-double-conversion"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "special-values", "code": `#include <stdio.h>
#include "fp-types.h"
#include <string.h>
static volatile unsigned long long payload[2]={0x456789abcdef0123ULL,0xffff800000000123ULL};
static volatile Q nz=QC(-0.0),pz=QC(0.0),sub=QC(0x1p-16494);
int main(void) {
 unsigned long long words[2]={payload[0],payload[1]},copy[2];Q nan;
 memcpy(&nan,words,16);volatile Q stored=nan;Q moved=stored;memcpy(copy,&moved,16);
 Q absolute=Q_FABS(moved),negative=Q_COPYSIGN(absolute,nz);
 unsigned long long sign[2];memcpy(sign,&negative,16);
 printf("%d %d %d %d %d %d %d %d\\n",nan!=nan,!(nan<1),!(nan>=1),
 copy[0]==words[0]&&copy[1]==words[1],nz==pz,!!__builtin_signbit(nz),
 sign[0]==words[0]&&sign[1]==words[1],sub>0&&sub/2==0);return 0;
}
`, "stdout": `1 1 1 1 1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["quiet-NaN", "payload", "signed-zero", "copysign-builtin", "subnormal"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "rounding-exponent", "code": `#include <stdio.h>
#include "fp-types.h"
static volatile Q one=QC(1.0),half=QC(0x1p-113),ulp=QC(0x1p-112);
static volatile Q maximum=QC(0x1.ffffffffffffffffffffffffffffp16383),tiny=QC(0x1p-16494);
int main(void) {
 Q a=one,b=half,u=ulp,m=maximum,t=tiny;Q infinity=m*2,under=-t/2;
 printf("%d %d %d %d %d %d\\n",a+b==a,(a+u)+b==a+2*u,
 infinity>m,__builtin_isinf(infinity),under==0,!!__builtin_signbit(under));return 0;
}
`, "stdout": `1 1 1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["round-to-nearest-even", "overflow", "underflow", "exponent-boundaries"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "storage", "code": `#include <stdio.h>
#include "fp-types.h"
#include <stdlib.h>
#include <string.h>
struct __attribute__((packed)) Packed { unsigned char before; Q value; unsigned char after; };
static volatile Q global=QC(1.0)+QC(0x1p-100);
int main(void) {
 struct Packed p={17,0,29};Q *heap=malloc(3*sizeof(Q));if(!heap)return 1;
 Q values[3]={global,QC(-3.5),QC(0x1p100)};memcpy(heap,values,sizeof(values));
 p.value=heap[0];volatile Q v=p.value;memmove(heap+1,heap,2*sizeof(Q));
 printf("%d %d %d %d %d\\n",v==global,p.before==17&&p.after==29,
 heap[1]==values[0],heap[2]==values[1],((unsigned long)heap%16)==0);free(heap);return 0;
}
`, "stdout": `1 1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["global", "stack", "heap", "packed", "volatile", "memcpy", "memmove"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "control-loop", "code": `#include <stdio.h>
#include "fp-types.h"
static volatile Q tiny=QC(0x1p-100);
__attribute__((noinline))static Q accumulate(unsigned n){Q v=0;for(unsigned i=0;i<n;++i)v+=tiny;return v;}
int main(void) {
 unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;
 Q x=accumulate(n),a=QC(-3.0),b=QC(2.0);
 printf("%d %d %d %d %d %d\\n",x==7*tiny,x>0,a<b,a<=a,!(b<a),a!=b);return 0;
}
`, "stdout": `1 1 1 1 1 1
`, "stdin": `7
`, "signatures": {}, "features": ["loop", "branch", "comparisons", "runtime-call"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "direct-indirect-callback", "code": `#include <stdio.h>
#include "fp-types.h"
Q fp_q_mix(Q,double,int);Q fp_q_apply(Q(*)(Q),Q);Q fp_q_call(Q(*)(Q,double,int),Q,double,int);
__attribute__((noinline)) Q fp_q_callback(Q x){return x+1;}
int main(void) {
 int n;if(scanf("%d",&n)!=1||n!=3)return 1;
 Q a=(Q)n+QC(0x1p-100),direct=fp_q_mix(a,2.0,3);
 Q(*volatile fn)(Q,double,int)=fp_q_mix;
 Q indirect=fp_q_call(fn,a,2.0,3),callback=fp_q_apply(fp_q_callback,a);
 printf("%d %d %d\\n",direct==QC(8.0)+QC(0x1p-100),indirect==direct,
 callback==QC(5.0)+QC(0x1p-100));return 0;
}
`, "stdout": `1 1 1
`, "stdin": `3
`, "signatures": {"fp_q_mix": {"params": ["i32", "i64", "i64", "f64", "i32"], "results": []}, "fp_q_apply": {"params": ["i32", "i32", "i64", "i64"], "results": []}, "fp_q_call": {"params": ["i32", "i32", "i64", "i64", "f64", "i32"], "results": []}}, "features": ["direct-call", "function-pointer", "callback", "mixed-scalar-ABI"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}, {"path": "provider.c", "contents": `#include "fp-types.h"
__attribute__((noinline))Q fp_q_mix(Q a,double b,int c){return a+(Q)b+c;}
__attribute__((noinline))Q fp_q_apply(Q(*f)(Q),Q x){return f(x)+1;}
__attribute__((noinline))Q fp_q_call(Q(*f)(Q,double,int),Q a,double b,int c){return f(a,b,c);}
`}], "interop": true, "sources": ["provider.c"], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "aggregate-abi", "code": `#include <stdio.h>
#include "fp-types.h"
struct Box{Q value;};struct Mixed{int tag;Q value;};
struct Box fp_q_box(struct Box);struct Mixed fp_q_mixed(struct Mixed);
int main(void) {
 struct Box a={QC(1.0)+QC(0x1p-100)},b=fp_q_box(a);
 struct Mixed c={7,QC(-3.5)},d=fp_q_mixed(c);
 printf("%d %d %d %d\\n",b.value==QC(2.0)+QC(0x1p-99),a.value==QC(1.0)+QC(0x1p-100),
 d.tag==8,d.value==QC(-2.5));return 0;
}
`, "stdout": `1 1 1 1
`, "stdin": "", "signatures": {"fp_q_box": {"params": ["i32", "i64", "i64"], "results": []}, "fp_q_mixed": {"params": ["i32", "i32"], "results": []}}, "features": ["singleton-aggregate", "multifield-aggregate", "arguments", "indirect-result"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}, {"path": "provider.c", "contents": `#include "fp-types.h"
struct Box{Q value;};struct Mixed{int tag;Q value;};
__attribute__((noinline))struct Box fp_q_box(struct Box x){x.value*=2;return x;}
__attribute__((noinline))struct Mixed fp_q_mixed(struct Mixed x){x.tag++;x.value++;return x;}
`}], "interop": true, "sources": ["provider.c"], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "varargs-va-copy", "code": `#include <stdio.h>
#include "fp-types.h"
Q fp_q_variadic(int,Q,...);
int main(void) {
 Q x=QC(1.0)+QC(0x1p-100);
 Q result=fp_q_variadic(3,x,7,x,2.0,QC(4.0),9);
 printf("%d %d\\n",result==QC(7.0)+QC(0x1p-99),x==QC(1.0)+QC(0x1p-100));return 0;
}
`, "stdout": `1 1
`, "stdin": "", "signatures": {"fp_q_variadic": {"params": ["i32", "i32", "i64", "i64", "i32"], "results": []}}, "features": ["varargs", "va_copy", "16-byte-alignment", "mixed-promotions"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}, {"path": "provider.c", "contents": `#include "fp-types.h"
#include <stdarg.h>
__attribute__((noinline))Q fp_q_variadic(int count,Q base,...){
 va_list ap,copy;va_start(ap,base);int first=va_arg(ap,int);va_copy(copy,ap);
 Q q=va_arg(ap,Q);double d=va_arg(ap,double);Q r=va_arg(ap,Q);int last=va_arg(ap,int);
 Q duplicate=va_arg(copy,Q);va_end(copy);va_end(ap);
 if(count!=3||first!=7||last!=9||duplicate!=q)return -99;return base+q+(Q)d+r-1;
}
`}], "interop": true, "sources": ["provider.c"], "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "float128", "name": "libc-long-double-bridge", "code": `#include <stdio.h>
#include "fp-types.h"
#include <stdlib.h>
#include <math.h>
int main(void) {
 char *end;long double input;if(scanf("%Lf",&input)!=1)return 1;
 Q q=(Q)strtold("1.25",&end),x=(Q)input;long double root=sqrtl((long double)x);
 printf("%.2Lf %d %d %d\\n",(long double)q,*end==0,q==QC(1.25),root==2.0L);return 0;
}
`, "stdout": `1.25 1 1 1
`, "stdin": `4
`, "signatures": {}, "features": ["explicit-long-double-libc-bridge", "stdio", "strtold", "libm"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef _Float128 Q;
#define QC(x) x##F128
#define Q_MANT_DIG __FLT128_MANT_DIG__
#define Q_MAX_EXP __FLT128_MAX_EXP__
#define Q_FABS(x) __builtin_fabsf128(x)
#define Q_COPYSIGN(x,y) __builtin_copysignf128(x,y)
#endif
`}], "printscan": true, "referenceFiles": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
/* SDK Clang rejects _Float128; its WASI long double is the binary128 oracle. */
typedef long double Q;
#define QC(x) x##L
#define Q_MANT_DIG __LDBL_MANT_DIG__
#define Q_MAX_EXP __LDBL_MAX_EXP__
#define Q_FABS(x) __builtin_fabsl(x)
#define Q_COPYSIGN(x,y) __builtin_copysignl(x,y)
#endif
`}], "referenceModel": "SDK Clang long double binary128 oracle; GCC subject remains C _Float128."},
{"group": "complex", "name": "layout-components", "code": `#include <stdio.h>
#include "fp-types.h"
#include <stddef.h>
struct Layout{char first;Z value;char last;};
static volatile long double one=1.0L,tiny=0x1p-100L;
int main(void) {
 Z z=fp_make(one+tiny,-3.5L);long double words[2];__builtin_memcpy(words,&z,sizeof(z));
 printf("%u %u %u %u %d %d %d\\n",(unsigned)sizeof(Z),(unsigned)_Alignof(Z),
 (unsigned)offsetof(struct Layout,value),(unsigned)sizeof(struct Layout),
 words[0]==one+tiny,words[1]==-3.5L,__real__ z-one==tiny);return 0;
}
`, "stdout": `32 16 16 64 1 1 1
`, "stdin": "", "signatures": {}, "features": ["GNU-complex-long-double", "layout", "component-order", "binary128-components"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "add-subtract-conjugate", "code": `#include <stdio.h>
#include "fp-types.h"
static volatile long double tiny=0x1p-100L;
int main(void) {
 int n;if(scanf("%d",&n)!=1||n!=3)return 1;Z a=fp_make(n+tiny,4),b=fp_make(2,-1);
 Z sum=a+b,difference=sum-b,negative=-a,conjugate=~a;
 printf("%d %d %d %d\\n",fp_equal(sum,5+tiny,3),difference==a,
 fp_equal(negative,-3-tiny,-4),fp_equal(conjugate,3+tiny,-4));return 0;
}
`, "stdout": `1 1 1 1
`, "stdin": `3
`, "signatures": {}, "features": ["add", "subtract", "negate", "GNU-conjugate"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "multiply", "code": `#include <stdio.h>
#include "fp-types.h"
static volatile long double a=3,b=4,c=2,d=-1;
__attribute__((noinline))static Z multiply(Z x,Z y){return x*y;}
int main(void) {
 Z x=fp_make(a,b),y=fp_make(c,d),z=multiply(x,y),s=multiply(x,x);
 printf("%d %d %d\\n",fp_equal(z,10,5),fp_equal(s,-7,24),fp_equal(multiply(x,fp_make(0,1)),-4,3));return 0;
}
`, "stdout": `1 1 1
`, "stdin": "", "signatures": {}, "features": ["complex-multiply", "compiler-rt-helper", "noninline"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "divide-scaling", "code": `#include <stdio.h>
#include "fp-types.h"
static volatile long double huge=0x1p10000L,tiny=0x1p-10000L;
__attribute__((noinline))static Z divide(Z x,Z y){return x/y;}
int main(void) {
 Z result=divide(fp_make(10,5),fp_make(2,-1));
 Z a=fp_make(huge,huge),b=fp_make(tiny,-tiny);
 printf("%d %d %d\\n",fp_equal(result,3,4),fp_equal(divide(a,a),1,0),fp_equal(divide(b,b),1,0));return 0;
}
`, "stdout": `1 1 1
`, "stdin": "", "signatures": {}, "features": ["complex-divide", "overflow-resistant-scaling", "underflow-resistant-scaling"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "scalar-conversions", "code": `#include <stdio.h>
#include "fp-types.h"
static volatile long double tiny=0x1p-100L;
int main(void) {
 Z z=fp_make(3.5L,-2.25L),precise=fp_make(1+tiny,2);
 float _Complex f=(float _Complex)z;double _Complex d=(double _Complex)z;
 Z back=f,real=7;long double extracted=(long double)z;
 printf("%d %d %d %d %d %d\\n",fp_equal(back,3.5L,-2.25L),
 __real__ d==3.5&&__imag__ d==-2.25,fp_equal(real,7,0),extracted==3.5L,
 __real__ precise-1==tiny,(int)z==3);return 0;
}
`, "stdout": `1 1 1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["scalar-conversion", "complex-float", "complex-double", "real-extraction"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "special-components", "code": `#include <stdio.h>
#include "fp-types.h"
#include <string.h>
static volatile long double negative_zero=-0.0L,subnormal=0x1p-16494L;
static volatile unsigned long long payload[2]={0x456789abcdef0123ULL,0x7fff800000000123ULL};
int main(void) {
 unsigned long long words[2]={payload[0],payload[1]},copy[2];long double nan;
 memcpy(&nan,words,16);Z value=fp_make(nan,negative_zero),conjugate=~value;
 long double component=__real__ conjugate;memcpy(copy,&component,16);
 printf("%d %d %d %d %d %d\\n",__real__ value!=__real__ value,
 !!__builtin_signbitl(__imag__ value),!__builtin_signbitl(__imag__ conjugate),
 copy[0]==words[0]&&copy[1]==words[1],value!=value,
 __real__ fp_make(subnormal,0)>0);return 0;
}
`, "stdout": `1 1 1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["quiet-NaN-component", "payload", "signed-zero-component", "subnormal-component"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "storage", "code": `#include <stdio.h>
#include "fp-types.h"
#include <stdlib.h>
#include <string.h>
struct __attribute__((packed)) Packed{unsigned char first;Z value;unsigned char last;};
static Z global;static volatile long double tiny=0x1p-100L;
int main(void) {
 global=fp_make(1+tiny,-3.5L);struct Packed p={17,0,29};Z*heap=malloc(3*sizeof(Z));if(!heap)return 1;
 Z values[3]={global,fp_make(-7,9),fp_make(0,2)};memcpy(heap,values,sizeof(values));
 p.value=heap[0];volatile Z stored=p.value;memmove(heap+1,heap,2*sizeof(Z));
 printf("%d %d %d %d %d\\n",stored==global,p.first==17&&p.last==29,
 heap[1]==values[0],heap[2]==values[1],((unsigned long)heap%16)==0);free(heap);return 0;
}
`, "stdout": `1 1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["global", "heap", "packed", "volatile", "memcpy", "memmove"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "control-loop", "code": `#include <stdio.h>
#include "fp-types.h"
__attribute__((noinline))static Z accumulate(unsigned n){Z z=0;for(unsigned i=0;i<n;++i)z+=fp_make(i,1);return z;}
int main(void) {
 unsigned n;if(scanf("%u",&n)!=1||n!=7)return 1;Z z=accumulate(n),zero=0,other=fp_make(21,-7);
 printf("%d %d %d %d %d\\n",fp_equal(z,21,7),z!=zero,zero==0,!!z,!zero);
 return other==z;
}
`, "stdout": `1 1 1 1 1
`, "stdin": `7
`, "signatures": {}, "features": ["loop", "branch", "equality", "complex-boolean"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "direct-indirect-callback", "code": `#include <stdio.h>
#include "fp-types.h"
Z fp_z_mix(Z,Z);Z fp_z_apply(Z(*)(Z),Z);Z fp_z_call(Z(*)(Z,Z),Z,Z);
__attribute__((noinline)) Z fp_z_callback(Z x){return x+fp_make(1,-1);}
int main(void) {
 Z a=fp_make(3,4),b=fp_make(2,-1),direct=fp_z_mix(a,b);Z(*volatile fn)(Z,Z)=fp_z_mix;
 Z indirect=fp_z_call(fn,a,b),callback=fp_z_apply(fp_z_callback,a);
 printf("%d %d %d\\n",fp_equal(direct,5,3),indirect==direct,fp_equal(callback,5,4));return 0;
}
`, "stdout": `1 1 1
`, "stdin": "", "signatures": {"fp_z_mix": {"params": ["i32", "i32", "i32"], "results": []}, "fp_z_apply": {"params": ["i32", "i32", "i32"], "results": []}, "fp_z_call": {"params": ["i32", "i32", "i32", "i32"], "results": []}}, "features": ["direct-call", "function-pointer", "callback", "complex-memory-ABI"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}, {"path": "provider.c", "contents": `#include "fp-types.h"
__attribute__((noinline)) Z fp_z_mix(Z a,Z b){return a+b;}
__attribute__((noinline)) Z fp_z_apply(Z(*f)(Z),Z x){return f(x)+fp_make(1,1);}
__attribute__((noinline)) Z fp_z_call(Z(*f)(Z,Z),Z a,Z b){return f(a,b);}
`}], "interop": true, "sources": ["provider.c"], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "aggregate-abi", "code": `#include <stdio.h>
#include "fp-types.h"
struct Box{Z value;};struct Mixed{int tag;Z value;};
struct Box fp_z_box(struct Box);struct Mixed fp_z_mixed(struct Mixed);
int main(void) {
 struct Box a={fp_make(3,4)},b=fp_z_box(a);struct Mixed c={7,fp_make(-3.5L,2)},d=fp_z_mixed(c);
 printf("%d %d %d %d\\n",fp_equal(b.value,6,8),fp_equal(a.value,3,4),d.tag==8,fp_equal(d.value,-2.5L,1));return 0;
}
`, "stdout": `1 1 1 1
`, "stdin": "", "signatures": {"fp_z_box": {"params": ["i32", "i32"], "results": []}, "fp_z_mixed": {"params": ["i32", "i32"], "results": []}}, "features": ["complex-singleton-container", "multifield-container", "pass-by-value"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}, {"path": "provider.c", "contents": `#include "fp-types.h"
struct Box{Z value;};struct Mixed{int tag;Z value;};
__attribute__((noinline))struct Box fp_z_box(struct Box x){x.value*=2;return x;}
__attribute__((noinline))struct Mixed fp_z_mixed(struct Mixed x){x.tag++;x.value+=fp_make(1,-1);return x;}
`}], "interop": true, "sources": ["provider.c"], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "varargs-va-copy", "code": `#include <stdio.h>
#include "fp-types.h"
Z fp_z_variadic(int,Z,...);
int main(void) {
 Z a=fp_make(3,4),b=fp_make(2,-1);Z result=fp_z_variadic(2,a,7,b,2.0,9);
 printf("%d %d\\n",fp_equal(result,7,3),fp_equal(a,3,4));return 0;
}
`, "stdout": `1 1
`, "stdin": "", "signatures": {"fp_z_variadic": {"params": ["i32", "i32", "i32", "i32"], "results": []}}, "features": ["complex-varargs", "va_copy", "32-byte-slot", "16-byte-alignment"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}, {"path": "provider.c", "contents": `#include "fp-types.h"
#include <stdarg.h>
__attribute__((noinline))Z fp_z_variadic(int n,Z base,...){
 va_list ap,copy;va_start(ap,base);int first=va_arg(ap,int);va_copy(copy,ap);
 Z value=va_arg(ap,Z);double extra=va_arg(ap,double);int last=va_arg(ap,int);
 Z duplicate=va_arg(copy,Z);va_end(copy);va_end(ap);
 if(n!=2||first!=7||last!=9||duplicate!=value)return fp_make(-99,-99);
 return base+value+extra;
}
`}], "interop": true, "sources": ["provider.c"], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "libm", "code": `#include <stdio.h>
#include "fp-types.h"
#include <complex.h>
static volatile long double a=3,b=4,zero=0;
int main(void) {
 Z z=fp_make(a,b),one=fp_make(1,0),nothing=fp_make(zero,0);
 long double(*volatile norm)(Z)=cabsl;Z(*volatile square_root)(Z)=csqrtl;
 Z(*volatile exponential)(Z)=cexpl;Z(*volatile logarithm)(Z)=clogl;
 Z root=square_root(z);
 printf("%d %d %d %d %d\\n",norm(z)==5,fp_equal(root,2,1),
 fp_equal(exponential(nothing),1,0),fp_equal(logarithm(one),0,0),
 fp_equal(conjl(z),3,-4));return 0;
}
`, "stdout": `1 1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["complex-libm", "cabsl", "csqrtl", "cexpl", "clogl", "conjl"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "cpp-static-multiple", "code": `#include <stdio.h>
#include "fp-types.h"
extern Z fp_global;Z fp_z_twice(Z);
struct Init{Init(){fp_global=fp_make(1+0x1p-100L,-3.5L);}~Init(){puts("destroyed");}}init;
int main(){Z x=fp_z_twice(fp_global);printf("%d\\n",fp_equal(x,2+0x1p-99L,-7));return 0;}
`, "stdout": `1
destroyed
`, "stdin": "", "signatures": {}, "features": ["GNU-complex-C++", "multi-tu", "static-construction", "destruction", "template"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}, {"path": "provider.cpp", "contents": `#include "fp-types.h"
Z fp_global;
template<class T>T twice(T x){return x*2;}
Z fp_z_twice(Z x){return twice(x);}
`}], "language": "cpp", "sources": ["provider.cpp"], "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."},
{"group": "complex", "name": "cpp-standard-library", "code": `#include <stdio.h>
#include "fp-types.h"
#include <complex>
#include <vector>
#include <numeric>
int main(){
 std::complex<long double>a(3,4),b(2,-1),product=a*b,quotient=product/b;
 std::vector<std::complex<long double>>v={a,b};
 auto sum=std::accumulate(v.begin(),v.end(),std::complex<long double>(0,0));
 printf("%d %d %d %d\\n",product.real()==10&&product.imag()==5,quotient==a,
 std::abs(a)==5,sum.real()==5&&sum.imag()==3);return 0;
}
`, "stdout": `1 1 1 1
`, "stdin": "", "signatures": {}, "features": ["std-complex-long-double", "vector", "accumulate", "GNU-runtime"], "files": [{"path": "fp-types.h", "contents": `#ifndef FP_EXTENSION_TYPES_H
#define FP_EXTENSION_TYPES_H
typedef long double _Complex Z;
static inline Z fp_make(long double r,long double i) { Z z; __real__ z=r; __imag__ z=i; return z; }
static inline int fp_equal(Z z,long double r,long double i) { return __real__ z==r && __imag__ z==i; }
#endif
`}], "language": "cpp", "stdcpp": true, "referenceModel": "Identical GNU complex long double source in GCC and SDK Clang."}
];
const allCases = profiles.flatMap(profile => ['0','2'].map(optimization => ({
  id:'fp-extension-'+profile.group+'-'+profile.name+'-o'+optimization,
  group:profile.group,referenceModel:profile.referenceModel,
  referenceFiles:profile.referenceFiles || [],
  features:profile.features,interop:Boolean(profile.interop),
  printscan:Boolean(profile.printscan),stdcpp:Boolean(profile.stdcpp),
  signatures:profile.signatures,
  request:{
    language:profile.language || 'c',standard:profile.language==='cpp'?'gnu++17':'gnu11',
    optimization,emit:'executable',simd:false,defines:['ONLINE_JUDGE=1'],
    code:'#ifndef ONLINE_JUDGE\n#error ONLINE_JUDGE must be a real compiler option\n#endif\n'+profile.code,
    files:profile.files,...(profile.sources?{sources:profile.sources}:{}),
  },stdin:profile.stdin,stdout:profile.stdout,
})));
export const float128Cases=allCases.filter(c=>c.group==='float128');
export const complexCases=allCases.filter(c=>c.group==='complex');
export const cases=allCases;
