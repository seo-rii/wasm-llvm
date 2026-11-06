#!/usr/bin/env python3
"""Run production SDK plans for the Wasm C++ member-function-pointer ABI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import traceback

HERE = Path(__file__).resolve().parent

def identity(file):
    file = Path(file)
    with file.open('rb') as stream:
        return {'path': str(file), 'bytes': file.stat().st_size,
                'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}

def content(record):
    return {key: record[key] for key in ['bytes', 'sha256']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['work', 'sdk', 'plans', 'sysroot', 'output', 'node']:
        parser.add_argument('--'+name, required=True, type=Path)
    args = parser.parse_args()
    for name in vars(args): setattr(args, name, getattr(args, name).resolve())
    args.output.mkdir(mode=0o700)
    report = {'kind': 'gcc-wasi-member-function-pointer-native-qualification', 'schemaVersion': 1,
              'status': 'running', 'cases': [], 'startedUnix': time.time(),
              'scope': 'actual-GCC-user-code-PMF-ABI; not timezone runtime qualification'}
    inputs = set()
    frozen = []
    environment = dict(os.environ, LC_ALL='C')
    for name in ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH',
                 'GCC_EXEC_PREFIX', 'COMPILER_PATH', 'LIBRARY_PATH']:
        environment.pop(name, None)
    try:
        fixture = HERE / 'tzdb-pmf-fixtures.mjs'
        cases = json.loads(subprocess.check_output([str(args.node), '--input-type=module', '-e',
            f'import {{timezonePmfCases}} from {json.dumps(fixture.as_uri())}; console.log(JSON.stringify(timezonePmfCases));']))
        plans = json.loads(args.plans.read_text())
        assert len(cases) == len(plans['cases']) == 8
        assert content(identity(fixture)) == content(plans['fixtures'])
        native_file = args.work / 'native-build.json'
        native = json.loads(native_file.read_text())
        assert len(native['gccSource']['patches']) == 29
        tools = {'cc1plus': args.work / 'gcc-native/gcc/cc1plus',
                 'as': args.work / 'wabt-native/wat2wasm', 'ld': args.sdk / 'bin/wasm-ld',
                 'objdump': args.work / 'wabt-native/wasm-objdump'}
        assert identity(tools['cc1plus'])['sha256'] == native['tools']['cc1plus']['sha256']
        report.update(nativeBuild=identity(native_file), gccSource=native['gccSource'],
                      compilerHost='native', target='wasm32-wasi',
                      parameters={name: str(getattr(args,name)) for name in ['work','sdk','plans','sysroot','node']},
                      fixture=identity(fixture), plans=identity(args.plans),
                      tools={name: identity(file) for name, file in tools.items()})
        inputs.update([Path(__file__), fixture, args.plans, args.node, native_file,
                       HERE/'run-eh-program.mjs', HERE/'sources.lock.json', *tools.values()])
        inputs.update(file for file in args.sysroot.rglob('*') if file.is_file())
        inputs.update(Path(record['path']) for record in plans['sdk']['files'])
        for record in plans['sdk']['files']:
            assert content(identity(record['path'])) == content(record)
        frozen = [identity(file) for file in sorted(inputs)]
        for case, planned in zip(cases, plans['cases']):
            assert planned['id'] == case['id'] and planned['request'] == case['request']
            assert planned['run'] == case['run']
            assert planned['expected'] == {key: case[key] for key in ['stdout', 'stderr', 'exitCode']}
            directory = args.output / case['id']; directory.mkdir()
            workspace = directory / 'workspace'; workspace.mkdir()
            def translate(value):
                for virtual, physical in [('/workspace', str(workspace)), ('/sysroot', str(args.sysroot))]:
                    if value == virtual or value.startswith(virtual+'/'):
                        return physical+value[len(virtual):]
                    if value.startswith('-L'+virtual+'/'):
                        return '-L'+physical+value[len(virtual)+2:]
                return value
            item = {'id': case['id'], 'request': case['request'], 'run': case['run'],
                    'expected': planned['expected'], 'plan': planned['plan'], 'commands': []}
            report['cases'].append(item)
            assert len(planned['plan']['files']) == 1
            source = planned['plan']['files'][0]
            assert source['path'] == '/workspace/main.cpp' and source['contents'] == case['request']['code']
            Path(translate(source['path'])).write_text(source['contents'])
            assert [s['tool'] for s in planned['plan']['stages']] == ['cc1plus','as','ld']
            commands = [(tools[s['tool']], [translate(a) for a in s['argv']], 'stage-'+str(i))
                        for i, s in enumerate(planned['plan']['stages'])]
            program = Path(translate(planned['plan']['stages'][-1]['output']))
            commands += [(tools['objdump'], ['-x','-d',str(program)], 'inspect')]
            for tool, argv, label in commands:
                with (directory/(label+'.stdout')).open('xb') as out, (directory/(label+'.stderr')).open('xb') as err:
                    result = subprocess.run([str(tool), *argv], cwd=workspace, env=environment,
                                            stdout=out, stderr=err, timeout=180)
                item['commands'].append({'tool': str(tool), 'argv': argv, 'exitCode': result.returncode,
                    'stdout': identity(directory/(label+'.stdout')), 'stderr': identity(directory/(label+'.stderr'))})
                assert result.returncode == 0, (case['id'], label)
            (directory/'stdin.txt').write_text(case['run']['stdin'])
            result = subprocess.run([str(args.node),'--no-warnings',str(HERE/'run-eh-program.mjs'),
                                     str(program),str(directory)],cwd=directory,env=environment,
                                    capture_output=True,timeout=30)
            assert result.returncode == 0
            observed = json.loads((directory/'result.json').read_text())
            item.update(observed=observed,result=identity(directory/'result.json'),
                        program=identity(program),assembly=identity(workspace/'program.wat'),
                        object=identity(workspace/'program.o'),source=identity(workspace/'main.cpp'))
            assert observed['escapedException'] is None, (case['id'], observed)
            for name in ['stdout','stderr','exitCode']:
                assert observed[name] == case[name], (case['id'], name, observed[name], case[name])
            assert all(entry['module']=='wasi_snapshot_preview1' for entry in observed['imports'])
            item['status']='passed'
        report['status']='passed';report['counts']={'total':8,'families':4,'optimizations':['0','2']}
    except BaseException as error:
        report['status']='failed';report['error']=repr(error);traceback.print_exc();raise
    finally:
        report['inputs']=frozen;report['inputsUnchanged']=frozen==[identity(item['path']) for item in frozen]
        if not report['inputsUnchanged']: report['status']='failed'
        report['completedUnix']=time.time()
        (args.output/'qualification.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'status':report['status'],'cases':len(report['cases']),
                          'inputsUnchanged':report['inputsUnchanged'],'report':str(args.output/'qualification.json')}))

if __name__ == '__main__': main()
