#!/usr/bin/env python3
"""Build the pinned official libgcov subset; never provide replacement counters."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess

HERE = Path(__file__).resolve().parent


def identity(path):
    data = Path(path).read_bytes()
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def build(work, sdk, sysroot, output):
    output.mkdir(parents=True, exist_ok=False)
    compiler, source = work / 'gcc-native/gcc', work / 'gcc'
    wabt = work / 'wabt-native'
    configuration, driver, objects = [output / name for name in ['configuration', 'driver', 'objects']]
    for directory in [configuration, driver, objects, output / 'tmp']:
        directory.mkdir()
    environment = dict(os.environ, LC_ALL='C', TMPDIR=str(output / 'tmp'),
                       TMP=str(output / 'tmp'), TEMP=str(output / 'tmp'))
    frozen = {}

    def freeze(path):
        path = Path(path).resolve()
        current = identity(path)
        if str(path) in frozen and frozen[str(path)] != current:
            raise RuntimeError(f'Changed libgcov input: {path}')
        frozen[str(path)] = current
        return {'path': str(path), **current}

    report = {'schemaVersion': 1, 'kind': 'gcc-wasi-libgcov-build', 'status': 'running',
              'target': 'wasm32-wasi', 'objects': [], 'commands': []}

    def save():
        (output / 'build.json').write_text(json.dumps(report, indent=2) + '\n')

    def run(command, argv, cwd=output, extra_env=None):
        command, argv = str(command), list(map(str, argv))
        result = subprocess.run([command, *argv], cwd=cwd,
                                env={**environment, **(extra_env or {})},
                                capture_output=True, text=True, timeout=180)
        receipt = {'command': command, 'argv': argv, 'cwd': str(cwd), 'stdin': None,
                   'environment': extra_env or {}, 'status': result.returncode,
                   'stdout': result.stdout, 'stderr': result.stderr}
        report['commands'].append(receipt)
        save()
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout or f'{command} failed')
        return receipt

    try:
        report['recipes'] = {name: freeze(HERE / name) for name in
                             ['build-libgcov.sh', 'build-libgcov.py', 'prepare-source.py']}
        report['sourceLock'] = freeze(HERE / 'sources.lock.json')
        report['runtimeLock'] = freeze(HERE / 'runtime.lock.json')
        lock = json.loads((HERE / 'sources.lock.json').read_text())
        runtime_lock = json.loads((HERE / 'runtime.lock.json').read_text())
        for patch in lock['gcc']['patches']:
            if freeze(HERE / patch['path'])['sha256'] != patch['sha256']:
                raise RuntimeError('GCC patch differs from lock')
        report['gccSource'] = json.loads(run('python3', [HERE / 'prepare-source.py', '--source', source])['stdout'])
        report['nativeBuild'] = freeze(work / 'native-build.json')
        native = json.loads((work / 'native-build.json').read_text())
        if native['gccSource'] != report['gccSource'] or native['sourceLockSha256'] != report['sourceLock']['sha256']:
            raise RuntimeError('Native compiler is not from the current locked source')
        report['nativeCompiler'] = {name: freeze(compiler / name) for name in ['cc1', 'cc1plus', 'xgcc']}
        for name, tool in report['nativeCompiler'].items():
            if tool['sha256'] != native['tools'][name]['sha256']:
                raise RuntimeError('Native compiler identity mismatch')
        report['tools'] = {name: freeze(path) for name, path in {
            'assembler': wabt / 'wat2wasm', 'validator': wabt / 'wasm-validate',
            'ar': sdk / 'bin/llvm-ar', 'nm': sdk / 'bin/llvm-nm',
            'ranlib': sdk / 'bin/llvm-ranlib', 'linker': sdk / 'bin/wasm-ld'}.items()}
        report['runtimeImport'] = freeze(sysroot.parent / 'runtime-build.json')
        imported = json.loads((sysroot.parent / 'runtime-build.json').read_text())
        if imported['runtimeLock'] != identity(HERE / 'runtime.lock.json'):
            raise RuntimeError('Target sysroot uses another runtime lock')
        for item in imported['files']:
            if identity(sysroot / item['path']) != {key: item[key] for key in ['bytes', 'sha256']}:
                raise RuntimeError(f'Target sysroot import changed: {item["path"]}')
        library = sysroot / 'lib/wasm32-wasi'
        builtins = library / 'libclang_rt.builtins-wasm32.a'
        getpid = sdk / 'share/wasi-sysroot/lib/wasm32-wasi/libwasi-emulated-getpid.a'
        report['getpid'] = freeze(getpid)
        expected = runtime_lock['coverage']['sdkLibraries']['libwasi-emulated-getpid.a']
        if identity(getpid) != expected:
            raise RuntimeError('Official SDK getpid archive mismatch')
        report['libc'] = {name: freeze(library / name) for name in
                          ['crt1-command.o', 'libc.a', 'libm.a', builtins.name]}
        specs = driver / 'runtime.specs'
        specs.write_text(f'''*startfile:
{library}/crt1-command.o

*lib:
-lm -lc

*libgcc:
{builtins}

*link:
%{{!o:-o a.out}} --fatal-warnings -L{library} -e _start

*cc1plus:

''')
        for name, command in {
            'gcc': [compiler / 'xgcc', '-B' + str(driver) + '/', '-B' + str(compiler) + '/',
                    '-specs=' + str(specs), '--sysroot=' + str(sysroot),
                    '-D__GCC_WASI_SINGLE_THREAD__=1', '-isystem', sysroot / 'include/wasm32-wasi'],
            'as': [wabt / 'wat2wasm'], 'ld': [sdk / 'bin/wasm-ld'],
            'collect-ld': [sdk / 'bin/wasm-ld']}.items():
            wrapper = driver / name
            wrapper.write_text('#!/usr/bin/env bash\nset -euo pipefail\nexec '
                               + shlex.join(map(str, command)) + ' "$@"\n')
            wrapper.chmod(0o755)
        report['driver'] = [freeze(path) for path in sorted(driver.iterdir())]
        triple = run(source / 'config.guess', [])['stdout'].strip()
        run(source / 'libgcc/configure', ['--build=' + triple, '--host=wasm32-wasi',
            '--target=wasm32-wasi', '--disable-shared', '--disable-multilib',
            '--disable-decimal-float', '--disable-vtable-verify', '--disable-tls',
            '--prefix=' + str(output / 'install')], cwd=configuration,
            extra_env={'CC': str(driver / 'gcc'), 'CFLAGS': '-O0 -g0',
                       'AR': str(sdk / 'bin/llvm-ar'), 'RANLIB': str(sdk / 'bin/llvm-ranlib'),
                       'NM': str(sdk / 'bin/llvm-nm'), 'AS': str(driver / 'as'),
                       'LD': str(driver / 'ld'), 'MAKEINFO': 'true'})
        run('make', ['gcc_objdir=' + str(compiler), 'libgcc_tm.h'], cwd=configuration)
        report['configuration'] = {name: freeze(configuration / name) for name in
                                   ['Makefile', 'auto-target.h', 'libgcc_tm.h']}
        flags = ['-quiet', '-O0', '-g0', '-std=gnu11', '-fdiagnostics-color=never', '-nostdinc',
                 '-D__GCC_WASI_SINGLE_THREAD__=1', '-D_WASI_EMULATED_GETPID=1',
                 '-DIN_LIBGCC2', '-DIN_GCC', '-DCROSS_DIRECTORY_STRUCTURE',
                 '-fbuilding-libgcc', '-fno-stack-protector',
                 *['-I' + str(path) for path in [configuration, compiler, source / 'libgcc',
                                                source / 'gcc', source / 'include']],
                 '-isystem', str(compiler / 'include'), '-isystem', str(sysroot / 'include/wasm32-wasi')]
        for name, filename in [('_gcov', 'libgcov-driver.c'), ('_gcov_merge_add', 'libgcov-merge.c')]:
            selected = source / 'libgcc' / filename
            assembly, obj, dependencies = [objects / (name + suffix) for suffix in ['.wat', '.o', '.d']]
            common = [*flags, '-DL' + name]
            # cc1 still opens its ordinary assembly output with -M. Direct it
            # explicitly away from the immutable upstream source directory.
            run(compiler / 'cc1', [*common, '-M', '-MF', dependencies, '-MT', obj,
                                  selected, '-o', os.devnull], cwd=configuration)
            # Build paths are whitespace-free, so make's dependency continuation
            # syntax is enough to enumerate the compiler's actual header inputs.
            names = dependencies.read_text().replace('\\\n', ' ').split(': ', 1)[1].split()
            header_inputs = [freeze(path) for path in sorted(set(names))]
            entry = {'selection': '-DL' + name, 'source': freeze(selected), 'headers': header_inputs,
                     'commands': {}}
            report['objects'].append(entry)
            entry['commands']['compile'] = run(compiler / 'cc1', [*common, selected, '-o', assembly], cwd=configuration)
            entry['assembly'] = freeze(assembly)
            entry['commands']['assemble'] = run(wabt / 'wat2wasm', ['-r', '--enable-annotations', assembly, '-o', obj])
            entry['object'] = freeze(obj)
            entry['commands']['validate'] = run(wabt / 'wasm-validate', [obj])
            entry['commands']['symbols'] = run(sdk / 'bin/llvm-nm', ['--undefined-only', obj])
        installed = output / 'sysroot/lib/wasm32-wasi'
        installed.mkdir(parents=True)
        run(sdk / 'bin/llvm-ar', ['rcs', installed / 'libgcov.a',
                                *[entry['object']['path'] for entry in report['objects']]])
        shutil.copyfile(getpid, installed / getpid.name)
        report['libraries'] = {name: freeze(installed / name) for name in ['libgcov.a', getpid.name]}
        report['files'] = [{'path': 'lib/wasm32-wasi/' + name, **identity(installed / name)}
                           for name in report['libraries']]
        report['profile'] = {'format': 'gcc-gcov', 'update': 'single', 'normalExit': True,
                             'manualGcovApi': False, 'pgo': False, 'threads': False,
                             'processPidSemantics': False, 'directoryCreation': False}
        after = json.loads(run('python3', [HERE / 'prepare-source.py', '--source', source])['stdout'])
        if after != report['gccSource']:
            raise RuntimeError('GCC source changed during runtime build')
        report['inputs'] = [{'path': name, **value} for name, value in sorted(frozen.items())]
        report['inputsUnchanged'] = all(identity(name) == expected for name, expected in frozen.items())
        if not report['inputsUnchanged']:
            raise RuntimeError('libgcov inputs changed during build')
        report['status'] = 'built-unverified'
        save()
    except Exception as error:
        report.update(status='failed', error=str(error))
        save()
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['work', 'sdk', 'sysroot', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    paths = [getattr(args, name).resolve() for name in ['work', 'sdk', 'sysroot', 'output']]
    if any(any(character.isspace() for character in str(path)) for path in paths):
        parser.error('GCC specs require whitespace-free build paths')
    build(*paths)
