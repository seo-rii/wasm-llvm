#!/usr/bin/env python3
"""Compile native-width atomic consumers and execute two actual Wasm Workers."""
import argparse
import copy
import json
import os
from pathlib import Path
import runpy
import shlex
import shutil
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['work', 'sdk', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    work, sdk, output = (getattr(args, key).resolve() for key in ['work', 'sdk', 'output'])
    root = Path(__file__).resolve().parents[2]
    producer = root / 'producer/gcc-wasi'
    fixture_file = producer / 'atomics-native-fixtures.mjs'
    runner = producer / 'run-libatomic-shared.mjs'
    helper = producer / 'test-simd-relaxed-driver.py'
    common = runpy.run_path(str(helper))
    identity, target_features = common['identity'], common['target_features']
    output.mkdir(parents=True, exist_ok=False)
    (output / 'tmp').mkdir(mode=0o700)
    compiler = work / 'gcc-native/gcc'
    assembler = work / 'wabt-native/wat2wasm'
    (output / 'as').symlink_to(assembler)
    node = Path(shutil.which(args.node) or args.node).resolve()
    inputs = [Path(__file__).resolve(), helper, fixture_file, runner,
              producer / 'libatomic-shared-fixtures.mjs', producer / 'sources.lock.json',
              producer / 'build-native.sh', work / 'native-build.json',
              work / 'gcc-source.json', work / 'wabt-native/provenance.json',
              work / 'native-driver.specs', compiler / 'xgcc', compiler / 'cc1',
              compiler / 'cc1plus', assembler, sdk / 'bin/wasm-ld',
              sdk / 'share/wasi-sysroot/lib/wasm32-wasi/libc.a', node, Path(sys.executable).resolve()]
    frozen = {str(p): identity(p) for p in inputs}
    report = {'schemaVersion': 1, 'kind': 'gcc-wasi-native-atomics-shared-qualification',
              'status': 'running', 'scope': 'native GCC -> relocatable Wasm -> shared program -> two Node Workers',
              'inputs': frozen, 'cases': [], 'startedUnix': time.time()}
    env = {**os.environ, 'LC_ALL': 'C', 'TMPDIR': str(output / 'tmp')}

    def run(command, directory, timeout=90):
        started = time.time()
        result = subprocess.run(command, cwd=directory, capture_output=True, text=True,
                                timeout=timeout, env=env)
        return {'command': command, 'exitCode': result.returncode, 'stdout': result.stdout,
                'stderr': result.stderr, 'seconds': time.time() - started}

    try:
        loaded = run([str(node), '--input-type=module', '-e',
                      'import {nativeAtomicSharedCases as cases} from ' + json.dumps(fixture_file.as_uri())
                      + '; console.log(JSON.stringify(cases));'], output)
        assert loaded['exitCode'] == 0, loaded['stderr']
        cases = json.loads(loaded['stdout'])
        assert len(cases) == 16 and len({case['id'] for case in cases}) == 16
        # Keep the 16 SDK source fixtures exact. Supplement them with actual
        # two-Worker attempts to re-enable the unsound IPA-reference pass.
        for policy, language in [('explicit-before', 'cpp'), ('explicit-after', 'c'),
                                 ('pragma', 'c'), ('attribute', 'cpp')]:
            original = next(case for case in cases if case['width'] == 1
                            and case['request']['language'] == language
                            and case['request']['optimization'] == '2')
            control = copy.deepcopy(original)
            control['sourceFixture'] = original['id']
            control['id'] = original['id'] + '-policy-' + policy
            control['optimizationPolicy'] = policy
            code = control['request']['code']
            if policy == 'pragma':
                code = '#pragma GCC optimize ("ipa-reference")\n' + code
            attribute = '__attribute__((noinline' + (',optimize("ipa-reference")' if policy == 'attribute' else '') + ')) '
            code = code.replace('static void barrier(unsigned *phase)', attribute + 'static void barrier(unsigned *phase)')
            if policy == 'attribute':
                code = code.replace('int probe_entry(unsigned id', '__attribute__((optimize("ipa-reference")))\nint probe_entry(unsigned id')
            control['request']['code'] = code
            cases.append(control)
        (output / 'fixtures.json').write_text(json.dumps(cases, indent=2) + '\n')
        report['fixtures'] = identity(output / 'fixtures.json')
        for fixture in cases:
            request, name = fixture['request'], fixture['id']
            directory = output / name
            directory.mkdir()
            cpp = request['language'] == 'cpp'
            source = directory / ('main.cc' if cpp else 'main.c')
            source.write_text(request['code'])
            obj, program = directory / 'main.o', directory / 'main.wasm'
            command = [str(compiler / 'xgcc'), '-B' + str(output) + '/', '-B' + str(compiler) + '/',
                       '-specs=' + str(work / 'native-driver.specs'), '-nostdinc', '-ffreestanding',
                       '-fno-builtin', '-save-temps=obj', '-v', '-std=' + request['standard'],
                       '-O' + request['optimization'], '-x', 'c++' if cpp else 'c', '-matomics',
                       '-c', str(source), '-o', str(obj)]
            if cpp:
                command[1:1] = ['-fno-exceptions', '-fno-rtti']
            policy = fixture.get('optimizationPolicy')
            if policy == 'explicit-before':
                command[1:1] = ['-fipa-reference']
            elif policy == 'explicit-after':
                command.insert(command.index('-matomics') + 1, '-fipa-reference')
            entry = {'id': name, 'width': fixture['width'], 'status': 'running', 'commands': []}
            if policy:
                entry.update(optimizationPolicy=policy, sourceFixture=fixture['sourceFixture'])
            report['cases'].append(entry)
            compiled = run(command, directory)
            entry['commands'].append(compiled)
            assert compiled['exitCode'] == 0, name + ': ' + compiled['stderr']
            argv = [shlex.split(line.strip()) for line in compiled['stderr'].splitlines()
                    if line.strip().startswith(str(output / 'as') + ' ')]
            assert len(argv) == 1 and argv[0].count('--enable-threads') == 1, name + ': atomics driver forwarding'
            features = target_features(obj)
            assert features.get('atomics') == '+', (name, features)
            wat = (directory / 'main.s').read_text()
            assert '(call $__atomic_' not in wat and '(import "env" "__atomic_' not in wat, name + ': helper escape'
            width = fixture['width']
            prefix = 'i64' if width == 8 else 'i32'
            bits = str(width * 8) if width < 4 else ''
            suffix = '_u' if width < 4 else ''
            for instruction in [f'{prefix}.atomic.rmw{bits}.add{suffix}',
                                f'{prefix}.atomic.rmw{bits}.cmpxchg{suffix}',
                                f'{prefix}.atomic.load{bits}{suffix}', f'{prefix}.atomic.store{bits}', 'atomic.fence']:
                assert '(' + instruction + ' ' in wat or '(' + instruction + ')' in wat, (name, instruction)
            shared = request['sharedMemory']
            link = [str(sdk / 'bin/wasm-ld'), '--no-entry', '--no-stack-first', '--global-base=1024',
                    '-z', 'stack-size=0', '--shared-memory', '--import-memory',
                    '--initial-memory=' + str(shared['initialPages'] * 65536),
                    '--max-memory=' + str(shared['maximumPages'] * 65536),
                    '--extra-features=atomics,bulk-memory,mutable-globals',
                    *['--export=' + export for export in [shared['entry'], '__stack_pointer', '__heap_base',
                                                         '__data_end', '__wasm_call_ctors', '__tls_size']],
                    str(obj), '-L' + str(sdk / 'share/wasi-sysroot/lib/wasm32-wasi'), '-lc',
                    '-o', str(program)]
            linked = run(link, directory)
            entry['commands'].append(linked)
            assert linked['exitCode'] == 0, name + ': ' + linked['stderr']
            executed = run([str(node), str(runner), '--program', str(program), '--fixture', fixture.get('sourceFixture', name),
                            '--output', str(directory / 'execution')], directory, timeout=120)
            entry['commands'].append(executed)
            assert executed['exitCode'] == 0, name + ': ' + executed['stderr']
            receipt = directory / 'execution/execution.json'
            execution = json.loads(receipt.read_text())
            assert execution['status'] == 'passed' and execution['terminatedWorkers'] == 2
            assert execution['overlapMilliseconds'] > 0 and execution['guardsUnchanged'] and execution['fixedMemory']
            entry.update(status='passed', assemblerArgv=argv[0], targetFeatures=features,
                         source=identity(source), assembly=identity(directory / 'main.s'), object=identity(obj),
                         program=identity(program), execution=identity(receipt),
                         memory=identity(directory / 'execution/memory.bin'), observation=execution['observation'])
            (output / 'qualification.json').write_text(json.dumps(report, indent=2) + '\n')
        report.update(status='passed', counts={'cases': len(cases), 'baseCases': 16, 'optimizationControls': 4, 'workersPerCase': 2,
                                               'ticketWindows': len(cases) * 12,
                                               'publicationPhases': len(cases) * 3,
                                               'seqCstRounds': len(cases) * 128})
    except Exception as error:
        report.update(status='failed', error=str(error))
    finally:
        report['inputsUnchanged'] = all(identity(Path(p)) == old for p, old in frozen.items())
        if not report['inputsUnchanged']:
            report.update(status='failed', error='Qualification inputs changed during execution')
        report['finishedUnix'] = time.time()
        (output / 'qualification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['status', 'counts', 'error', 'inputsUnchanged'] if key in report}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
