#!/usr/bin/env python3
"""Bounded real-driver/backend checks; no shared-memory concurrency claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shlex
import shutil
import subprocess
import sys
import time


SOURCE = Path(__file__).with_name("atomics-native-probe.c").read_text()

DISABLED = '''
#ifdef __wasm_atomics__
#error unexpected atomics macro
#endif
#ifdef __GCC_HAVE_SYNC_COMPARE_AND_SWAP_4
#error unexpected native CAS
#endif
int probe(int a) { return a + 1; }
'''

MISALIGNED = {
    'constant': 'unsigned probe(void) { return __atomic_load_n((unsigned *)5, __ATOMIC_SEQ_CST); }\n',
    'symbol-offset': 'unsigned char bytes[16] __attribute__((aligned(8)));\nunsigned probe(void) { return __atomic_load_n((unsigned *)(bytes+1), __ATOMIC_SEQ_CST); }\n',
}

ALIGNMENT_CONTROLS = {
    'reassigned': '''unsigned bytes[8];
unsigned probe(void) {
  unsigned *pointer=(unsigned *)((unsigned char *)bytes+1);
  pointer=bytes;
  __atomic_store_n(pointer, 91u, __ATOMIC_SEQ_CST);
  return __atomic_load_n(pointer, __ATOMIC_SEQ_CST);
}
''',
    'runtime-offset': '''unsigned char bytes[32] __attribute__((aligned(8)));
unsigned probe(unsigned offset) {
  return __atomic_load_n((unsigned *)(bytes+(offset & 7)), __ATOMIC_SEQ_CST);
}
''',
    'conditional': '''unsigned char bytes[32] __attribute__((aligned(8)));
unsigned probe(unsigned condition) {
  unsigned *pointer=(unsigned *)(bytes+1);
  if (condition) pointer=(unsigned *)bytes;
  return __atomic_load_n(pointer, __ATOMIC_SEQ_CST);
}
''',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['work', 'sdk', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--node', default='node')
    parser.add_argument('--quick', action='store_true')
    args = parser.parse_args()
    work, sdk, output = (getattr(args, key).resolve() for key in ['work', 'sdk', 'output'])
    output.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[2]
    helper = root / 'producer/gcc-wasi/test-simd-relaxed-driver.py'
    common = runpy.run_path(str(helper))
    identity, target_features = common['identity'], common['target_features']
    compiler = work / 'gcc-native/gcc'
    assembler = work / 'wabt-native/wat2wasm'
    (output / 'as').symlink_to(assembler)
    (output / 'tmp').mkdir(mode=0o700)
    runner = output / 'execute.mjs'
    runner.write_text('''import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const module = await WebAssembly.compile(await fs.readFile(process.argv[2]));
assert.deepEqual(WebAssembly.Module.imports(module), []);
const instance = await WebAssembly.instantiate(module, {});
const result=instance.exports.probe();
assert.equal(result, 0);
console.log(JSON.stringify({result,imports:[],threadCount:1}));
''')
    inputs = [Path(__file__).resolve(), Path(__file__).with_name("atomics-native-probe.c"), helper,
              root / 'producer/gcc-wasi/sources.lock.json', root / 'producer/gcc-wasi/build-native.sh',
              work / 'gcc-source.json', work / 'wabt-native/provenance.json', work / 'native-build.json',
              work / 'native-driver.specs', assembler, compiler / 'xgcc',
              compiler / 'cc1', compiler / 'cc1plus', sdk / 'bin/wasm-ld',
              Path(shutil.which(args.node) or args.node).resolve(), Path(sys.executable).resolve()]
    frozen = {str(p): identity(p) for p in inputs}
    report = {'kind': 'gcc-wasi-atomics-backend-driver-probe', 'status': 'running',
              'scope': 'actual driver and single-instance backend semantics; concurrency qualified separately',
              'inputs': frozen, 'cases': [], 'startedUnix': time.time()}
    profiles = [('enabled', ['-matomics'], True)]
    if not args.quick:
        profiles += [('disable-then-enable', ['-mno-atomics', '-matomics'], True),
                     ('enable-then-disable', ['-matomics', '-mno-atomics'], False),
                     ('default', [], False)]
    env = {**os.environ, 'LC_ALL': 'C', 'TMPDIR': str(output / 'tmp')}

    def run(command, directory):
        result = subprocess.run(command, cwd=directory, capture_output=True, text=True,
                                timeout=90, env=env)
        return {'command': command, 'exitCode': result.returncode,
                'stdout': result.stdout, 'stderr': result.stderr}

    try:
        for language in ['c', 'c++']:
            for optimization in ['0', '2']:
                for profile, flags, enabled in profiles:
                    name = f'{profile}-{language.replace("+", "p")}-o{optimization}'
                    directory = output / name
                    directory.mkdir()
                    source = directory / ('main.cc' if language == 'c++' else 'main.c')
                    source.write_text(SOURCE if enabled else DISABLED)
                    obj = directory / 'main.o'
                    command = [str(compiler / 'xgcc'), '-B' + str(output) + '/',
                               '-B' + str(compiler) + '/',
                               '-specs=' + str(work / 'native-driver.specs'), '-nostdinc',
                               '-ffreestanding', '-save-temps=obj', '-v', '-O' + optimization,
                               '-x', language, *flags, '-c', str(source), '-o', str(obj)]
                    if language == 'c++':
                        command[1:1] = ['-fno-exceptions', '-fno-rtti']
                    entry = {'id': name, 'commands': [run(command, directory)]}
                    report['cases'].append(entry)
                    compiled = entry['commands'][0]
                    assert compiled['exitCode'] == 0, name + ': ' + compiled['stderr']
                    argv = [shlex.split(line.strip()) for line in compiled['stderr'].splitlines()
                            if line.strip().startswith(str(output / 'as') + ' ')]
                    assert len(argv) == 1 and argv[0].count('--enable-threads') == int(enabled), name
                    features = target_features(obj)
                    assert (features.get('atomics') == '+') == enabled, (name, features)
                    wat = (directory / 'main.s').read_text()
                    assert ('atomic.' in wat) == enabled, name
                    if enabled:
                        for width in ['', '8_u', '16_u']:
                            assert 'i32.atomic.load' + width in wat
                        assert 'i64.atomic.load' in wat and '(atomic.fence)' in wat
                        assert '(call $__atomic_' not in wat and '(import "env" "__atomic_' not in wat
                        program = directory / 'main.wasm'
                        linked = run([str(sdk / 'bin/wasm-ld'), '--no-entry', '--export=probe',
                                      '--export-memory', str(obj), '-o', str(program)], directory)
                        entry['commands'].append(linked)
                        assert linked['exitCode'] == 0, name + ': ' + linked['stderr']
                        execution = run([args.node, str(runner), str(program)], directory)
                        entry['commands'].append(execution)
                        assert execution['exitCode'] == 0, name + ': ' + execution['stderr']
                        entry['program'] = identity(program)
                    entry.update(status='passed', assemblerArgv=argv[0], targetFeatures=features,
                                 object=identity(obj), assembly=identity(directory / 'main.s'),
                                 source=identity(source))
                if not args.quick:
                    for name, text in MISALIGNED.items():
                        directory = output / f'misaligned-{name}-{language.replace("+", "p")}-o{optimization}'
                        directory.mkdir()
                        source = directory / 'main.c'
                        source.write_text(text)
                        obj = directory / 'main.o'
                        command = [str(compiler / 'xgcc'), '-B' + str(output) + '/',
                                   '-B' + str(compiler) + '/', '-specs=' + str(work / 'native-driver.specs'),
                                   '-nostdinc', '-ffreestanding', '-save-temps=obj', '-O' + optimization, '-x', language,
                                   '-matomics', '-c', str(source), '-o', str(obj)]
                        result = run(command, directory)
                        entry = {'id': directory.name, 'commands': [result]}
                        report['cases'].append(entry)
                        assert result['exitCode'] != 0 and not obj.exists(), entry['id']
                        assert 'requires natural 4-byte alignment' in result['stderr'], result['stderr']
                        entry.update(status='passed', source=identity(source))
                    for name, text in ALIGNMENT_CONTROLS.items():
                        directory = output / f'alignment-control-{name}-{language.replace("+", "p")}-o{optimization}'
                        directory.mkdir()
                        source = directory / 'main.c'
                        source.write_text(text)
                        obj = directory / 'main.o'
                        command = [str(compiler / 'xgcc'), '-B' + str(output) + '/',
                                   '-B' + str(compiler) + '/', '-specs=' + str(work / 'native-driver.specs'),
                                   '-nostdinc', '-ffreestanding', '-save-temps=obj', '-O' + optimization, '-x', language,
                                   '-matomics', '-c', str(source), '-o', str(obj)]
                        result = run(command, directory)
                        entry = {'id': directory.name, 'commands': [result]}
                        report['cases'].append(entry)
                        assert result['exitCode'] == 0 and obj.exists(), result['stderr']
                        entry.update(status='passed', source=identity(source), object=identity(obj),
                                     assembly=identity(directory / 'main.s'))
        for path, expected in frozen.items():
            assert identity(Path(path)) == expected, 'Changed input: ' + path
        policy_source = output / 'optimization-policy.c'
        policy_source.write_text('unsigned policy(unsigned value) { return value + 1; }\n')
        report['optimizationPolicySource'] = identity(policy_source)
        report['optimizationPolicyCases'] = []
        for name, flags, enabled in [
            ('baseline', [], True),
            ('final-disabled', ['-matomics', '-mno-atomics'], True),
            ('final-enabled', ['-mno-atomics', '-matomics'], False),
            ('explicit-before', ['-fipa-reference', '-matomics'], False),
            ('explicit-after', ['-matomics', '-fipa-reference'], False),
            ('baseline-explicit-disabled', ['-fno-ipa-reference'], False),
        ]:
            command = [str(compiler / 'xgcc'), '-B' + str(output) + '/',
                       '-B' + str(compiler) + '/', '-specs=' + str(work / 'native-driver.specs'),
                       '-O2', '-Q', '--help=optimizers', *flags, '-c', str(policy_source),
                       '-o', str(output / ('optimization-policy-' + name + '.o'))]
            query = run(command, output)
            assert query['exitCode'] == 0, query['stderr']
            match = re.search(r'^\s*-fipa-reference\s+\[(enabled|disabled)\]\s*$',
                              query['stdout'], re.MULTILINE)
            assert match and (match.group(1) == 'enabled') == enabled, (name, query['stdout'])
            report['optimizationPolicyCases'].append({'id': name, 'ipaReference': match.group(1),
                                                      'status': 'passed', 'command': query})
        assert {str(p): identity(p) for p in inputs} == frozen, 'Inputs changed during option policy checks'
        report.update(status='passed', inputsUnchanged=True,
                      counts={'cases': len(report['cases']),
                              'functionalExecutions': 4 if args.quick else 8,
                              'diagnostics': 0 if args.quick else 8,
                              'alignmentControls': 0 if args.quick else 12,
                              'optimizationPolicyCases': len(report['optimizationPolicyCases'])})
    except Exception as error:
        report.update(status='failed', error=str(error))
    finally:
        report['finishedUnix'] = time.time()
        (output / 'qualification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ['status', 'counts', 'error'] if k in report}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
