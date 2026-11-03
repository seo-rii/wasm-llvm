// Real GCC/Clang weak-linkage contracts. Source text is shared unchanged across
// compiler families. Same-unit local aliases are checked separately from imports.
const coreSources = {
  "weak-initialized": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
extern int optf(int) __attribute__((weak));
extern int optd __attribute__((weak));
int (*volatile observed_f)(int) = optf;
int *volatile observed_d = &optd;
#ifdef __cplusplus
}
#endif
int main(void) { int x; if (scanf("%d", &x) != 1) return 2;
int (*f)(int) = observed_f; int *d = observed_d;
printf("%d %d %d %d\n", !!f, !!d, f ? f(x) : -1, d ? *d : -1);
return 0; }
`,
  "weak-address": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
extern int optf(int) __attribute__((weak));
extern int optd __attribute__((weak));
#ifdef __cplusplus
}
#endif
int main(void) { int x; if (scanf("%d", &x) != 1) return 2;
int (*volatile observed_f)(int) = optf;
int *volatile observed_d = &optd;
int (*f)(int) = observed_f; int *d = observed_d;
printf("%d %d %d %d\n", !!f, !!d, f ? f(x) : -1, d ? *d : -1);
return 0; }
`,
  "weak-direct": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
extern int optf(int) __attribute__((weak));
extern int optd __attribute__((weak));
#ifdef __cplusplus
}
#endif
int main(void) { int x; if (scanf("%d", &x) != 1) return 2;
int (*volatile observed_f)(int) = optf;
int *volatile observed_d = &optd;
int (*f)(int) = observed_f; int *d = observed_d;
printf("%d %d %d %d\n", !!f, !!d, f ? optf(x) : -1, d ? optd : -1);
return 0; }
`,
  "weakref-initialized": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
int (*volatile observed_f)(int) = ref_f;
int *volatile observed_d = &ref_d;
#ifdef __cplusplus
}
#endif
int main(void) { int x; if (scanf("%d", &x) != 1) return 2;
int (*f)(int) = observed_f; int *d = observed_d;
printf("%d %d %d %d\n", !!f, !!d, f ? f(x) : -1, d ? *d : -1);
return 0; }
`,
  "weakref-address": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
#ifdef __cplusplus
}
#endif
int main(void) { int x; if (scanf("%d", &x) != 1) return 2;
int (*volatile observed_f)(int) = ref_f;
int *volatile observed_d = &ref_d;
int (*f)(int) = observed_f; int *d = observed_d;
printf("%d %d %d %d\n", !!f, !!d, f ? f(x) : -1, d ? *d : -1);
return 0; }
`,
  "weakref-direct": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
#ifdef __cplusplus
}
#endif
int main(void) { int x; if (scanf("%d", &x) != 1) return 2;
int (*volatile observed_f)(int) = ref_f;
int *volatile observed_d = &ref_d;
int (*f)(int) = observed_f; int *d = observed_d;
printf("%d %d %d %d\n", !!f, !!d, f ? ref_f(x) : -1, d ? ref_d : -1);
return 0; }
`,
  "strong-initialized": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
extern int optf(int);
extern int optd;
int (*volatile observed_f)(int) = optf;
int *volatile observed_d = &optd;
#ifdef __cplusplus
}
#endif
int main(void) { int x; if (scanf("%d", &x) != 1) return 2;
int (*f)(int) = observed_f; int *d = observed_d;
printf("%d %d %d %d\n", !!f, !!d, f ? f(x) : -1, d ? *d : -1);
return 0; }
`,
  "provider-weak": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
__attribute__((weak)) int optf(int x) { return x + 11; }
__attribute__((weak)) int optd = 23;
#ifdef __cplusplus
}
#endif
`,
  "provider-strong": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
int optf(int x) { return x + 11; }
int optd = 23;
#ifdef __cplusplus
}
#endif
`,
  "provider-override": String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
int optf(int x) { return x + 101; }
int optd = 203;
#ifdef __cplusplus
}
#endif
`,
};

const providers = {
  "base": String.raw`#ifdef __cplusplus
extern "C" {
#endif
int optf(int x){return x+11;}
int optd=23;

#ifdef __cplusplus
}
#endif
`,
  "asm": String.raw`#ifdef __cplusplus
extern "C" {
#endif
int optf(int) __asm__("custom.optional.function");
extern int optd __asm__("custom.optional.storage");
int optf(int x){return x+11;}
int optd=23;

#ifdef __cplusplus
}
#endif
`,
  "cpp": String.raw`namespace Optional { int target(int x){return x+11;} double target(double x){return x+0.5;} int data=23; }
`,
};

const boundaryProfiles = {
  "boundaries": [
    { ...{"id":"strong-first","providerKind":"base","optional":false,"present":"1 1 1 1 1 1 14 23\n","absent":null,"defined":false,"unused":false,"languages":["c","cpp"],"targets":["optf","optd"],"binding":"global"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
extern int optf(int);
extern int optd;
int (*volatile strong_f)(int)=optf;
int *volatile strong_d=&optd;
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*sf)(int)=strong_f; int *sd=strong_d;
int (*wf)(int)=observed_f; int *wd=observed_d;
printf("%d %d %d %d %d %d %d %d\n",!!sf,!!sd,!!wf,!!wd,sf==wf,sd==wd,wf?wf(x):-1,wd?*wd:-1);
return 0; }
` },
    { ...{"id":"weak-first","providerKind":"base","optional":false,"present":"1 1 1 1 1 1 14 23\n","absent":null,"defined":false,"unused":false,"languages":["c","cpp"],"targets":["optf","optd"],"binding":"global"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;
extern int optf(int);
extern int optd;
int (*volatile strong_f)(int)=optf;
int *volatile strong_d=&optd;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*sf)(int)=strong_f; int *sd=strong_d;
int (*wf)(int)=observed_f; int *wd=observed_d;
printf("%d %d %d %d %d %d %d %d\n",!!sf,!!sd,!!wf,!!wd,sf==wf,sd==wd,wf?wf(x):-1,wd?*wd:-1);
return 0; }
` },
    { ...{"id":"declared-target-weak-only","providerKind":"base","optional":true,"present":"1 1 14 23\n","absent":"0 0 -1 -1\n","defined":false,"unused":false,"languages":["c","cpp"],"targets":["optf","optd"],"binding":"weak"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
extern int optf(int);
extern int optd;
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*f)(int)=observed_f; int *d=observed_d;
printf("%d %d %d %d\n",!!f,!!d,f?f(x):-1,d?*d:-1);
return 0; }
` },
    { ...{"id":"multiple-weakrefs","providerKind":"base","optional":true,"present":"1 1 1 1 1 1 14 23\n","absent":"0 0 0 0 1 1 -1 -1\n","defined":false,"unused":false,"languages":["c","cpp"],"targets":["optf","optd"],"binding":"weak"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;

static int ref_second_f(int) __attribute__((weakref("optf")));
static int ref_second_d __attribute__((weakref("optd")));
int (*volatile second_f)(int)=ref_second_f;
int *volatile second_d=&ref_second_d;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*f)(int)=observed_f; int *d=observed_d;
int (*g)(int)=second_f; int *e=second_d;
printf("%d %d %d %d %d %d %d %d\n",!!f,!!d,!!g,!!e,f==g,d==e,g?g(x):-1,e?*e:-1);
return 0; }
` },
    { ...{"id":"unused-weakrefs","providerKind":"base","optional":true,"present":"unused 3\n","absent":"unused 3\n","defined":false,"unused":true,"languages":["c","cpp"],"targets":["optf","optd"],"binding":"weak"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
extern int optf(int);
extern int optd;
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
printf("unused %d\n", x);
return 0; }
` },
    { ...{"id":"definition-before","providerKind":"base","optional":false,"present":"1 1 14 23\n","absent":"0 0 -1 -1\n","defined":true,"unused":false,"languages":["c","cpp"],"targets":["optf","optd"],"binding":"global"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
int optf(int x){return x+11;}
int optd=23;
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*f)(int)=observed_f; int *d=observed_d;
printf("%d %d %d %d\n",!!f,!!d,f?f(x):-1,d?*d:-1);
return 0; }
` },
    { ...{"id":"definition-after","providerKind":"base","optional":false,"present":"1 1 14 23\n","absent":"0 0 -1 -1\n","defined":true,"unused":false,"languages":["c","cpp"],"targets":["optf","optd"],"binding":"global"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
static int ref_f(int) __attribute__((weakref("optf")));
static int ref_d __attribute__((weakref("optd")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;
int optf(int x){return x+11;}
int optd=23;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*f)(int)=observed_f; int *d=observed_d;
printf("%d %d %d %d\n",!!f,!!d,f?f(x):-1,d?*d:-1);
return 0; }
` },
    { ...{"id":"asm-names","providerKind":"asm","optional":true,"present":"1 1 14 23\n","absent":"0 0 -1 -1\n","defined":false,"unused":false,"languages":["c","cpp"],"targets":["custom.optional.function","custom.optional.storage"],"binding":"weak"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif

static int ref_f(int) __asm__("custom.ref.function") __attribute__((weakref("custom.optional.function")));
static int ref_d __asm__("custom.ref.storage") __attribute__((weakref("custom.optional.storage")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*f)(int)=observed_f; int *d=observed_d;
printf("%d %d %d %d\n",!!f,!!d,f?f(x):-1,d?*d:-1);
return 0; }
` },
    { ...{"id":"cpp-mangled-overloads","providerKind":"cpp","optional":true,"present":"1 1 1 14 23 1\n","absent":"0 0 0 -1 -1 -1\n","defined":false,"unused":false,"languages":["cpp"],"targets":["_ZN8Optional6targetEi","_ZN8Optional4dataE","_ZN8Optional6targetEd"],"binding":"weak"}, code: String.raw`#include <stdio.h>

namespace Optional { int target(int); double target(double); extern int data; }
static int ref_f(int) __attribute__((weakref("_ZN8Optional6targetEi")));
static double ref_real(double) __attribute__((weakref("_ZN8Optional6targetEd")));
static int ref_d __attribute__((weakref("_ZN8Optional4dataE")));
int (*volatile observed_f)(int)=ref_f;
double (*volatile observed_real)(double)=ref_real;
int *volatile observed_d=&ref_d;
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*f)(int)=observed_f; double (*r)(double)=observed_real; int *d=observed_d;
printf("%d %d %d %d %d %d\n",!!f,!!d,!!r,f?f(x):-1,d?*d:-1,r?(r(x)==x+0.5):-1);
return 0; }
` },
  ],
  "named-sites": [
    { ...{"id":"asm-names-address","providerKind":"asm","optional":true,"present":"1 1 14 23\n","absent":"0 0 -1 -1\n","defined":false,"unused":false,"languages":["c","cpp"],"targets":["custom.optional.function","custom.optional.storage"],"binding":"weak"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif

static int ref_f(int) __asm__("custom.ref.function") __attribute__((weakref("custom.optional.function")));
static int ref_d __asm__("custom.ref.storage") __attribute__((weakref("custom.optional.storage")));

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;
int (*f)(int)=observed_f; int *d=observed_d;
printf("%d %d %d %d\n",!!f,!!d,f?f(x):-1,d?*d:-1);
return 0; }
` },
    { ...{"id":"asm-names-direct","providerKind":"asm","optional":true,"present":"1 1 14 23\n","absent":"0 0 -1 -1\n","defined":false,"unused":false,"languages":["c","cpp"],"targets":["custom.optional.function","custom.optional.storage"],"binding":"weak"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif

static int ref_f(int) __asm__("custom.ref.function") __attribute__((weakref("custom.optional.function")));
static int ref_d __asm__("custom.ref.storage") __attribute__((weakref("custom.optional.storage")));

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;
int (*f)(int)=observed_f; int *d=observed_d;
printf("%d %d %d %d\n",!!f,!!d,f?ref_f(x):-1,d?ref_d:-1);
return 0; }
` },
    { ...{"id":"cpp-mangled-overloads-address","providerKind":"cpp","optional":true,"present":"1 1 1 14 23 1\n","absent":"0 0 0 -1 -1 -1\n","defined":false,"unused":false,"languages":["cpp"],"targets":["_ZN8Optional6targetEi","_ZN8Optional4dataE","_ZN8Optional6targetEd"],"binding":"weak"}, code: String.raw`#include <stdio.h>

namespace Optional { int target(int); double target(double); extern int data; }
static int ref_f(int) __attribute__((weakref("_ZN8Optional6targetEi")));
static double ref_real(double) __attribute__((weakref("_ZN8Optional6targetEd")));
static int ref_d __attribute__((weakref("_ZN8Optional4dataE")));
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*volatile observed_f)(int)=ref_f;
double (*volatile observed_real)(double)=ref_real;
int *volatile observed_d=&ref_d;
int (*f)(int)=observed_f; double (*r)(double)=observed_real; int *d=observed_d;
printf("%d %d %d %d %d %d\n",!!f,!!d,!!r,f?f(x):-1,d?*d:-1,r?(r(x)==x+0.5):-1);
return 0; }
` },
    { ...{"id":"cpp-mangled-overloads-direct","providerKind":"cpp","optional":true,"present":"1 1 1 14 23 1\n","absent":"0 0 0 -1 -1 -1\n","defined":false,"unused":false,"languages":["cpp"],"targets":["_ZN8Optional6targetEi","_ZN8Optional4dataE","_ZN8Optional6targetEd"],"binding":"weak"}, code: String.raw`#include <stdio.h>

namespace Optional { int target(int); double target(double); extern int data; }
static int ref_f(int) __attribute__((weakref("_ZN8Optional6targetEi")));
static double ref_real(double) __attribute__((weakref("_ZN8Optional6targetEd")));
static int ref_d __attribute__((weakref("_ZN8Optional4dataE")));
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*volatile observed_f)(int)=ref_f;
double (*volatile observed_real)(double)=ref_real;
int *volatile observed_d=&ref_d;
int (*f)(int)=observed_f; double (*r)(double)=observed_real; int *d=observed_d;
printf("%d %d %d %d %d %d\n",!!f,!!d,!!r,f?ref_f(x):-1,d?ref_d:-1,r?(ref_real(x)==x+0.5):-1);
return 0; }
` },
    { ...{"id":"asm-strong-first","providerKind":"asm","optional":false,"present":"1 1 1 1 1 1 14 23\n","absent":null,"defined":false,"unused":false,"languages":["c","cpp"],"targets":["custom.optional.function","custom.optional.storage"],"binding":"global"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
extern int optf(int) __asm__("custom.optional.function");
extern int optd __asm__("custom.optional.storage");
int (*volatile strong_f)(int)=optf;
int *volatile strong_d=&optd;
static int ref_f(int) __asm__("custom.ref.function") __attribute__((weakref("custom.optional.function")));
static int ref_d __asm__("custom.ref.storage") __attribute__((weakref("custom.optional.storage")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*sf)(int)=strong_f; int *sd=strong_d;
int (*wf)(int)=observed_f; int *wd=observed_d;
printf("%d %d %d %d %d %d %d %d\n",!!sf,!!sd,!!wf,!!wd,sf==wf,sd==wd,wf?wf(x):-1,wd?*wd:-1);
return 0; }
` },
    { ...{"id":"asm-weak-first","providerKind":"asm","optional":false,"present":"1 1 1 1 1 1 14 23\n","absent":null,"defined":false,"unused":false,"languages":["c","cpp"],"targets":["custom.optional.function","custom.optional.storage"],"binding":"global"}, code: String.raw`#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
static int ref_f(int) __asm__("custom.ref.function") __attribute__((weakref("custom.optional.function")));
static int ref_d __asm__("custom.ref.storage") __attribute__((weakref("custom.optional.storage")));
int (*volatile observed_f)(int)=ref_f;
int *volatile observed_d=&ref_d;
extern int optf(int) __asm__("custom.optional.function");
extern int optd __asm__("custom.optional.storage");
int (*volatile strong_f)(int)=optf;
int *volatile strong_d=&optd;

#ifdef __cplusplus
}
#endif
int main(void) { int x; if(scanf("%d", &x)!=1 || x!=3) return 2;
int (*sf)(int)=strong_f; int *sd=strong_d;
int (*wf)(int)=observed_f; int *wd=observed_d;
printf("%d %d %d %d %d %d %d %d\n",!!sf,!!sd,!!wf,!!wd,sf==wf,sd==wd,wf?wf(x):-1,wd?*wd:-1);
return 0; }
` },
  ],
};

const gnuSources = {
  "provider-weak": String.raw`extern "C" { int optf(int n){return n+11;} int optd=23; }
`,
  "consumer-weak": String.raw`#include <vector>
#include <string>
#include <stdio.h>
extern "C" { extern int optf(int) __attribute__((weak)); extern int optd __attribute__((weak)); }
int main(){ int n;if(scanf("%d",&n)!=1||n!=3)return 2;
 std::vector<int> values{n,n+1}; std::string label=std::string("weak-")+std::to_string(n);
 int (*volatile fp)(int)=optf; int *volatile dp=&optd; int (*f)(int)=fp;int*d=dp;
 printf("%d %s %d %d %d %d\n",values[0]+values[1],label.c_str(),!!f,!!d,f?f(n):-1,d?*d:-1);return 0; }
`,
  "provider-weakref": String.raw`extern "C" { int targetf(int n){return n+11;} int targetd=23; }
`,
  "consumer-weakref": String.raw`#include <vector>
#include <string>
#include <stdio.h>
extern "C" { static int optf(int) __attribute__((weakref("targetf"))); static int optd __attribute__((weakref("targetd"))); }
int main(){ int n;if(scanf("%d",&n)!=1||n!=3)return 2;
 std::vector<int> values{n,n+1}; std::string label=std::string("weak-")+std::to_string(n);
 int (*volatile fp)(int)=optf; int *volatile dp=&optd; int (*f)(int)=fp;int*d=dp;
 printf("%d %s %d %d %d %d\n",values[0]+values[1],label.c_str(),!!f,!!d,f?f(n):-1,d?*d:-1);return 0; }
`,
};

const families = ['gcc', 'clang'], languages = ['c', 'cpp'], optimizations = [0, 2];
const integerFunction = { params: ['i32'], results: ['i32'] };
function metadata(targets, binding, undefinedSymbol, unused = false) {
  return { targets, binding, undefined: undefinedSymbol, unused,
    functions: Object.fromEntries(targets.filter((_, index) => index !== 1).map(name =>
      [name, name.endsWith('targetEd') ? { params: ['f64'], results: ['f64'] } : integerFunction])) };
}
function weakrefNames(code) {
  const names = [];
  for (const declaration of code.split(';').filter(value => value.includes('weakref('))) {
    const name = declaration.match(/static\s+(?:int|double)\s+(\w+)/)?.[1];
    if (name) names.push(name);
    const assembly = declaration.match(/__asm__\("([^"]+)"\)/)?.[1];
    if (assembly) names.push(assembly);
  }
  return names;
}
function definedTargetAliases(code) {
  return code.split(';').filter(value => value.includes('weakref(')).map(declaration => {
    const name = declaration.match(/static\s+(?:int|double)\s+(\w+)/)?.[1];
    const assembly = declaration.match(/__asm__\("([^"]+)"\)/)?.[1];
    const target = declaration.match(/weakref\("([^"]+)"\)/)?.[1];
    if (!name || !target) throw new Error('Unrecognized weakref fixture declaration');
    return { name: assembly || name, target };
  });
}
export function createWeakrefMatrix() {
  const byId = new Map(), cases = [];
  function unit(suite, stem, compiler, language, optimization, code, expectedMetadata, provider = false) {
    const suffix = suite === 'gnu' ? (provider ? `-${compiler}-O${optimization}` : `-O${optimization}`)
      : `-${compiler}-${language}-${suite === 'core' ? '' : 'O'}${optimization}`;
    const id = `${suite}:${stem}${suffix}`;
    if (!byId.has(id)) byId.set(id, { id, suite, profile: stem, compiler, language, optimization,
      code, provider, gnuHeaders: suite === 'gnu' && !provider,
      expectedMetadata: structuredClone(expectedMetadata),
      // Clang's WASI definitions are hidden by default; weak binding is independent.
      expectedVisibility: !expectedMetadata.undefined && compiler === 'clang' ? 'hidden' : 'default',
      // GCC's generic optimize_weakref creates local aliases to locally bound definitions.
      expectedLocalAliases: compiler === 'gcc' && !provider && !expectedMetadata.undefined
        ? definedTargetAliases(code) : [],
      forbiddenAliasNames: weakrefNames(code) });
    return id;
  }
  function add(id, suite, units, stdout, rejection = false, duplicate = false) {
    const targets = byId.get(units[0]).expectedMetadata.targets;
    cases.push({ id: `${suite}:${id}`, suite, units, runtime: suite === 'gnu' ? 'gnu' : 'libc',
      stdin: '3\n', stdout, expectedLinkRejection: rejection,
      requiredLinkDiagnostics: rejection ? targets.map(name => `${duplicate ? 'duplicate' : 'undefined'} symbol: ${name}`) : [] });
  }
  function coreUnit(profile, compiler, language, optimization) {
    const provider = profile.startsWith('provider-');
    const weak = profile.startsWith('weak') || profile === 'provider-weak';
    return unit('core', profile, compiler, language, optimization, coreSources[profile],
      metadata(['optf', 'optd'], weak ? 'weak' : 'global', !provider), provider);
  }
  for (const language of languages) for (const optimization of optimizations) for (const compiler of families) {
    for (const binding of ['weak', 'weakref']) for (const site of ['initialized', 'address', 'direct']) {
      const profile = `${binding}-${site}`, consumer = coreUnit(profile, compiler, language, optimization);
      const prefix = `${profile}-${compiler}-${language}-O${optimization}`;
      add(`${prefix}-absent`, 'core', [consumer], '0 0 -1 -1\n');
      for (const provider of families) add(`${prefix}-present-${provider}`, 'core',
        [consumer, coreUnit('provider-strong', provider, language, optimization)], '1 1 14 23\n');
    }
    const consumer = coreUnit('strong-initialized', compiler, language, optimization);
    const prefix = `weak-definition-${compiler}-${language}-O${optimization}`;
    for (const weak of families) {
      const weakUnit = coreUnit('provider-weak', weak, language, optimization);
      add(`${prefix}-${weak}`, 'core', [consumer, weakUnit], '1 1 14 23\n');
      for (const strong of families) for (const order of ['weak-first', 'strong-first']) {
        const objects = [weakUnit, coreUnit('provider-override', strong, language, optimization)];
        if (order === 'strong-first') objects.reverse();
        add(`${prefix}-${weak}-override-${strong}-${order}`, 'core', [consumer, ...objects], '1 1 104 203\n');
      }
    }
    add(`strong-missing-${compiler}-${language}-O${optimization}`, 'core', [consumer], null, true);
    add(`strong-duplicate-${compiler}-${language}-O${optimization}`, 'core', [consumer,
      coreUnit('provider-strong', 'gcc', language, optimization), coreUnit('provider-override', 'clang', language, optimization)], null, true, true);
  }
  for (const optimization of optimizations) for (const binding of ['weak', 'weakref']) {
    const targets = binding === 'weak' ? ['optf', 'optd'] : ['targetf', 'targetd'];
    const providerIds = Object.fromEntries(families.map(compiler => [compiler,
      unit('gnu', `provider-${binding}`, compiler, 'cpp', optimization, gnuSources[`provider-${binding}`], metadata(targets, 'global', false), true)]));
    const consumer = unit('gnu', `gnu-${binding}`, 'gcc', 'cpp', optimization,
      gnuSources[`consumer-${binding}`], metadata(targets, 'weak', true));
    for (const provider of [null, ...families]) add(`${binding}-O${optimization}-${provider || 'absent'}`, 'gnu',
      [consumer, ...(provider ? [providerIds[provider]] : [])], `7 weak-3 ${provider ? '1 1 14 23' : '0 0 -1 -1'}\n`);
  }
  for (const [suite, profiles] of Object.entries(boundaryProfiles)) for (const profile of profiles)
    for (const language of profile.languages) for (const optimization of optimizations) for (const compiler of families) {
      const consumer = unit(suite, profile.id, compiler, language, optimization, profile.code,
        metadata(profile.targets, profile.binding, !profile.defined, profile.unused));
      for (const provider of profile.defined || profile.unused ? [null] : [null, ...families]) {
        const units = [consumer];
        if (provider) units.push(unit(suite, `provider-${profile.providerKind}`, provider, language, optimization,
          providers[profile.providerKind], metadata(profile.targets, 'global', false), true));
        add(`${profile.id}-${compiler}-${language}-O${optimization}-${provider || 'absent'}`, suite, units,
          provider || profile.defined ? profile.present : profile.absent,
          !profile.optional && !profile.defined && !provider);
      }
    }
  return { units: [...byId.values()], cases };
}
export const { units, cases } = createWeakrefMatrix();
export const requiredCounts = Object.freeze({ units: 232, cases: 528, runtimePasses: 480, linkRejections: 48 });
export const compilerDifferences = Object.freeze([
  'Clang WASI definitions use hidden visibility by default; binding and visibility are checked independently.',
  'External weakref declarations disappear from linking symbols; references name the target, including explicit assembly names and C++ overloads.',
  'For same-unit locally bound definitions GCC retains local aliases with the same function body or data storage; Clang references the target directly.',
  'GNU library consumers use GCC with the same-source libstdc++ headers; their optional providers are compiled with both GCC and Clang.'
]);
