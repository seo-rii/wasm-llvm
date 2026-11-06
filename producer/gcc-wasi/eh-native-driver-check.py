#!/usr/bin/env python3
from pathlib import Path
import argparse,hashlib,json,os,subprocess,time
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--work',type=Path,required=True);p.add_argument('--sdk',type=Path,required=True);p.add_argument('--abi-root',type=Path,required=True);a=p.parse_args();repo=Path(__file__).resolve().parents[2];w=a.work.resolve();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False);(out/'as').symlink_to(w/'wabt-native/wat2wasm');(out/'tmp').mkdir();cc=w/'gcc-native/gcc';sdk=a.sdk.resolve()
def identity(p):return {'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
inputs=[Path(__file__),repo/'producer/gcc-wasi/sources.lock.json',w/'native-build.json',w/'native-driver.specs',cc/'xgcc',cc/'cc1',cc/'cc1plus',w/'wabt-native/wat2wasm',w/'wabt-native/wasm-objdump',sdk/'bin/wasm-ld',sdk/'share/wasi-sysroot/lib/wasm32-wasi/eh/libunwind.a'];inputs += [a.abi_root.resolve()/f'unwind-abi-{lang}-o{o}/abi.o' for lang in ('c','cpp') for o in ('0','2')];frozen=[identity(p) for p in inputs]
report={'kind':'actual-gcc-EH-driver-controls','status':'running','inputs':frozen,'cases':[],'startedUnix':time.time()}
def save():(out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
def run(argv,d,n):
 r=subprocess.run(list(map(str,argv)),cwd=d,capture_output=True,timeout=35,env={**os.environ,'TMPDIR':str(out/'tmp'),'LC_ALL':'C'});
 for kind,value in [('stdout',r.stdout),('stderr',r.stderr)]:(d/(n+'.'+kind)).write_bytes(value)
 return {'argv':list(map(str,argv)),'exitCode':r.returncode,'stdout':identity(d/(n+'.stdout')),'stderr':identity(d/(n+'.stderr'))}
profiles=[('default',[],False,''),('explicit-off',['-mno-exception-handling'],False,''),('enabled',['-mexception-handling'],True,''),('last-on',['-mno-exception-handling','-mexception-handling'],True,''),('last-off',['-mexception-handling','-mno-exception-handling'],False,''),('pragma-language-only',[],False,'#pragma GCC optimize ("exceptions")\n'),('attribute-language-only',[],False,'#define ATTR __attribute__((optimize("exceptions")))\n'),('pragma-target-attempt',[],False,'#pragma GCC target ("exception-handling")\n')]
base=[cc/'xgcc','-B'+str(out)+'/', '-B'+str(cc)+'/', '-specs='+str(w/'native-driver.specs'),'-std=c++17','-g0','-fexceptions','-fdiagnostics-color=never','-save-temps=obj']
try:
 for name,flags,enabled,prefix in profiles:
  for opt in ('0','2'):
   d=out/(name+'-o'+opt);d.mkdir();src=d/'probe.cpp';obj=d/'probe.o'
   src.write_text(prefix+'''#ifndef ATTR
#define ATTR
#endif
#if defined(__WASM_EXCEPTIONS__) != '''+str(int(enabled))+''' || defined(__wasm_exception_handling__) != '''+str(int(enabled))+'''
#error Incorrect effective target feature macros
#endif
extern int source();
ATTR int probe() { try { return source(); } catch(int x) { return x+1; } }
''')
   c={'id':d.name,'expectedEnabled':enabled,'source':identity(src)};report['cases'].append(c);c['compile']=run([*base,*flags,'-O'+opt,'-v','-c',src,'-o',obj],d,'compile')
   if c['compile']['exitCode']==0:
    c['object']=identity(obj);c['wat']=identity(d/'probe.s');c['preprocessed']=identity(d/'probe.ii');c['inspect']=run([w/'wabt-native/wasm-objdump','-x','-d','-r',obj],d,'inspect');text=(d/'inspect.stdout').read_text();c['hasTryTable']='try_table' in text;c['hasExceptionFeature']='exception-handling' in text
   c['passed']=c['compile']['exitCode']==0 and c.get('inspect',{}).get('exitCode')==0 and c['hasTryTable']==enabled and c['hasExceptionFeature']==enabled;save()
 # GNU C++98 catch-all plus throw() has a null RTTI entry immediately before
 # its exception-specification bytes. These must remain separate WAT tokens.
 for opt in ('0','2'):
  d=out/('ehspec-catchall-o'+opt);d.mkdir();src=d/'probe.cpp';obj=d/'probe.o';src.write_text('extern void source(); void f() throw() { try { source(); } catch (...) {} }\n')
  c={'id':d.name,'expectedEnabled':True,'source':identity(src)};report['cases'].append(c);c['compile']=run([*base,'-std=c++98','-mexception-handling','-O'+opt,'-v','-c',src,'-o',obj],d,'compile')
  if c['compile']['exitCode']==0:
   c['object']=identity(obj);c['wat']=identity(d/'probe.s');c['preprocessed']=identity(d/'probe.ii');c['inspect']=run([w/'wabt-native/wasm-objdump','-x','-d','-r',obj],d,'inspect');text=(d/'inspect.stdout').read_text();c['hasTryTable']='try_table' in text;c['hasExceptionFeature']='exception-handling' in text
  c['passed']=c['compile']['exitCode']==0 and c.get('inspect',{}).get('exitCode')==0 and c['hasTryTable'] and c['hasExceptionFeature'];save()
 for name,flags,fragment in [('debug',['-g'],'does not support debug'),('pic',['-fPIC'],'requires static non-PIC'),('non-call',['-fnon-call-exceptions'],'does not support non-call exceptions')]:
  d=out/name;d.mkdir();src=d/'probe.cpp';src.write_text('int probe(){return 4;}\n');c={'id':name,'kind':'expected-rejection'};report['cases'].append(c);c['compile']=run([*base,'-mexception-handling',*flags,'-S',src,'-o',d/'probe.wat'],d,'compile');c['passed']=c['compile']['exitCode']!=0 and fragment in (d/'compile.stderr').read_text();save()
 # Genuine pinned LLVM unwinder partial link catches width mismatches independently.
 for language in ('c','cpp'):
  for opt in ('0','2'):
   d=out/f'partial-{language}-o{opt}';d.mkdir();input=a.abi_root.resolve()/f'unwind-abi-{language}-o{opt}/abi.o';assert input.exists();c={'id':d.name,'kind':'actual-unwind-ABI-link','input':identity(input)};report['cases'].append(c);c['link']=run([sdk/'bin/wasm-ld','--fatal-warnings','-r',input,sdk/'share/wasi-sysroot/lib/wasm32-wasi/eh/libunwind.a','-o',d/'combined.o'],d,'link');c['passed']=c['link']['exitCode']==0
   if c['passed']:c['combined']=identity(d/'combined.o')
   save()
 report['counts']={'driverCompiles':18,'expectedDiagnostics':3,'unwindAbiPartialLinks':4}
 report['status']='passed' if all(c['passed'] for c in report['cases']) else 'failed'
finally:
 report['inputsUnchanged']=frozen==[identity(p) for p in inputs];report['completedUnix']=time.time();save()
print(json.dumps({'status':report['status'],'passed':sum(c.get('passed',False) for c in report['cases']),'count':len(report['cases'])}));raise SystemExit(report['status']!='passed')
