// GNU RTTI is opt-in at the SDK boundary. Here 'default' means an omitted
// native frontend RTTI flag; the SDK default still explicitly uses -fno-rtti.
export const profiles = [
  {
    "id": "single",
    "files": {
      "classes.hpp": "#pragma once\n#include <typeinfo>\nstruct Base { int value; Base(); virtual ~Base(); virtual int id()const; };\nstruct Derived:Base { Derived(); ~Derived(); int id()const override; };\nstruct Other:Base { Other(); ~Other(); int id()const override; };\nBase* make(int,int);const void* top(int);const std::type_info* info(int);int probe(Base*,int);\n",
      "provider.cc": "#include \"classes.hpp\"\nBase::Base():value(0){} Base::~Base(){} int Base::id()const{return value;}\nDerived::Derived(){} Derived::~Derived(){} int Derived::id()const{return value+10;}\nOther::Other(){} Other::~Other(){} int Other::id()const{return value+20;}\nstatic Derived a;static Other b;Base* make(int c,int n){a.value=b.value=n;return c?(Base*)&a:(Base*)&b;}\nconst void* top(int c){return c?(const void*)&a:(const void*)&b;}\nconst std::type_info* info(int c){return c?&typeid(Derived):&typeid(Other);}\n",
      "main.cc": "#include \"classes.hpp\"\n#include <cstdio>\nint main(){int choice,value;if(std::scanf(\"%d%d\",&choice,&value)!=2)return 2;\n  Base* p=make(choice,value); int mask=probe(p,choice);\n  std::printf(\"single %d %d\\n\",mask,p->id());return 0;}\nint probe(Base*p,int c){int m=0;m|=((dynamic_cast<Derived*>(p)!=nullptr)==bool(c))?1:0;\nm|=((dynamic_cast<Other*>(p)!=nullptr)==!bool(c))?2:0;m|=dynamic_cast<void*>(p)==top(c)?4:0;\nm|=typeid(*p)==(c?typeid(Derived):typeid(Other))?8:0;m|=&typeid(*p)==info(c)?16:0;\nm|=typeid(int)==typeid(const int)?32:0;m|=dynamic_cast<Derived*>((Base*)nullptr)==nullptr?64:0;return m;}\n"
    },
    "providerUnits": [
      "provider.cc"
    ],
    "consumerUnits": [
      "main.cc"
    ],
    "inputs": [
      {
        "stdin": "1 7\n",
        "stdout": "single 127 17\n"
      },
      {
        "stdin": "0 11\n",
        "stdout": "single 127 31\n"
      }
    ],
    "classes": [
      "Base",
      "Derived",
      "Other"
    ]
  },
  {
    "id": "multiple",
    "files": {
      "classes.hpp": "#pragma once\n#include <typeinfo>\nstruct Base{int value;Base();virtual ~Base();virtual int id()const;};\nstruct Right{int marker;Right();virtual ~Right();virtual int right()const;};\nstruct Joined:Base,Right{Joined();~Joined();int id()const override;int right()const override;};\nstruct Only:Base{Only();~Only();int id()const override;};\nBase* make(int,int);const void* top(int);const std::type_info* info(int);int probe(Base*,int);\n",
      "provider.cc": "#include \"classes.hpp\"\nBase::Base():value(0){} Base::~Base(){} int Base::id()const{return value;}\nRight::Right():marker(9){} Right::~Right(){} int Right::right()const{return marker;}\nJoined::Joined(){} Joined::~Joined(){} int Joined::id()const{return value+30;} int Joined::right()const{return value+300;}\nOnly::Only(){} Only::~Only(){} int Only::id()const{return value+40;}\nstatic Joined a;static Only b;Base* make(int c,int n){a.value=b.value=n;return c?(Base*)&a:(Base*)&b;}\nconst void* top(int c){return c?(const void*)&a:(const void*)&b;}\nconst std::type_info* info(int c){return c?&typeid(Joined):&typeid(Only);}\n",
      "main.cc": "#include \"classes.hpp\"\n#include <cstdio>\nint main(){int choice,value;if(std::scanf(\"%d%d\",&choice,&value)!=2)return 2;\n  Base* p=make(choice,value); int mask=probe(p,choice);\n  std::printf(\"multiple %d %d\\n\",mask,p->id());return 0;}\nint probe(Base*p,int c){Right*r=dynamic_cast<Right*>(p);int m=0;\nm|=((dynamic_cast<Joined*>(p)!=nullptr)==bool(c))?1:0;m|=((r!=nullptr)==bool(c))?2:0;\nm|=dynamic_cast<void*>(p)==top(c)?4:0;m|=typeid(*p)==(c?typeid(Joined):typeid(Only))?8:0;\nm|=&typeid(*p)==info(c)?16:0;m|=!r||(dynamic_cast<Base*>(r)==p&&dynamic_cast<void*>(r)==top(c)&&(const void*)r!=(const void*)p&&r->right()==p->value+300)?32:0;\nm|=dynamic_cast<Right*>((Base*)nullptr)==nullptr?64:0;return m;}\n"
    },
    "providerUnits": [
      "provider.cc"
    ],
    "consumerUnits": [
      "main.cc"
    ],
    "inputs": [
      {
        "stdin": "1 7\n",
        "stdout": "multiple 127 37\n"
      },
      {
        "stdin": "0 11\n",
        "stdout": "multiple 127 51\n"
      }
    ],
    "classes": [
      "Base",
      "Right",
      "Joined",
      "Only"
    ]
  },
  {
    "id": "virtual",
    "files": {
      "classes.hpp": "#pragma once\n#include <typeinfo>\nstruct Base{int value;Base();virtual ~Base();virtual int id()const;};\nstruct Left:virtual Base{Left();virtual ~Left();};struct Right:virtual Base{Right();virtual ~Right();};\nstruct Diamond:Left,Right{Diamond();~Diamond();int id()const override;};struct Only:Base{Only();~Only();int id()const override;};\nBase* make(int,int);const void* top(int);const std::type_info* info(int);int probe(Base*,int);\n",
      "provider.cc": "#include \"classes.hpp\"\nBase::Base():value(0){} Base::~Base(){} int Base::id()const{return value;}\nLeft::Left(){} Left::~Left(){} Right::Right(){} Right::~Right(){}\nDiamond::Diamond(){} Diamond::~Diamond(){} int Diamond::id()const{return value+50;}\nOnly::Only(){} Only::~Only(){} int Only::id()const{return value+60;}\nstatic Diamond a;static Only b;Base* make(int c,int n){a.value=b.value=n;return c?(Base*)&a:(Base*)&b;}\nconst void* top(int c){return c?(const void*)&a:(const void*)&b;}\nconst std::type_info* info(int c){return c?&typeid(Diamond):&typeid(Only);}\n",
      "main.cc": "#include \"classes.hpp\"\n#include <cstdio>\nint main(){int choice,value;if(std::scanf(\"%d%d\",&choice,&value)!=2)return 2;\n  Base* p=make(choice,value); int mask=probe(p,choice);\n  std::printf(\"virtual %d %d\\n\",mask,p->id());return 0;}\nint probe(Base*p,int c){Left*l=dynamic_cast<Left*>(p);Right*r=dynamic_cast<Right*>(p);int m=0;\nm|=((dynamic_cast<Diamond*>(p)!=nullptr)==bool(c))?1:0;m|=((l!=nullptr)==bool(c)&&(r!=nullptr)==bool(c))?2:0;\nm|=dynamic_cast<void*>(p)==top(c)?4:0;m|=typeid(*p)==(c?typeid(Diamond):typeid(Only))?8:0;\nm|=&typeid(*p)==info(c)?16:0;m|=!l||(static_cast<Base*>(l)==static_cast<Base*>(r)&&dynamic_cast<Right*>(l)==r)?32:0;\nm|=dynamic_cast<Diamond*>((Base*)nullptr)==nullptr?64:0;return m;}\n"
    },
    "providerUnits": [
      "provider.cc"
    ],
    "consumerUnits": [
      "main.cc"
    ],
    "inputs": [
      {
        "stdin": "1 7\n",
        "stdout": "virtual 127 57\n"
      },
      {
        "stdin": "0 11\n",
        "stdout": "virtual 127 71\n"
      }
    ],
    "classes": [
      "Base",
      "Left",
      "Right",
      "Diamond",
      "Only"
    ]
  },
  {
    "id": "weak-typeinfo",
    "files": {
      "classes.hpp": "#pragma once\n#include <typeinfo>\nstruct Base{int value=0;virtual ~Base(){}virtual int id()const{return value;}};\nstruct Child:Base{int id()const override{return value+70;}};struct Other:Base{int id()const override{return value+80;}};\nBase* make(int,int);const void* top(int);const std::type_info* info(int);const std::type_info* peer(int);int probe(Base*,int);\n",
      "provider.cc": "#include \"classes.hpp\"\nstatic Child a;static Other b;Base* make(int c,int n){a.value=b.value=n;return c?(Base*)&a:(Base*)&b;}\nconst void* top(int c){return c?(const void*)&a:(const void*)&b;}const std::type_info* info(int c){return c?&typeid(Child):&typeid(Other);}\n",
      "main.cc": "#include \"classes.hpp\"\n#include <cstdio>\nint main(){int choice,value;if(std::scanf(\"%d%d\",&choice,&value)!=2)return 2;\n  Base* p=make(choice,value); int mask=probe(p,choice);\n  std::printf(\"weak-typeinfo %d %d\\n\",mask,p->id());return 0;}\nint probe(Base*p,int c){int m=0;m|=((dynamic_cast<Child*>(p)!=nullptr)==bool(c))?1:0;\nm|=((dynamic_cast<Other*>(p)!=nullptr)==!bool(c))?2:0;m|=dynamic_cast<void*>(p)==top(c)?4:0;\nm|=typeid(*p)==(c?typeid(Child):typeid(Other))?8:0;m|=&typeid(*p)==info(c)?16:0;\nm|=peer(c)==info(c)?32:0;m|=dynamic_cast<Child*>((Base*)nullptr)==nullptr?64:0;return m;}\n",
      "peer.cc": "#include \"classes.hpp\"\nconst std::type_info* peer(int c){return c?&typeid(Child):&typeid(Other);}\n"
    },
    "providerUnits": [
      "provider.cc",
      "peer.cc"
    ],
    "consumerUnits": [
      "main.cc"
    ],
    "inputs": [
      {
        "stdin": "1 7\n",
        "stdout": "weak-typeinfo 127 77\n"
      },
      {
        "stdin": "0 11\n",
        "stdout": "weak-typeinfo 127 91\n"
      }
    ],
    "classes": [
      "Base",
      "Child",
      "Other"
    ]
  },
  {
    "id": "gnu-base",
    "files": {
      "classes.hpp": "#pragma once\n#include <typeinfo>\n#include <exception>\nstruct Base:std::exception {int value;Base();~Base() noexcept;virtual int id()const;};\nstruct Derived:Base{Derived();~Derived() noexcept;int id()const override;};struct Other:Base{Other();~Other() noexcept;int id()const override;};\nBase* make(int,int);const void* top(int);const std::type_info* info(int);int probe(Base*,int);\n",
      "provider.cc": "#include \"classes.hpp\"\nBase::Base():value(0){}Base::~Base()noexcept{}int Base::id()const{return value;}\nDerived::Derived(){}Derived::~Derived()noexcept{}int Derived::id()const{return value+90;}\nOther::Other(){}Other::~Other()noexcept{}int Other::id()const{return value+100;}\nstatic Derived a;static Other b;Base* make(int c,int n){a.value=b.value=n;return c?(Base*)&a:(Base*)&b;}\nconst void* top(int c){return c?(const void*)&a:(const void*)&b;}const std::type_info* info(int c){return c?&typeid(Derived):&typeid(Other);}\n",
      "main.cc": "#include \"classes.hpp\"\n#include <cstdio>\nint main(){int choice,value;if(std::scanf(\"%d%d\",&choice,&value)!=2)return 2;\n  Base* p=make(choice,value); int mask=probe(p,choice);\n  std::printf(\"gnu-base %d %d\\n\",mask,p->id());return 0;}\nint probe(Base*p,int c){const std::exception*e=p;int m=0;m|=((dynamic_cast<const Derived*>(e)!=nullptr)==bool(c))?1:0;\nm|=((dynamic_cast<const Other*>(e)!=nullptr)==!bool(c))?2:0;m|=dynamic_cast<const void*>(e)==top(c)?4:0;\nm|=typeid(*e)==(c?typeid(Derived):typeid(Other))?8:0;m|=&typeid(*p)==info(c)?16:0;\nm|=typeid(std::exception)!=typeid(Base)?32:0;m|=dynamic_cast<const Derived*>((std::exception*)nullptr)==nullptr?64:0;return m;}\n"
    },
    "providerUnits": [
      "provider.cc"
    ],
    "consumerUnits": [
      "main.cc"
    ],
    "inputs": [
      {
        "stdin": "1 7\n",
        "stdout": "gnu-base 127 97\n"
      },
      {
        "stdin": "0 11\n",
        "stdout": "gnu-base 127 111\n"
      }
    ],
    "classes": [
      "Base",
      "Derived",
      "Other"
    ]
  }
];

export const units = [], cases = [], diagnostics = [], exceptionBoundaries = [];
const compilers = ['gcc', 'clang'], optimizations = [0, 2];
const unitId = (profile, file, compiler, optimization) => `${profile}:${file.replace(/\./g, '-')}:${compiler}:O${optimization}`;
const signature = { params: ['i32', 'i32', 'i32', 'i32'], results: ['i32'] };
const symbol = (name, binding, undefinedValue, visibility, relocationTypes) =>
  ({ name, kind: 'data', binding, undefined: undefinedValue, visibility, relocationTypes });
function addUnit(value) {
  const unit = { language: 'cpp', standard: 'gnu++17', rtti: 'enabled', runtime: 'gnu', flags: [],
    expectedRttiSymbols: [], expectedFunctions: {}, forbiddenRtti: false, headers: {}, ...value };
  units.push(unit); return unit;
}
function addCase(value) {
  cases.push({ runtime: 'gnu', stdin: null, stdout: null, expectedLinkRejection: false,
    requiredLinkDiagnostics: [], ...value });
}
for (const profile of profiles) {
  for (const optimization of optimizations) for (const compiler of compilers) {
    for (const file of [...profile.providerUnits, ...profile.consumerUnits]) {
      const provider = profile.providerUnits.includes(file), vague = profile.id === 'weak-typeinfo';
      const definition = provider || vague, visibility = definition && compiler === 'clang' ? 'hidden' : 'default';
      const binding = definition ? (compiler === 'gcc' || vague ? 'weak' : 'global') : 'global';
      const expected = profile.classes.flatMap(name => {
        // The GNU-base consumer casts from std::exception, while Base appears
        // only in a constant typeid inequality that Clang can fold at O2.
        if (!provider && profile.id === 'gnu-base' && name === 'Base') return [];
        const encoded = name.length + name;
        return [symbol('_ZTI' + encoded, binding, !definition, visibility, definition ? [4, 5] : [4]),
          ...(definition ? [symbol('_ZTS' + encoded, binding, false, visibility, [5])] : [])];
      });
      if (file === 'provider.cc') for (const name of profile.classes) {
        // The inline base has no standalone instance. Clang omits its vtable,
        // and GCC also removes it at O2; its typeinfo/name remain required.
        if (vague && name === 'Base' && (compiler === 'clang' || optimization === 2)) continue;
        expected.push(symbol('_ZTV' + name.length + name, binding, false, visibility, [4, 5]));
      }
      if (profile.id === 'gnu-base') expected.push(symbol('_ZTISt9exception', 'global', true, 'default', [4, 5]));
      addUnit({ id: unitId(profile.id, file, compiler, optimization), suite: 'hierarchy', profile: profile.id,
        file, compiler, optimization, role: provider ? 'provider' : 'consumer',
        code: profile.files[file], headers: { 'classes.hpp': profile.files['classes.hpp'] },
        expectedRttiSymbols: expected,
        expectedFunctions: { ...(!provider ? { __dynamic_cast: signature } : {}),
          ...(profile.id === 'gnu-base' && file === 'provider.cc' ? {
            _ZNSt9exceptionD2Ev: { params: ['i32'], results: compiler === 'clang' ? ['i32'] : [] } } : {}) } });
    }
  }
  for (const optimization of optimizations) for (const provider of compilers) for (const consumer of compilers) {
    const base = `${profile.id}:O${optimization}:${provider}-provider:${consumer}-consumer`;
    const objects = [...profile.providerUnits.map(file => unitId(profile.id, file, provider, optimization)),
      ...profile.consumerUnits.map(file => unitId(profile.id, file, consumer, optimization))];
    // This pre-existing C++ destructor ABI disagreement is deliberately rejected
    // with fatal warnings. It is separate from RTTI and is never a success oracle.
    if (profile.id === 'gnu-base' && provider === 'clang') addCase({ id: base + ':abi-rejection',
      profile: profile.id, units: objects, expectedLinkRejection: true,
      requiredLinkDiagnostics: ['function signature mismatch: _ZNSt9exceptionD2Ev', '(i32) -> i32', '(i32) -> void'] });
    else for (const [index, input] of profile.inputs.entries()) addCase({ id: base + ':input-' + index,
      profile: profile.id, units: objects, ...input });
  }
}
const controlCode = `#include <cstdio>
#ifdef __GXX_RTTI
#include <typeinfo>
#endif
struct B{virtual ~B(){}virtual int value()const=0;};
struct D:B{int n;explicit D(int x):n(x){}int value()const override{return n+3;}};
int main(){int n;if(std::scanf("%d",&n)!=1)return 2;D d(n);B*volatile hold=&d;B*p=hold;int rtti=0;
#ifdef __GXX_RTTI
rtti=(typeid(*p)==typeid(D)&&dynamic_cast<D*>(p)==&d)?1:-1;
#endif
std::printf("profile %d %d\\n",rtti,p->value());}
`;
for (const compiler of compilers) for (const optimization of optimizations) for (const rtti of ['enabled', 'disabled', 'default']) {
  const id = `frontend-profile:${compiler}:O${optimization}:${rtti}`;
  addUnit({ id, suite: 'frontend-profile', profile: 'frontend-profile', file: 'main.cc', compiler, optimization,
    rtti, code: controlCode, forbiddenRtti: rtti === 'disabled' });
  addCase({ id, profile: 'frontend-profile', units: [id], stdin: '9\n', stdout: `profile ${rtti === 'disabled' ? 0 : 1} 12\n` });
}
// Ordinary C tentative definitions do not use make_decl_one_only. Their current
// strong Wasm binding remains explicit, including duplicate-definition rejection.
for (const optimization of optimizations) {
  const consumer = `c-common:consumer:O${optimization}`;
  addUnit({ id: consumer, suite: 'c-common', profile: 'c-common', language: 'c', standard: 'gnu11',
    compiler: 'gcc', optimization, rtti: 'none', runtime: 'c', file: 'main.c',
    code: '#include <stdio.h>\nextern int common_value;int main(){if(scanf("%d",&common_value)!=1)return 2;printf("common %d\\n",common_value+4);}\n',
    expectedRttiSymbols: [symbol('common_value', 'global', true, 'default', [4])], forbiddenRtti: true });
  for (const common of ['common', 'no-common']) {
    const provider = `c-common:provider:O${optimization}:${common}`, duplicate = `c-common:duplicate:O${optimization}:${common}`;
    for (const id of [provider, duplicate]) addUnit({ id, suite: 'c-common', profile: 'c-common', language: 'c',
      standard: 'gnu11', compiler: 'gcc', optimization, rtti: 'none', runtime: 'c', file: 'definition.c',
      flags: ['-f' + common], code: 'int common_value;\n', forbiddenRtti: true,
      expectedRttiSymbols: [symbol('common_value', 'global', false, 'default', [])] });
    addCase({ id: provider + ':present', profile: 'c-common', runtime: 'c', units: [provider, consumer], stdin: '13\n', stdout: 'common 17\n' });
    addCase({ id: provider + ':duplicate', profile: 'c-common', runtime: 'c', units: [provider, duplicate, consumer],
      expectedLinkRejection: true, requiredLinkDiagnostics: ['duplicate symbol: common_value'] });
  }
}
const boundarySources = [
  { profile: 'reference-failure', requiredRuntimeSymbol: '__cxa_bad_cast', code: `#include <typeinfo>
struct B{virtual ~B(){}};struct D:B{};
D& cast(B*p){return dynamic_cast<D&>(*p);}int main(){B b;return &cast(&b)==nullptr;}
` },
  { profile: 'null-polymorphic-typeid', requiredRuntimeSymbol: '__cxa_bad_typeid', code: `#include <typeinfo>
struct B{virtual ~B(){}};
const std::type_info& identify(B*p){return typeid(*p);}int main(){return identify(nullptr).name()[0];}
` },
];
for (const boundary of boundarySources) for (const compiler of compilers) for (const optimization of optimizations) {
  const id = `${boundary.profile}:${compiler}:O${optimization}`;
  addUnit({ id, suite: 'exception-boundary', ...boundary, file: 'main.cc', compiler, optimization,
    expectedFunctions: { [boundary.requiredRuntimeSymbol]: { params: [], results: [] } } });
  exceptionBoundaries.push({ id, units: [id], runtime: 'gnu', requiredRuntimeSymbol: boundary.requiredRuntimeSymbol,
    execution: 'not executed: exception-dependent failure is outside the supported no-exceptions contract' });
}
for (const compiler of compilers) for (const optimization of optimizations) for (const operation of ['typeid', 'dynamic-cast']) {
  diagnostics.push({ id: `rtti-disabled:${operation}:${compiler}:O${optimization}`, compiler, optimization, language: 'cpp',
    standard: 'gnu++17', rtti: 'disabled', suite: 'diagnostic', flags: [], headers: {},
    code: '#include <typeinfo>\nstruct B{virtual ~B(){}};struct D:B{};\n' + (operation === 'typeid'
      ? 'const std::type_info& identify(B*p){return typeid(*p);}\n' : 'D* cast(B*p){return dynamic_cast<D*>(p);}\n'),
    requiredDiagnostics: compiler === 'gcc' ? ['-fno-rtti', operation === 'typeid' ? 'typeid' : 'dynamic_cast']
      : [operation === 'typeid' ? 'typeid' : 'dynamic_cast', '-frtti'] });
}
export const requiredCounts = { units: 74, cases: 96, runtimePasses: 88, linkRejections: 8,
  exceptionBoundaries: 8, diagnostics: 8 };
export const wasiRunnerSource = "import{WASI}from'node:wasi';import{readFile}from'node:fs/promises';const w=new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});process.exitCode=w.start(await WebAssembly.instantiate(await WebAssembly.compile(await readFile(process.argv[2])),{wasi_snapshot_preview1:w.wasiImport}));\n";
