#!/usr/bin/env python3
"""Execute genuine GCC/GNU native-EH fixtures, with a small ABI bootstrap mode.

Bootstrap builds real libsupc++ from the locked source using explicitly bound
GNU configuration headers. It is never accepted as a complete libstdc++ build.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def identity(file):
    file = Path(file)
    with file.open('rb') as stream:
        return {'path': str(file), 'bytes': file.stat().st_size,
                'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def save(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['work', 'sdk', 'sysroot', 'output', 'node']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--bootstrap', action='store_true')
    parser.add_argument('--gnu-headers', type=Path)
    parser.add_argument('--gnu-config', type=Path)
    parser.add_argument('--runtime', type=Path)
    args = parser.parse_args()
    for name in ['work', 'sdk', 'sysroot', 'output', 'node', 'gnu_headers', 'gnu_config', 'runtime']:
        if getattr(args, name):
            setattr(args, name, getattr(args, name).resolve())
    if args.bootstrap:
        if not args.gnu_headers or not args.gnu_config or args.runtime:
            parser.error('--bootstrap requires --gnu-headers and --gnu-config, and excludes --runtime')
    elif not args.runtime:
        parser.error('Full runtime qualification requires --runtime')
    if args.output.exists():
        raise RuntimeError('Preserve existing execution evidence; use a new output directory')
    args.output.mkdir(parents=True)
    source = args.work / 'gcc'
    compiler = args.work / 'gcc-native/gcc'
    wabt = args.work / 'wabt-native'
    report = {'schemaVersion': 1, 'kind': 'gnu-native-wasm-eh-execution', 'status': 'running',
              'pid': os.getpid(), 'started': time.time(),
              'scope': 'small-libsupc++-bootstrap' if args.bootstrap else 'full-gnu-runtime',
              'fullGnuLibrary': not args.bootstrap, 'commands': [], 'runtimeObjects': [], 'cases': []}
    report_file = args.output / 'qualification.json'
    save(report_file, report)
    frozen = []

    def run(argv, name, directory=args.output, timeout=120):
        stdout = directory / (name + '.stdout')
        stderr = directory / (name + '.stderr')
        env = {**os.environ, 'LC_ALL': 'C'}
        for key in ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH',
                    'LIBRARY_PATH', 'COMPILER_PATH', 'GCC_EXEC_PREFIX']:
            env.pop(key, None)
        started = time.time()
        timed_out = None
        with stdout.open('xb') as out, stderr.open('xb') as err:
            try:
                result = subprocess.run([str(x) for x in argv], cwd=directory, env=env,
                                        stdout=out, stderr=err, timeout=timeout)
                exit_code = result.returncode
            except subprocess.TimeoutExpired as error:
                exit_code = None
                timed_out = error
        command = {'argv': [str(x) for x in argv], 'exitCode': exit_code,
                   'timeoutSeconds': timeout, 'timedOut': timed_out is not None,
                   'seconds': time.time() - started, 'stdout': identity(stdout), 'stderr': identity(stderr)}
        report['commands'].append(command)
        if timed_out:
            raise RuntimeError(f'{name} timed out after {timeout}s: {stderr.read_text()[-4000:]}') from timed_out
        if exit_code != 0:
            raise RuntimeError(f'{name} failed ({exit_code}): {stderr.read_text()[-4000:]}')
        return command

    try:
        lock = json.loads((HERE / 'sources.lock.json').read_text())
        assert any(x['path'] == 'patches/0028-wasm-eh-runtime.patch' for x in lock['gcc']['patches'])
        command = run(['python3', HERE / 'prepare-source.py', '--source', source], 'source-check', timeout=600)
        gcc_source = json.loads(Path(command['stdout']['path']).read_text())
        native_build_file = args.work / 'native-build.json'
        native_build = json.loads(native_build_file.read_text())
        assert native_build['gccSource'] == gcc_source, 'Compiler and runtime source must match'
        report.update(gccSource=gcc_source, nativeBuild=identity(native_build_file),
                      sourceLock=identity(HERE / 'sources.lock.json'),
                      runtimeLock=identity(HERE / 'runtime.lock.json'))
        runtime_lock = json.loads((HERE / 'runtime.lock.json').read_text())
        pinned = runtime_lock['exceptionHandling']['unwinder']
        unwind = args.sdk / pinned['sdkRelativePath']
        assert {k: identity(unwind)[k] for k in ['bytes', 'sha256']} == {k: pinned[k] for k in ['bytes', 'sha256']}
        includes = args.gnu_headers if args.bootstrap else args.runtime / 'install'
        config = args.gnu_config if args.bootstrap else args.runtime / 'build'
        gnu_include = includes / 'include/c++' / lock['gcc']['version']
        if args.bootstrap:
            config_header = gnu_include / 'wasm32-wasi/bits/c++config.h'
            assert not re.search(r'^#define _GLIBCXX_HAVE_TLS\s+1\b', config_header.read_text(), re.M)
        else:
            build = json.loads((args.runtime / 'build.json').read_text())
            assert build['status'] == 'built-unverified' and build['fullGnuLibrary'] is True
            assert build['exceptions'] is True and build['profile'] == 'ordinary-private-modern'
            assert build['gccSource'] == gcc_source and build['nativeBuild'] == identity(native_build_file)
            report['runtimeBuild'] = identity(args.runtime / 'build.json')
            report['files'] = build['files']
        fixture_files = [HERE / 'eh-native-fixtures.mjs', HERE / 'eh-runtime-fixtures.mjs']
        if not args.bootstrap:
            fixture_files.append(HERE / 'eh-library-fixtures.mjs')
        inputs = {Path(__file__).resolve(), *fixture_files, HERE / 'run-eh-program.mjs', HERE / 'prepare-source.py',
                  HERE / 'sources.lock.json', HERE / 'runtime.lock.json', native_build_file,
                  args.work / 'native-driver.specs', compiler / 'xgcc', compiler / 'cc1', compiler / 'cc1plus',
                  wabt / 'wat2wasm', wabt / 'wasm-objdump', args.sdk / 'bin/wasm-ld',
                  args.sdk / 'bin/llvm-ar', args.sdk / 'bin/llvm-nm', args.node, unwind}
        inputs.update(HERE / x['path'] for x in lock['gcc']['patches'])
        for directory in [compiler / 'include', gnu_include, source / 'libgcc', source / 'include',
                          source / 'libstdc++-v3/libsupc++', args.sysroot / 'include']:
            inputs.update(p for p in directory.rglob('*') if p.is_file())
        inputs.update(config.glob('*.h'))
        lib = args.sysroot / 'lib/wasm32-wasi'
        base_libraries = [lib / x for x in ['crt1-command.o', 'libm.a', 'libc.a', 'libclang_rt.builtins-wasm32.a']]
        inputs.update(base_libraries)
        if not args.bootstrap:
            inputs.add(args.runtime / 'build.json')
            inputs.update(p for p in (args.runtime / 'sysroot').rglob('*') if p.is_file())
        else:
            inputs.add(source / 'libiberty/cp-demangle.c')
            inputs.add(source / 'libstdc++-v3/config/cpu/generic/atomicity_mutex/atomicity.h')
        frozen = [identity(p) for p in sorted(inputs)]
        report['inputs'] = frozen
        resource = args.output / 'runtime-include'
        resource.mkdir()
        # all-gcc does not run libgcc's install-unwind_h-forbuild target.
        # Install that component's unmodified public header for this build.
        shutil.copy2(source / 'libgcc/unwind-generic.h', resource / 'unwind.h')
        report['unwindHeader'] = {'source': identity(source / 'libgcc/unwind-generic.h'),
                                  'installed': identity(resource / 'unwind.h')}
        common = [compiler / 'xgcc', '-B' + str(compiler) + '/', '-specs=' + str(args.work / 'native-driver.specs'),
                  '-S', '-g0', '-mexception-handling', '-fexceptions', '-D__GCC_WASI_SINGLE_THREAD__=1',
                  '-nostdinc', '-isystem', compiler / 'include', '-isystem', resource,
                  '-isystem', source / 'libgcc',
                  '-isystem', gnu_include, '-isystem', gnu_include / 'wasm32-wasi',
                  '-isystem', args.sysroot / 'include/wasm32-wasi']

        def compile_one(input_file, object_file, name, directory, cpp=True, optimization='0', rtti=True, runtime=False, standard=None):
            assembly = object_file.with_suffix('.wat')
            options = ['-x', 'c++' if cpp else 'c', '-std=' + (standard or ('gnu++17' if cpp else 'c11')), '-O' + optimization]
            if cpp:
                options += ['-frtti' if rtti else '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics']
            if runtime:
                options += ['-DHAVE_CONFIG_H', '-D_GLIBCXX_EH_POOL_STATIC', '-I' + str(config),
                            '-I' + str(source / 'include'), '-I' + str(source / 'libstdc++-v3/libsupc++')]
                if not cpp:
                    options.append('-DIN_GLIBCPP_V3')
            run([*common, *options, input_file, '-o', assembly], name + '-compile', directory)
            run([wabt / 'wat2wasm', '--enable-exceptions', '--enable-annotations', '-r',
                 assembly, '-o', object_file], name + '-assemble', directory)
            inspected = run([wabt / 'wasm-objdump', '-x', '-d', '-r', object_file], name + '-inspect', directory)
            disassembly = Path(inspected['stdout']['path']).read_text()
            assert not re.search(r'\|\s*(try|catch|catch_all|rethrow)(?:\s|$)', disassembly), str(input_file)
            return {'source': identity(input_file), 'assembly': identity(assembly), 'object': identity(object_file),
                    'inspection': inspected['stdout']}

        if args.bootstrap:
            directory = args.output / 'runtime'
            directory.mkdir()
            makefile = source / 'libstdc++-v3/libsupc++/Makefile.am'
            content = makefile.read_text().split('sources = \\\n', 1)[1].split('\n\nif ENABLE_VTABLE_VERIFY', 1)[0]
            names = re.findall(r'\b[\w-]+\.cc', content)
            assert 50 < len(names) < 90 and len(names) == len(set(names))
            sources = [source / ('libstdc++-v3/config/cpu/generic/atomicity_mutex/atomicity.h'
                       if name == 'atomicity.cc' else 'libstdc++-v3/libsupc++/' + name) for name in names]
            sources.append(source / 'libiberty/cp-demangle.c')
            for index, input_file in enumerate(sources):
                obj = directory / (input_file.name.replace('.h', '.cc') + '.o')
                result = compile_one(input_file, obj, f'unit-{index}', directory,
                                     cpp=input_file.suffix != '.c', runtime=True)
                report['runtimeObjects'].append(result)
            archive = directory / 'libsupc++.a'
            run([args.sdk / 'bin/llvm-ar', 'rcsD', archive,
                 *[x['object']['path'] for x in report['runtimeObjects']]], 'archive', directory)
            report['bootstrapArchive'] = identity(archive)
            libraries = [archive, unwind]
        else:
            private = args.runtime / 'sysroot/lib/wasm32-wasi-eh'
            libraries = [private / name for name in ['libstdc++.a', 'libsupc++.a', 'libunwind.a']]
        load = f"import {{nativeEhCases}} from {json.dumps(fixture_files[0].as_uri())};import {{exceptionRuntimeCases}} from {json.dumps(fixture_files[1].as_uri())};"
        if args.bootstrap:
            load += 'const cases = [...nativeEhCases,...exceptionRuntimeCases];'
        else:
            load += f"import {{exceptionLibraryCases}} from {json.dumps(fixture_files[2].as_uri())};const cases = [...nativeEhCases,...exceptionRuntimeCases,...exceptionLibraryCases];"
        load += 'console.log(JSON.stringify(cases));'
        command = run([args.node, '--input-type=module', '-e', load], 'load-fixtures')
        fixtures = json.loads(Path(command['stdout']['path']).read_text())
        expected_count = 28 if args.bootstrap else 46
        assert len(fixtures) == expected_count and len({x['id'] for x in fixtures}) == expected_count
        report['nativeFixtures'] = identity(fixture_files[0])
        report['nativeCaseIds'] = [fixture['id'] for fixture in fixtures[:14]]
        assert all(name.startswith('eh-native-') for name in report['nativeCaseIds'])
        for fixture in fixtures:
            directory = args.output / fixture['id']
            directory.mkdir()
            request = fixture['request']
            (directory / 'main.cpp').write_text(request['code'])
            for file in request.get('files', []):
                relative = Path(file['path'])
                assert not relative.is_absolute() and '..' not in relative.parts
                destination = directory / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(file['contents'])
            units = []
            for index, name in enumerate(['main.cpp', *request.get('sources', [])]):
                units.append(compile_one(directory / name, directory / f'unit{index}.o',
                                         f'unit-{index}', directory, optimization=request['optimization'],
                                         rtti=request.get('rtti', False), standard=request['standard']))
            program = directory / 'main.wasm'
            run([args.sdk / 'bin/wasm-ld', '--fatal-warnings', '--entry=_start', '--export=_start',
                 '--wrap=__main_void', '--wrap=__wasm_call_ctors', '--wrap=__wasm_call_dtors', '--wrap=exit',
                 '-z', 'stack-size=131072', '--initial-memory=4194304', '--max-memory=4194304',
                 base_libraries[0], *[x['object']['path'] for x in units], *libraries,
                 *base_libraries[1:], '-o', program], 'link', directory)
            inspection = run([wabt / 'wasm-objdump', '-x', '-d', program], 'program-inspect', directory)
            assert not re.search(r'\|\s*(try|catch|catch_all|rethrow)(?:\s|$)',
                                 Path(inspection['stdout']['path']).read_text())
            (directory / 'stdin.txt').write_text(fixture.get('run', {}).get('stdin', ''))
            run([args.node, '--no-warnings', HERE / 'run-eh-program.mjs', program, directory,
                 *fixture.get('run', {}).get('args', [])], 'execute', directory)
            observed = json.loads((directory / 'result.json').read_text())
            expected = fixture.get('expected', {key: fixture[key] for key in ['stdout', 'stderr', 'exitCode']} if 'stdout' in fixture else {})
            assert not expected.get('abnormalTermination'), 'A generic abnormal exit cannot prove GNU terminate semantics'
            assert observed['escapedException'] is None, (fixture['id'], observed)
            assert observed['stdout'] == expected['stdout'] and observed['stderr'] == expected.get('stderr', '')
            assert observed['exitCode'] == expected['exitCode'], (fixture['id'], observed)
            report['cases'].append({'id': fixture['id'], 'request': request, 'run': fixture.get('run', {}),
                                    'expected': expected, 'units': units, 'program': identity(program),
                                    'inspection': inspection['stdout'], 'result': identity(directory / 'result.json'),
                                    'observations': observed, 'status': 'passed'})
            save(report_file, report)
        command = run(['python3', HERE / 'prepare-source.py', '--source', source], 'source-check-after', timeout=600)
        assert json.loads(Path(command['stdout']['path']).read_text()) == gcc_source
        report.update(status='passed', counts={'total': len(report['cases']), 'native': 14,
                                              'runtime': 14, 'library': 0 if args.bootstrap else 18})
    except Exception as error:
        report.update(status='failed', error=repr(error))
        raise
    finally:
        report['inputsUnchanged'] = frozen == [identity(x['path']) for x in frozen]
        report['completed'] = time.time()
        save(report_file, report)


if __name__ == '__main__':
    main()
