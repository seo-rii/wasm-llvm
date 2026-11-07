#!/usr/bin/env python3
"""Actual native GCC EH object lowering and unwind ABI checks; GNU execution is separate."""
from pathlib import Path
import argparse,hashlib,json,os,resource,subprocess,time
A=argparse.ArgumentParser();A.add_argument('--output',required=True,type=Path);A.add_argument('--work',required=True,type=Path);A.add_argument('--node',required=True);A.add_argument('--sdk',required=True,type=Path);a=A.parse_args()
repo=Path(__file__).resolve().parents[2];here=repo/'producer/gcc-wasi';work=a.work.resolve();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
cc=work/'gcc-native/gcc';assembler=work/'wabt-native/wat2wasm';dump=work/'wabt-native/wasm-objdump';ld=a.sdk.resolve()/'bin/wasm-ld'
(out/'tmp').mkdir();(out/'as').symlink_to(assembler)
inputs=[Path(__file__),here/'eh-native-fixtures.mjs',here/'sources.lock.json',here/'build-native.sh',work/'native-driver.specs',work/'native-build.json',cc/'xgcc',cc/'cc1',cc/'cc1plus',assembler,dump,ld,work/'gcc/libgcc/unwind-generic.h',Path(a.node).resolve()]
def ident(p):
 p=Path(p);return {'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.file_digest(p.open('rb'),'sha256').hexdigest()}
frozen=[ident(p) for p in inputs]
report={'kind':'gcc-wasi-native-eh-compiler','status':'running','startedUnix':time.time(),'inputs':frozen,'cases':[],'gnuRuntimeExecuted':False,'nativeFixture':ident(here/'eh-native-fixtures.mjs'), 'gccSource':json.loads((work/'native-build.json').read_text())['gccSource'],'nativeBuild':ident(work/'native-build.json')}
def save(): (out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
def run(argv,cwd,label):
 r=subprocess.run(list(map(str,argv)),cwd=cwd,env={**os.environ,'TMPDIR':str(out/'tmp'),'LC_ALL':'C'},capture_output=True,timeout=45)
 for k,d in [('stdout',r.stdout),('stderr',r.stderr)]: (cwd/f'{label}.{k}').write_bytes(d)
 return {'argv':list(map(str,argv)),'exitCode':r.returncode,'stdout':ident(cwd/f'{label}.stdout'),'stderr':ident(cwd/f'{label}.stderr')}
base=[cc/'xgcc','-B'+str(cc)+'/', '-specs='+str(work/'native-driver.specs'),'-g0','-fdiagnostics-color=never']
try:
 js=f"import {{nativeEhCases}} from {json.dumps((here/'eh-native-fixtures.mjs').as_uri())}; process.stdout.write(JSON.stringify(nativeEhCases));"
 fixtures=json.loads(subprocess.check_output([a.node,'--input-type=module','-e',js]));assert len(fixtures)==14
 (out/'fixtures.json').write_text(json.dumps(fixtures,indent=2)+'\n')
 for f in fixtures:
  d=out/f['id'];d.mkdir();req=f['request'];(d/'main.cpp').write_text(req['code'])
  for item in req.get('files',[]):(d/item['path']).write_text(item['contents'])
  c={'id':f['id'],'kind':'gnu-fixture-compile','units':[]};report['cases'].append(c)
  for i,n in enumerate(['main.cpp',*req.get('sources',[])]):
   u={'source':ident(d/n)};c['units'].append(u);wat=d/f'unit{i}.wat';obj=d/f'unit{i}.o'
   u['compile']=run([*base,'-S','-x','c++','-std=c++17','-O'+req['optimization'],'-mexception-handling','-fexceptions','-fdump-tree-eh','-fdump-rtl-final','-dumpdir',str(d)+'/',d/n,'-o',wat],d,f'compile{i}')
   if u['compile']['exitCode']==0:
    u['wat']=ident(wat);text=wat.read_text();u['modernEvidence']={'tryTable':'try_table' in text,'throwRef':'throw_ref' in text,'lsda':'(data (@sym (align 4))' in text and '__gcc_wasm_lsda_' in text,'legacyTry':'(try ' in text}
    u['assemble']=run([assembler,'--enable-exceptions','--enable-annotations','-r',wat,'-o',obj],d,f'assemble{i}')
    if u['assemble']['exitCode']==0:u['object']=ident(obj);u['inspect']=run([dump,'-x','-d','-r',obj],d,f'inspect{i}')
  c['passed']=all(u['compile']['exitCode']==0 and u.get('assemble',{}).get('exitCode')==0 for u in c['units'])
  # Actual regression for late RTL nothrow inference: an escaping cleanup
  # resume must keep the calling main's real catch even at O0.
  if c['passed'] and f['expected']['exitCode']==0:
   entry=(d/'unit0.wat').read_text().split('(func $main',1)[-1]
   c['callerCatchRetained']='try_table' in entry and '_Unwind_CallPersonality' in entry
   c['passed']=c['callerCatchRetained']
  save()
 for language in ('c','c++'):
  for o in ('0','2'):
   name=f'unwind-abi-{language}-o{o}';d=out/name.replace('+','p');d.mkdir();src=d/'abi.c';wat=d/'abi.wat';obj=d/'abi.o';program=d/'abi.wasm'
   src.write_text('''#include "unwind-generic.h"
#ifdef __cplusplus
extern "C" {
#endif
int abi_probe(void) {
  if(sizeof(_Unwind_Word)!=4 || sizeof(_Unwind_Ptr)!=4) return 1;
  if(sizeof(struct _Unwind_Exception)!=32 || __alignof__(struct _Unwind_Exception)!=16) return 2;
  if(__builtin_offsetof(struct _Unwind_Exception,private_1)!=12 || __builtin_offsetof(struct _Unwind_Exception,private_2)!=16) return 3;
  if(__builtin_eh_return_data_regno(0)!=0 || __builtin_eh_return_data_regno(1)!=1) return 4;
  return 0;
}
void use_unwind_gr(struct _Unwind_Context *c, _Unwind_Word v) { _Unwind_SetGR(c,0,v); }
#ifdef __cplusplus
}
#endif
''')
   c={'id':name,'kind':'unwind-abi','source':ident(src)};report['cases'].append(c)
   c['compile']=run([*base,'-S','-x',language,'-O'+o,'-I'+str(work/'gcc/libgcc'),'-mexception-handling',src,'-o',wat],d,'compile')
   if c['compile']['exitCode']==0:
    c['wat']=ident(wat);c['assemble']=run([assembler,'--enable-exceptions','--enable-annotations','-r',wat,'-o',obj],d,'assemble')
    if c['assemble']['exitCode']==0:
     c['object']=ident(obj);c['link']=run([ld,'--no-entry','--export=abi_probe',obj,'-o',program],d,'link')
     if c['link']['exitCode']==0:
      c['program']=ident(program);c['execute']=run([a.node,'-e',"const fs=require('fs');const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));const i=new WebAssembly.Instance(m,{});const v=i.exports.abi_probe();console.log(v);process.exit(v);",program],d,'execute')
   c['passed']=c.get('execute',{}).get('exitCode')==0;save()
 report['nativeCaseIds']=[f['id'] for f in fixtures]
 report['counts']={'nativeFixturePrograms':14,'translationUnits':sum(len(c.get('units',[])) for c in report['cases']),'abiExecutions':4}
 report['status']='passed' if all(c['passed'] for c in report['cases']) else 'failed'
finally:
 report['completedUnix']=time.time();report['inputsUnchanged']=frozen==[ident(p) for p in inputs];save()
print(json.dumps({'status':report['status'],'passed':sum(bool(c.get('passed')) for c in report['cases']),'cases':len(report['cases']),'output':str(out)}))
raise SystemExit(0 if report['status']=='passed' and report['inputsUnchanged'] else 1)
