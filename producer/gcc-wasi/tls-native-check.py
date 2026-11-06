#!/usr/bin/env python3
"""Real GCC driver checks for TLS opt-in, object ABI and single-instance semantics."""
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
    for name in ['work', 'sdk', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    work, sdk, output = (getattr(args, key).resolve() for key in ['work', 'sdk', 'output'])
    output.mkdir(parents=True, exist_ok=False)
    (output / 'tmp').mkdir(mode=0o700)
    here = Path(__file__).resolve().parent
    compiler = work / 'gcc-native/gcc'
    assembler = work / 'wabt-native/wat2wasm'
    (output / 'as').symlink_to(assembler)
    node = Path(shutil.which(args.node) or args.node).resolve()
    inputs = [Path(__file__), here/'tls-native-probe.c', here/'tls-inspect.mjs',
              here/'symbol-alias-inspect.mjs', here/'sources.lock.json', here/'build-native.sh',
              work/'native-driver.specs', work/'native-build.json', work/'gcc-source.json',
              work/'wabt-native/provenance.json', compiler/'xgcc', compiler/'cc1', compiler/'cc1plus',
              assembler, sdk/'bin/wasm-ld', node, Path(sys.executable).resolve()]
    frozen = {str(p.resolve()): identity(p) for p in inputs}
    report = {'kind': 'gcc-wasi-tls-native-driver', 'status': 'running', 'schemaVersion': 1,
              'scope': 'native compiler, real TLS objects and single-instance linking/execution; shared isolation is separate',
              'startedUnix': time.time(), 'inputs': frozen, 'cases': []}
    env = {**os.environ, 'LC_ALL': 'C', 'TMPDIR': str(output/'tmp')}
    runner = output/'inspect-execute.mjs'
    runner.write_text('''import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {inspectTlsObject} from ''' + json.dumps((here/'tls-inspect.mjs').as_uri()) + ''';
const [object, program, expected, destination] = process.argv.slice(2);
const inspection = inspectTlsObject(await fs.readFile(object));
assert.equal(inspection.hasTls, expected === 'true');
if (expected === 'true') {
  for (const name of ['initialized','zeroed','aligned'])
    assert(inspection.tlsSymbols.some(symbol => symbol.name === name && !symbol.undefined), name);
  assert(inspection.tlsRelocations.length >= 3);
}
const module = await WebAssembly.compile(await fs.readFile(program));
assert.deepEqual(WebAssembly.Module.imports(module), []);
const instance = await WebAssembly.instantiate(module, {});
const result = instance.exports.probe();
assert.equal(result, 0);
await fs.writeFile(destination, JSON.stringify({inspection, result, imports:[]}, null, 2)+'\\n');
''')

    def run(command, directory, label):
        command = [str(value) for value in command]
        process = subprocess.run(command, cwd=directory, env=env, capture_output=True, timeout=90)
        for kind, data in [('stdout', process.stdout), ('stderr', process.stderr)]:
            (directory/(label+'.'+kind)).write_bytes(data)
        return {'argv': command, 'exitCode': process.returncode,
                'stdout': str(directory/(label+'.stdout')), 'stderr': str(directory/(label+'.stderr'))}

    def record(entry):
        directory = Path(entry['directory'])
        entry['artifacts'] = {str(p): identity(p) for p in sorted(directory.iterdir()) if p.is_file()}
        (output/'qualification.json').write_text(json.dumps(report, indent=2)+'\n')

    simple = '''#ifdef __wasm_tls__
#error TLS must remain disabled
#endif
#ifdef __cplusplus
extern "C"
#endif
int probe(void) { return 0; }
'''
    positive = (here/'tls-native-probe.c').read_text()
    profiles = [('default', [], False), ('enabled', ['-mtls', '-ftls-model=local-exec', '-g', '-g0'], True),
                ('last-enabled', ['-mno-tls', '-mtls', '-matomics'], True),
                ('last-disabled', ['-mtls', '-mno-tls', '-ftls-model=global-dynamic'], False),
                ('model-attribute', ['-mtls'], True)]
    negatives = [('pic', ['-mtls', '-fPIC'], positive, 'static non-PIC'),
                 ('pie', ['-mtls', '-fPIE'], positive, 'static non-PIC'),
                 ('debug', ['-mtls', '-gdwarf-4', '-g'], positive, 'does not support debug information'),
                 ('model', ['-mtls', '-ftls-model=global-dynamic'], positive, 'local-exec')]
    inline_header = 'inline thread_local int value=7;\n'
    inline_dynamic_header = 'struct Box { int value; Box():value(7){} ~Box(){} };\ninline thread_local Box value;\n'
    try:
        for language in ['c', 'c++']:
            for optimization in ['0', '2']:
                base = [compiler/'xgcc', '-B'+str(output)+'/', '-B'+str(compiler)+'/',
                        '-specs='+str(work/'native-driver.specs'), '-nostdinc', '-ffreestanding',
                        '-std=c++17' if language == 'c++' else '-std=c11', '-O'+optimization,
                        '-x', language]
                if language == 'c++':
                    base += ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit']
                for profile, flags, enabled in profiles:
                    name = f'{profile}-{language.replace("+", "p")}-o{optimization}'
                    directory = output/name
                    directory.mkdir()
                    source = directory/('main.cpp' if language == 'c++' else 'main.c')
                    # Both GCC frontends legally strengthen a tls_model
                    # attribute to the static profile's local-exec default.
                    # Verify its real lowering and execution rather than
                    # requiring a diagnostic for that valid relaxation.
                    code = positive if enabled else simple
                    if profile == 'model-attribute':
                        code = code.replace('TLS int initialized = 7;',
                            'TLS int initialized __attribute__((tls_model("initial-exec"))) = 7;')
                    source.write_text(code)
                    obj, program = directory/'main.o', directory/'program.wasm'
                    entry = {'id': name, 'directory': str(directory), 'enabled': enabled,
                             'kind': 'execution', 'commands': []}
                    report['cases'].append(entry)
                    command = [*base, *flags, '-save-temps=obj', '-c', source, '-o', obj]
                    entry['commands'].append(run(command, directory, 'compile'))
                    assert entry['commands'][-1]['exitCode'] == 0, name+': compilation failed'
                    wat = (directory/'main.s').read_text()
                    assert ('@reloc data tls ' in wat) == enabled, name+': TLS lowering mismatch'
                    assert '__emutls_' not in wat, name+': emulated TLS provider'
                    entry['commands'].append(run([sdk/'bin/wasm-ld', '--no-entry', '--export=probe',
                                                   obj, '-o', program], directory, 'link'))
                    assert entry['commands'][-1]['exitCode'] == 0, name+': static linking failed'
                    entry['commands'].append(run([node, runner, obj, program, str(enabled).lower(),
                                                   directory/'execution.json'], directory, 'execute'))
                    assert entry['commands'][-1]['exitCode'] == 0, name+': TLS execution/object validation failed'
                    entry['status'] = 'passed'
                    record(entry)
                for profile, flags, code, diagnostic in negatives:
                    name = f'reject-{profile}-{language.replace("+", "p")}-o{optimization}'
                    directory = output/name
                    directory.mkdir()
                    source = directory/('main.cpp' if language == 'c++' else 'main.c')
                    source.write_text(code)
                    command = run([*base, *flags, '-S', source, '-o', directory/'rejected.wat'], directory, 'compile')
                    entry = {'id': name, 'directory': str(directory), 'kind': 'diagnostic', 'commands': [command]}
                    report['cases'].append(entry)
                    message = Path(command['stderr']).read_text()
                    assert command['exitCode'] != 0 and diagnostic in message and 'internal compiler error' not in message, name+': diagnostic mismatch'
                    entry['status'] = 'passed'
                    record(entry)
                if language == 'c++':
                    for dynamic in [False, True]:
                        name = f'inline-{ "dynamic" if dynamic else "constant" }-cpp-o{optimization}'
                        directory = output/name
                        directory.mkdir()
                        header = inline_dynamic_header if dynamic else inline_header
                        value = 'value.value' if dynamic else 'value'
                        sources = [header+'extern "C" unsigned other() { return (unsigned)&value; }\n',
                                   header+'extern "C" unsigned other();\nextern "C" int probe() { '+
                                   'if(other()!=(unsigned)&value) return 1; '+value+'=19; return '+value+'!=19; }\n']
                        entry = {'id':name, 'directory':str(directory), 'kind':'inline-object-abi' if dynamic else 'inline-execution', 'commands':[]}
                        report['cases'].append(entry)
                        objects=[]
                        for index, code in enumerate(sources):
                            source=directory/f'unit{index}.cpp'
                            source.write_text(code)
                            obj=directory/f'unit{index}.o'
                            entry['commands'].append(run([*base,'-mtls','-save-temps=obj','-c',source,'-o',obj],directory,f'compile{index}'))
                            assert entry['commands'][-1]['exitCode']==0, name+': compilation failed'
                            assert '__emutls_' not in (directory/f'unit{index}.s').read_text(), name+': emulated inline TLS'
                            objects.append(obj)
                        linked=directory/('combined.o' if dynamic else 'program.wasm')
                        entry['commands'].append(run([sdk/'bin/wasm-ld',*(['-r'] if dynamic else ['--no-entry','--export=probe']),*objects,'-o',linked],directory,'link'))
                        assert entry['commands'][-1]['exitCode']==0, name+': duplicate/invalid inline TLS'
                        # Dynamic destructor execution belongs to the GNU runtime
                        # suite; this gate proves its native symbols coalesce.
                        script=directory/'inspect.mjs'
                        inspection_code='import assert from "node:assert/strict"; import fs from "node:fs/promises";\n'
                        inspection_code+='import {inspectTlsObject} from '+json.dumps((here/'tls-inspect.mjs').as_uri())+';\n'
                        inspection_code+='import {inspectAliasObject} from '+json.dumps((here/'symbol-alias-inspect.mjs').as_uri())+';\n'
                        inspection_code+='const inputObjects=await Promise.all('+json.dumps([str(obj) for obj in objects])+'.map(async file=>inspectTlsObject(await fs.readFile(file))));\n'
                        if dynamic:
                            # Pinned LLD -r merges TLS segments into .tdata and
                            # clears segment flags, including for Clang input.
                            # Keep strict flags on every original WABT object;
                            # inspect the linked symbol/relocation ABI directly.
                            inspection_code+='const object=inspectAliasObject(await fs.readFile('+json.dumps(str(linked))+'));\n'
                            inspection_code+='''const tlsSymbols=object.symbols.filter(s=>s.flags&0x100);
for (const symbol of tlsSymbols) assert.equal(symbol.kind,"data");
for (const relocation of object.relocations.filter(r=>r.type===21)) {
  const symbol=object.symbols[relocation.index];
  assert(symbol?.kind==="data" && (symbol.flags&0x100));
}
assert(object.relocations.some(r=>r.type===21));
const key=s=>JSON.stringify({name:s.name,binding:s.flags&3,size:s.size});
const expectedTls=[],coalesced=new Set();
for (const input of inputObjects) for (const symbol of input.tlsSymbols.filter(s=>!s.undefined)) {
  const value=key(symbol);
  if ((symbol.flags&3)===2) expectedTls.push(value);
  else coalesced.add(value);
}
assert.deepEqual(tlsSymbols.filter(s=>!s.undefined).map(key).sort(),[...expectedTls,...coalesced].sort());
assert(tlsSymbols.some(s=>s.name==="value" && !s.undefined && (s.flags&3)===1));
assert(object.symbols.some(s=>s.name==="__cxa_thread_atexit" && s.undefined));
const aliases=object.symbols.filter(s=>s.name==="_ZTH5value");
assert.equal(aliases.length,1);
assert(aliases[0].kind==="function" && !aliases[0].undefined && (aliases[0].flags&3)===1);
'''
                        else:
                            inspection_code+='const object=inputObjects[0];\n'
                            inspection_code+='assert(object.tlsSymbols.some(s=>s.name==="value" && !s.undefined && (s.flags&3)===1));\n'
                            inspection_code+='const module=await WebAssembly.compile(await fs.readFile('+json.dumps(str(linked))+')); assert.deepEqual(WebAssembly.Module.imports(module),[]); const instance=await WebAssembly.instantiate(module,{}); assert.equal(instance.exports.probe(),0);\n'
                        inspection_code+='await fs.writeFile('+json.dumps(str(directory/'execution.json'))+',JSON.stringify({inputObjects,object,status:"passed"},null,2)+"\\n");\n'
                        script.write_text(inspection_code)
                        entry['commands'].append(run([node,script],directory,'inspect-execute'))
                        assert entry['commands'][-1]['exitCode']==0, name+': inline object/execution mismatch'
                        entry['status']='passed'
                        record(entry)
        report['inputsUnchanged'] = frozen == {name: identity(Path(name)) for name in frozen}
        assert report['inputsUnchanged'], 'frozen inputs changed'
        report['status'] = 'passed'
        report['counts'] = {'executions':22, 'diagnostics':16, 'inlineDynamicObjectCases':2}
    except BaseException as error:
        report['status'] = 'failed'
        report['failure'] = repr(error)
        raise
    finally:
        report['finishedUnix'] = time.time()
        (output/'qualification.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'status':report['status'],'counts':report['counts'],'report':str(output/'qualification.json')}))


if __name__ == '__main__':
    main()
