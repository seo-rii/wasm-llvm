#!/usr/bin/env python3
"""Compile real TLS ABI fixtures with GCC and execute two shared Wasm instances."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def identity(path):
    data = path.read_bytes()
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['work','sdk','output']:
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--node', default='node')
    parser.add_argument('--reserved-bytes', type=int, default=131072)
    args = parser.parse_args()
    work, sdk, output = (getattr(args, name).resolve() for name in ['work','sdk','output'])
    assert args.reserved_bytes >= 8192 and args.reserved_bytes % 16 == 0
    output.mkdir(parents=True, exist_ok=False)
    (output/'tmp').mkdir(mode=0o700)
    here = Path(__file__).resolve().parent
    compiler = work/'gcc-native/gcc'
    assembler = work/'wabt-native/wat2wasm'
    (output/'as').symlink_to(assembler)
    node = Path(shutil.which(args.node) or args.node).resolve()
    inputs = [Path(__file__), here/'tls-native-fixtures.mjs', here/'run-tls-shared.mjs',
              here/'tls-inspect.mjs', here/'symbol-alias-inspect.mjs', here/'sources.lock.json',
              here/'build-native.sh', work/'native-driver.specs', work/'native-build.json',
              work/'gcc-source.json', work/'wabt-native/provenance.json', compiler/'xgcc',
              compiler/'cc1', compiler/'cc1plus', assembler, sdk/'bin/wasm-ld', node,
              Path(sys.executable).resolve()]
    frozen = {str(p.resolve()):identity(p) for p in inputs}
    fixture_module = json.dumps((here/'tls-native-fixtures.mjs').as_uri())
    fixture_script = 'import {nativeTlsSharedCases} from '+fixture_module+'; console.log(JSON.stringify(nativeTlsSharedCases));'
    fixtures = json.loads(subprocess.check_output([node,'--input-type=module','-e',fixture_script],text=True))
    report = {'kind':'gcc-wasi-tls-native-shared','schemaVersion':1,'status':'running',
              'scope':'GCC TLS lowering, object ABI and two Worker value/address isolation; destructor/runtime proof is separate',
              'inputs':frozen,'reservedBytes':args.reserved_bytes,'startedUnix':time.time(),'cases':[]}
    env = {**os.environ,'LC_ALL':'C','TMPDIR':str(output/'tmp')}
    runner = output/'execute.mjs'
    runner.write_text('''import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {nativeTlsSharedCases,assertNativeTlsSharedResult} from '''+fixture_module+''';
import {runTlsSharedProgram} from '''+json.dumps((here/'run-tls-shared.mjs').as_uri())+''';
import {inspectTlsObject} from '''+json.dumps((here/'tls-inspect.mjs').as_uri())+''';
const [id,program,output,reserved,...objects]=process.argv.slice(2);
const fixture=nativeTlsSharedCases.find(value=>value.id===id);
assert(fixture);
const inspections=[];
for (const file of objects) {
 const inspection=inspectTlsObject(await fs.readFile(file));
 assert(inspection.hasTls);
 inspections.push(inspection);
}
assert(inspections.some(value=>value.tlsSymbols.some(symbol=>symbol.name==='aligned_bytes'&&!symbol.undefined)));
assert(inspections.some(value=>value.tlsRelocations.length>0));
const result=await runTlsSharedProgram(await fs.readFile(program),{...fixture.request.sharedMemory,...fixture.run,reservedBytes:Number(reserved)});
const oracle=assertNativeTlsSharedResult(fixture,result);
await fs.writeFile(output+'/memory.bin',result.memory);
await fs.writeFile(output+'/execution.json',JSON.stringify({id,oracle,inspections,...result.report},null,2)+'\\n');
''')

    def run(command,directory,label):
        command=[str(x) for x in command]
        process=subprocess.run(command,cwd=directory,env=env,capture_output=True,timeout=90)
        for kind,data in [('stdout',process.stdout),('stderr',process.stderr)]:
            (directory/(label+'.'+kind)).write_bytes(data)
        return {'argv':command,'exitCode':process.returncode,
                'stdout':str(directory/(label+'.stdout')),'stderr':str(directory/(label+'.stderr'))}

    try:
        for fixture in fixtures:
            directory=output/fixture['id']; directory.mkdir()
            request=fixture['request']; language=request['language']
            assert request['sharedMemory']['reservedBytes']==args.reserved_bytes, 'TLS fixture reservation mismatch'
            main=directory/('program.cpp' if language=='cpp' else 'program.c')
            main.write_text(request['code'])
            for file in request['files']:
                (directory/file['path']).write_text(file['contents'])
            entry={'id':fixture['id'],'directory':str(directory),'commands':[]}
            report['cases'].append(entry)
            objects=[]
            for index,source in enumerate([main,*[directory/name for name in request['sources']]]):
                obj=directory/f'unit{index}.o'
                command=[compiler/'xgcc','-B'+str(output)+'/', '-B'+str(compiler)+'/',
                         '-specs='+str(work/'native-driver.specs'),'-nostdinc','-I'+str(directory),
                         '-ffreestanding','-fno-builtin','-std='+request['standard'],'-O'+request['optimization'],
                         '-mtls','-matomics','-save-temps=obj']
                if language=='cpp': command+=['-fno-exceptions','-fno-rtti','-fuse-cxa-atexit']
                entry['commands'].append(run([*command,'-c',source,'-o',obj],directory,f'compile{index}'))
                assert entry['commands'][-1]['exitCode']==0,fixture['id']+': compilation failed'
                assert '__emutls_' not in (directory/f'unit{index}.s').read_text(),fixture['id']+': emulated TLS'
                objects.append(obj)
            program=directory/'program.wasm'
            exports=['__stack_pointer','__stack_low','__stack_high','__heap_base','__data_end',
                     '__tls_size','__tls_align','__tls_base','__wasm_init_tls','__wasm_call_ctors','probe_entry']
            entry['commands'].append(run([sdk/'bin/wasm-ld','--fatal-warnings','--no-entry','--shared-memory',
                '--import-memory','--export-memory','--no-stack-first','--global-base=1024','-z','stack-size='+str(args.reserved_bytes),
                '--initial-memory=262144','--max-memory=262144','--extra-features=atomics,bulk-memory,mutable-globals',
                *['--export='+name for name in exports],*objects,'-o',program],directory,'link'))
            assert entry['commands'][-1]['exitCode']==0,fixture['id']+': shared linking failed'
            entry['commands'].append(run([node,runner,fixture['id'],program,directory,str(args.reserved_bytes),*objects],directory,'execute'))
            assert entry['commands'][-1]['exitCode']==0,fixture['id']+': shared TLS execution failed'
            entry['execution']=json.loads((directory/'execution.json').read_text())
            entry['status']='passed'
            entry['artifacts']={str(p):identity(p) for p in sorted(directory.iterdir()) if p.is_file()}
            (output/'qualification.json').write_text(json.dumps(report,indent=2)+'\n')
        report['inputsUnchanged']=frozen=={name:identity(Path(name)) for name in frozen}
        assert report['inputsUnchanged'],'frozen inputs changed'
        report['status']='passed'
        report['counts']={'sharedExecutions':len(fixtures),'translationUnits':len(fixtures)*2,'workersPerExecution':2}
    except BaseException as error:
        report['status']='failed'; report['failure']=repr(error)
        raise
    finally:
        report['finishedUnix']=time.time()
        (output/'qualification.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'counts':report['counts'],'report':str(output/'qualification.json')}))


if __name__=='__main__':
    main()
