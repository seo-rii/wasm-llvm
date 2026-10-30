#!/usr/bin/env python3
"""Black-box strong-alias object, relocation, linker and WASI checks."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
import traceback

PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument('--work', required=True, type=Path)
PARSER.add_argument('--sdk', required=True, type=Path)
PARSER.add_argument('--sysroot', required=True, type=Path)
PARSER.add_argument('--output', required=True, type=Path)
PARSER.add_argument('--reference', type=Path,
                    help='Passed test-symbol-alias report whose provider objects are round-tripped and relinked')
PARSER.add_argument('--node', default=shutil.which('node'), type=Path)
ARGS = PARSER.parse_args()
RECIPE = Path(__file__).resolve().parent
WORK, SDK, SYSROOT, OUTPUT = [p.resolve() for p in
                            (ARGS.work, ARGS.sdk, ARGS.sysroot, ARGS.output)]
REFERENCE = ARGS.reference.resolve() if ARGS.reference else None
OUTPUT.mkdir(parents=True, exist_ok=False)
TOOLS = {name: WORK / 'wabt-native' / name
         for name in ('wat2wasm', 'wasm2wat', 'wasm-objdump', 'wasm-validate')}
TOOLS.update(clang=SDK / 'bin/clang', ld=SDK / 'bin/wasm-ld', node=ARGS.node.resolve())

def identity(path):
    path = Path(path)
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


REPORT = {'schemaVersion': 1, 'kind': 'gcc-wasi-symbol-alias-assembler', 'status': 'running', 'tools': {name: identity(path) for name, path in TOOLS.items()}, 'cases': [], 'commands': []}
REPORT['testScript'] = identity(__file__)


def run(command, args, expected=0, stdin=None):
    result = subprocess.run([str(command), *map(str, args)], input=stdin, text=True, capture_output=True, timeout=60)
    entry = {'command': str(command), 'argv': list(map(str, args)), 'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
    REPORT['commands'].append(entry)
    if expected is not None:
        assert result.returncode == expected, entry
    return entry


class Reader:
    def __init__(self, data):
        self.data = data
        self.offset = 0

    def byte(self):
        value = self.data[self.offset]
        self.offset += 1
        return value

    def leb(self, signed=False):
        value = shift = 0
        while True:
            byte = self.byte()
            value |= (byte & 127) << shift
            shift += 7
            if byte < 128:
                return value - (1 << shift) if signed and byte & 64 else value
            assert shift <= 70

    def take(self, count):
        result = self.data[self.offset:self.offset + count]
        assert len(result) == count
        self.offset += count
        return result

    def text(self):
        return self.take(self.leb()).decode()


def inspect(path):
    data = Path(path).read_bytes()
    reader = Reader(data)
    assert reader.take(8) == b'\0asm\x01\0\0\0'
    sections = []
    symbols = []
    relocations = []
    segments = []
    function_count = None
    data_count = None
    features = []
    while reader.offset < len(data):
        kind = reader.byte()
        body = Reader(reader.take(reader.leb()))
        name = body.text() if kind == 0 else None
        sections.append({'kind': kind, 'name': name})
        if kind == 3:
            function_count = body.leb()
        if kind == 11:
            data_count = body.leb()
        if name == 'target_features':
            for _ in range(body.leb()):
                features.append({'prefix': chr(body.byte()), 'name': body.text()})
        if name == 'linking':
            assert body.leb() == 2
            while body.offset < len(body.data):
                subkind = body.byte()
                sub = Reader(body.take(body.leb()))
                if subkind == 5:
                    for _ in range(sub.leb()):
                        segments.append({'name': sub.text(), 'alignmentLog2': sub.leb(), 'flags': sub.leb()})
                if subkind == 8:
                    for index in range(sub.leb()):
                        symbol_kind, flags = sub.byte(), sub.leb()
                        value = {'symbolIndex': index, 'kind': symbol_kind, 'flags': flags}
                        if symbol_kind == 1:
                            value['name'] = sub.text()
                            if not flags & 16:
                                value.update(segment=sub.leb(), offset=sub.leb(), size=sub.leb())
                        elif symbol_kind == 3:
                            value.update(index=sub.leb(), name='')
                        else:
                            value['index'] = sub.leb()
                            value['name'] = sub.text() if not flags & 16 or flags & 64 else ''
                        symbols.append(value)
        if name and name.startswith('reloc.'):
            target = body.leb()
            for _ in range(body.leb()):
                reloc_kind, offset, symbol = body.leb(), body.leb(), body.leb()
                addend = body.leb(True) if reloc_kind in {3, 4, 5, 8, 9, 11, 14, 15, 16, 17, 21, 22, 23, 25} else 0
                relocations.append({'section': name, 'targetSection': target, 'type': reloc_kind, 'offset': offset, 'symbolIndex': symbol, 'addend': addend})
    for reloc in relocations:
        reloc['symbol'] = '<type>' if reloc['type'] == 6 else symbols[reloc['symbolIndex']]['name']
    return {'file': identity(path), 'functionCount': function_count or 0, 'dataCount': data_count or 0, 'symbols': symbols, 'relocations': relocations, 'segments': segments, 'targetFeatures': features}


def semantics(inspection):
    # Explicit-name is serialization detail for defined symbols. Binding,
    # visibility, retention and export flags must remain independent and exact.
    symbols = [{**{k: v for k, v in symbol.items() if k != 'symbolIndex'}, 'flags': symbol['flags'] & ~64} for symbol in inspection['symbols']]
    relocations = [{**{k: v for k, v in reloc.items() if k not in ('symbolIndex', 'targetSection')}, 'section': reloc['section'].lower()} for reloc in inspection['relocations']]
    return {'functions': inspection['functionCount'], 'data': inspection['dataCount'], 'symbols': sorted(symbols, key=lambda s: (s['kind'], s['name'], s.get('index', 0))), 'relocations': sorted(relocations, key=lambda r: (r['section'], r['offset'])), 'segments': inspection['segments'], 'features': inspection['targetFeatures']}


def assemble(name, source):
    directory = OUTPUT / name
    directory.mkdir()
    wat = directory / 'input.wat'
    wat.write_text(source)
    obj = directory / 'input.o'
    run(TOOLS['wat2wasm'], ['-r', '--enable-annotations', wat, '-o', obj])
    run(TOOLS['wasm-validate'], [obj])
    return obj


def roundtrip(name, original):
    directory = OUTPUT / name
    directory.mkdir(exist_ok=True)
    wat, obj = directory / 'roundtrip.wat', directory / 'roundtrip.o'
    run(TOOLS['wasm2wat'], ['-r', '--enable-annotations', original, '-o', wat])
    run(TOOLS['wat2wasm'], ['-r', '--enable-annotations', wat, '-o', obj])
    run(TOOLS['wasm-validate'], [obj])
    before, after = inspect(original), inspect(obj)
    assert semantics(before) == semantics(after), {'before': semantics(before), 'after': semantics(after)}
    dump = run(TOOLS['wasm-objdump'], ['-x', '-r', obj])
    (directory / 'object.txt').write_text(dump['stdout'])
    REPORT['cases'].append({'id': name, 'status': 'passed', 'before': before, 'after': after, 'wat': identity(wat)})
    return obj


PROVIDER = r'''(module
  (@sym.alias $chain (func $alias) (@sym (name "chain")))
  (@sym.alias $alias (func $target) (@sym (name "alias") hidden))
  (@sym.alias $local_alias (func $target) (@sym (name "local_alias") local))
  (@sym.alias $chain_data (data $alias_data) (@sym (name "chain_data") hidden))
  (@sym.alias $alias_data (data $datum) (@sym (name "alias_data")))
  (@sym.alias $local_data (data $datum) (@sym (name "local_data") local))
  (import "env" "memory" (memory 0))
  (import "env" "__indirect_function_table" (table 0 funcref))
  (func $target (@sym (name "target") hidden) (param i32) (result i32)
    local.get 0 i32.const 5 i32.add)
  (func $caller (@sym (name "caller")) (param i32) (result i32)
    local.get 0 call $chain)
  (func $function_identity (@sym (name "function_identity")) (result i32)
    (i32.const 0 (@reloc functable $target))
    (i32.const 0 (@reloc functable $local_alias)) i32.eq)
  (func $data_identity (@sym (name "data_identity")) (result i32)
    (i32.const 0 (@reloc data $datum))
    (i32.const 0 (@reloc data $local_data)) i32.eq)
  (data (@sym (name ".data.datum") (align 4)) (i32.const 0)
    (@sym $datum (name "datum") hidden (size 4)) "\0b\00\00\00")
  (data (@sym (name ".data.pointers") (align 4)) (i32.const 0)
    (@sym $pointers (name "pointers") (size 8))
    "\00\00\00\00" (@reloc i32 functable $chain)
    "\00\00\00\00" (@reloc i32 data $alias_data))
)'''
CALLER = '''#include <stdio.h>
#include <stdint.h>
extern int target(int),alias(int),chain(int),caller(int),function_identity(void),data_identity(void);
extern int datum,alias_data,chain_data;
extern uintptr_t pointers[2];
int main(void){int n;if(scanf("%d",&n)!=1)return 2;
 int(*volatile f[3])(int)={target,alias,chain};int*volatile p[3]={&datum,&alias_data,&chain_data};
 alias_data+=n;
 printf("%d %d %d %d %d %d %d %d %d %d\\n",f[0]==f[1]&&f[1]==f[2],p[0]==p[1]&&p[1]==p[2],f[0](n),f[2](n),caller(n),datum,function_identity(),data_identity(),pointers[0]==(uintptr_t)f[1],pointers[1]==(uintptr_t)p[1]);return 0;}
'''


def link_run(name, caller, provider, expected):
    program = OUTPUT / (name + '.wasm')
    lib = SYSROOT / 'lib/wasm32-wasi'
    builtins = SDK / 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a'
    run(TOOLS['ld'], ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program, lib / 'crt1-command.o', '-L' + str(lib), caller, provider, '-lc', builtins])
    result = run(TOOLS['node'], ['--no-warnings', OUTPUT / 'run-wasi.mjs', program], stdin='3\n')
    assert result['stdout'] == expected and result['stderr'] == '', result
    REPORT['cases'].append({'id': name, 'status': 'passed', 'execution': result, 'program': identity(program)})


def source_receipt():
    result = subprocess.run([sys.executable, RECIPE / 'prepare-source.py',
                             '--component', 'wabt', '--source', WORK / 'wabt-source'],
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def main():
    provenance_path = WORK / 'wabt-native/provenance.json'
    provenance = json.loads(provenance_path.read_text())
    REPORT['assemblerProvenance'] = identity(provenance_path)
    REPORT['assemblerSource'] = source_receipt()
    assert provenance['inputsUnchanged'] and provenance['host'] == 'native'
    assert provenance['source'] == REPORT['assemblerSource']
    for name, tool in TOOLS.items():
        if name not in provenance['files']:
            continue
        assert {k: REPORT['tools'][name][k] for k in ('bytes', 'sha256')} == provenance['files'][name]
    for name in ('wat2wasm', 'wasm2wat', 'wasm-objdump', 'wasm-validate'):
        assert name in provenance['files'], 'rebuild native WABT with the current recipe'
    REPORT['recipes'] = [identity(RECIPE / name) for name in
                         ('build-wabt.sh', 'prepare-source.py', 'sources.lock.json')]
    for current in REPORT['recipes']:
        assert {k: current[k] for k in ('bytes', 'sha256')} == provenance['recipes'][Path(current['path']).name]
    runtime = [p for p in SYSROOT.rglob('*') if p.is_file()]
    runtime.append(SDK / 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a')
    REPORT['runtimeInputs'] = [identity(p) for p in runtime]
    (OUTPUT / 'run-wasi.mjs').write_text("import{WASI}from'node:wasi';import{readFile}from'node:fs/promises';const w=new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});process.exitCode=w.start(await WebAssembly.instantiate(await WebAssembly.compile(await readFile(process.argv[2])),{wasi_snapshot_preview1:w.wasiImport}));\n")
    original = assemble('annotated-chain', PROVIDER)
    copied = roundtrip('annotated-chain', original)
    info = inspect(original)
    by_name = {s['name']: s for s in info['symbols']}
    assert info['functionCount'] == 4 and info['dataCount'] == 2
    assert {by_name[name]['index'] for name in ['target', 'alias', 'chain', 'local_alias']} == {0}
    assert {(by_name[name]['segment'], by_name[name]['offset'], by_name[name]['size']) for name in ['datum', 'alias_data', 'chain_data', 'local_data']} == {(0, 0, 4)}
    assert by_name['local_alias']['flags'] & 3 == by_name['local_data']['flags'] & 3 == 2
    assert by_name['alias']['flags'] & 12 == by_name['chain_data']['flags'] & 12 == 4
    assert by_name['chain']['flags'] & 12 == by_name['alias_data']['flags'] & 12 == 0
    assert {(r['type'], r['symbol']) for r in info['relocations']} >= {(0, 'chain'), (1, 'local_alias'), (4, 'local_data'), (2, 'chain'), (5, 'alias_data')}
    for optimization in ['0', '2']:
        c = OUTPUT / ('caller-o' + optimization + '.c')
        o = c.with_suffix('.o')
        c.write_text(CALLER)
        run(TOOLS['clang'], ['--target=wasm32-wasip1', '--sysroot=' + str(SYSROOT), '-isystem', SYSROOT / 'include/wasm32-wasi', '-std=gnu11', '-O' + optimization, '-c', c, '-o', o])
        for suffix, provider in [('original', original), ('roundtrip', copied)]:
            link_run('annotated-o' + optimization + '-' + suffix, o, provider, '1 1 8 8 8 14 1 1 1 1\n')
    if REFERENCE:
        reference = json.loads(REFERENCE.read_text())
        assert reference['status'] == 'passed' and reference['inputsUnchanged']
        selected = [case for case in reference['cases'] if len(case.get('units', [])) == 2]
        assert selected, 'reference report has no two-unit alias cases'
        REPORT['reference'] = identity(REFERENCE)
        REPORT['referenceCases'] = len(selected)
        for case in selected:
            assert case['status'] == 'passed'
            for unit in case['units']:
                for kind in ['source', 'object']:
                    assert identity(unit[kind]['path']) == unit[kind]
                    REPORT['runtimeInputs'].append(unit[kind])
            name = 'matrix-' + case['id']
            provider = roundtrip(name, case['units'][1]['object']['path'])
            linker = next(command for command in case['commands']
                          if Path(command['command']).name == 'wasm-ld')
            program = OUTPUT / (name + '.wasm')
            replacements = {case['program']['path']: str(program),
                            case['units'][1]['object']['path']: str(provider)}
            run(TOOLS['ld'], [replacements.get(arg, arg) for arg in linker['argv']])
            result = run(TOOLS['node'], ['--no-warnings', OUTPUT / 'run-wasi.mjs', program],
                         stdin=case['stdin'])
            assert result['stdout'] == case['expectedStdout'] and result['stderr'] == '', result
            REPORT['cases'].append({'id': name + '-wasi', 'status': 'passed',
                                    'execution': result, 'program': identity(program),
                                    'fixtureSha256': case['fixtureSha256']})

    positives = {
        'constant-pool-offset': r'''(module (@sym.alias $last (data $tail (offset 4)) (@sym (name "last") local)) (@sym.alias $tail (data $whole (offset 4)) (@sym (name "tail") local)) (memory 1) (data (@sym (align 16)) (i32.const 0) (@sym $whole (name "whole") local (size 16)) "0123456789abcdef"))''',
        'simd-function-alias': '''(module (@sym.alias $alias (func $target) (@sym (name "simd_alias"))) (func $target (@sym (name "simd_target") local) (param v128) (result v128) local.get 0) (func (@sym (name "simd_caller")) (param v128) (result v128) local.get 0 call $alias))''',
        'element-function-alias': '''(module (@sym.alias $alias (func $target) (@sym (name "element_alias"))) (table 2 funcref) (func $target (@sym (name "element_target") local) (result i32) i32.const 9) (elem (i32.const 0) $target $alias))''',
        'export-function-alias': '''(module (@sym.alias $alias (func $target) (@sym (name "export_alias"))) (func $target (@sym (name "export_target") local) (result i32) i32.const 9) (export "run" (func $alias)))''',
        'zero-size-data-alias': '''(module (@sym.alias $alias (data $empty) (@sym (name "empty_alias"))) (memory 1) (data (i32.const 0) (@sym $empty (name "empty") local (size 0)) ""))''',
    }
    for name, source in positives.items():
        obj = assemble(name, source)
        roundtrip(name, obj)
        inspection = inspect(obj)
        if name == 'constant-pool-offset':
            symbols = {s['name']: s for s in inspection['symbols']}
            assert (symbols['tail']['offset'], symbols['tail']['size'], symbols['last']['offset'], symbols['last']['size']) == (4, 12, 8, 8)
        if name == 'simd-function-alias':
            assert {'prefix': '+', 'name': 'simd128'} in inspection['targetFeatures']
            assert run(TOOLS['wasm-validate'], ['--disable-simd', obj], expected=None)['exitCode'] != 0

    target = '(func $f (@sym (name "f"))) (memory 1) (data (i32.const 0) (@sym $d (name "d") (size 4)) "1234")'
    negatives = {
        'undefined-function': '(@sym.alias $a (func $missing) (@sym (name "a")))',
        'undefined-data': '(@sym.alias $a (data $missing) (@sym (name "a")))',
        'self-cycle': '(@sym.alias $a (func $a) (@sym (name "a")))',
        'forward-cycle': '(@sym.alias $a (func $b) (@sym (name "a"))) (@sym.alias $b (func $a) (@sym (name "b")))',
        'wrong-kind-function': '(@sym.alias $a (func $d) (@sym (name "a")))',
        'wrong-kind-data': '(@sym.alias $a (data $f) (@sym (name "a")))',
        'wrong-kind-chain': '(@sym.alias $a (func $b) (@sym (name "a"))) (@sym.alias $b (data $d) (@sym (name "b")))',
        'duplicate-alias-id': '(@sym.alias $a (func $f) (@sym (name "a"))) (@sym.alias $a (func $f) (@sym (name "b")))',
        'duplicate-alias-symbol': '(@sym.alias $a (func $f) (@sym (name "a"))) (@sym.alias $b (func $f) (@sym (name "a")))',
        'duplicate-primary-id': '(@sym.alias $f (func $f) (@sym (name "a")))',
        'duplicate-primary-symbol': '(@sym.alias $a (func $f) (@sym (name "f")))',
        'missing-linking-name': '(@sym.alias $a (func $f))',
        'weak-alias-out-of-scope': '(@sym.alias $a (func $f) (@sym (name "a") weak))',
        'function-offset': '(@sym.alias $a (func $f (offset 0)) (@sym (name "a")))',
        'data-offset-out-of-range': '(@sym.alias $a (data $d (offset 5)) (@sym (name "a")))',
        'numeric-target-out-of-range': '(@sym.alias $a (func 99) (@sym (name "a")))',
    }
    for name, alias in negatives.items():
        directory = OUTPUT / name
        directory.mkdir()
        source = directory / 'input.wat'
        source.write_text('(module ' + alias + ' ' + target + ')')
        result = run(TOOLS['wat2wasm'], ['-r', '--enable-annotations', source, '-o', directory / 'invalid.o'], expected=None)
        assert result['exitCode'] == 1 and 'error' in result['stderr'], result
        REPORT['cases'].append({'id': name, 'status': 'passed', 'expectedRejection': result, 'source': identity(source)})

    imports = {
        'imported-function-target': '(import "env" "f" (func $f)) (@sym.alias $a (func $f) (@sym (name "a")))',
        'imported-data-target': '(@sym.import.data $d (name "d")) (@sym.alias $a (data $d) (@sym (name "a")))',
    }
    for name, body in imports.items():
        source = OUTPUT / (name + '.wat')
        source.write_text('(module ' + body + ')')
        result = run(TOOLS['wat2wasm'], ['-r', '--enable-annotations', source, '-o', source.with_suffix('.o')], expected=None)
        assert result['exitCode'] == 1 and 'defined symbol' in result['stderr'], result
        REPORT['cases'].append({'id': name, 'status': 'passed', 'expectedRejection': result, 'source': identity(source)})

    # One actual data segment, with one valid segment-info entry. Adding a
    # second entry must fail at the binary reader boundary, before round trips
    # can use nonexistent segment storage. The same control without that
    # invalid entry remains valid.
    module = b'\0asm\x01\0\0\0\x05\x03\x01\0\x01\x0b\x07\x01\0\x41\0\x0b\x01x'
    for count in (1, 2):
        entries = bytes([count]) + b'\0\0\0' * count
        linking = b'\x07linking\x02\x05' + bytes([len(entries)]) + entries
        source = OUTPUT / f'segment-info-{count}.wasm'
        source.write_bytes(module + b'\0' + bytes([len(linking)]) + linking)
        result = run(TOOLS['wasm-validate'], [source], expected=None)
        if count == 1:
            assert result['exitCode'] == 0, result
        else:
            assert result['exitCode'] == 1 and 'invalid linking data segment index: 1' in result['stderr'], result
            roundtrip_rejection = run(TOOLS['wasm2wat'], ['-r', '--enable-annotations', source], expected=None)
            assert roundtrip_rejection['exitCode'] == 1 and 'invalid linking data segment index: 1' in roundtrip_rejection['stderr'], roundtrip_rejection
            REPORT['cases'].append({'id': 'segment-info-bounds', 'status': 'passed',
                                    'expectedRejection': result,
                                    'roundtripRejection': roundtrip_rejection,
                                    'source': identity(source)})
    lib = SYSROOT / 'lib/wasm32-wasi'
    builtins = SDK / 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a'
    for name, providers in [('duplicate-link', [original, original]), ('undefined-link', [])]:
        result = run(TOOLS['ld'], ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', OUTPUT / (name + '.wasm'), lib / 'crt1-command.o', '-L' + str(lib), OUTPUT / 'caller-o0.o', *providers, '-lc', builtins], expected=None)
        assert result['exitCode'] != 0 and ('duplicate symbol' if providers else 'undefined symbol') in result['stderr'], result
        REPORT['cases'].append({'id': name, 'status': 'passed', 'expectedRejection': result})

    assert source_receipt() == REPORT['assemblerSource']
    assert identity(provenance_path) == REPORT['assemblerProvenance']
    for name, tool in TOOLS.items():
        assert identity(tool) == REPORT['tools'][name]
    for expected in REPORT['runtimeInputs'] + REPORT['recipes'] + [REPORT['testScript']]:
        assert identity(expected['path']) == expected
    if REFERENCE:
        assert identity(REFERENCE) == REPORT['reference']
    REPORT['counts'] = {
        'checks': len(REPORT['cases']), 'commands': len(REPORT['commands']),
        'executions': sum('execution' in case for case in REPORT['cases']),
        'roundtrips': sum('before' in case for case in REPORT['cases']),
        'rejections': sum('expectedRejection' in case for case in REPORT['cases']),
    }
    REPORT['inputsUnchanged'] = True
    REPORT['status'] = 'passed'


try:
    main()
except Exception as error:
    REPORT['status'] = 'failed'
    REPORT['error'] = repr(error)
    traceback.print_exc()
finally:
    (OUTPUT / 'report.json').write_text(json.dumps(REPORT, indent=2) + '\n')
    print(json.dumps({'status': REPORT['status'], 'passedCases': len(REPORT['cases']), 'commands': len(REPORT['commands']), 'report': str(OUTPUT / 'report.json')}))
sys.exit(0 if REPORT['status'] == 'passed' else 1)
