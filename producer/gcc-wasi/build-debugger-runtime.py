#!/usr/bin/env python3
"""Build unmodified GNU debugging.cc as an optional, separately qualified archive."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SYMBOLS = [
    '_ZSt19is_debugger_presentv', '_ZSt10breakpointv',
    '_ZSt23breakpoint_if_debuggingv',
    '_ZN9__gnu_cxx30debugger_signal_for_breakpointE',
]


def identity(path):
    path = Path(path)
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'bytes': path.stat().st_size, 'sha256': digest}


def content(receipt):
    return {key: receipt[key] for key in ['bytes', 'sha256']}


def checked_path(root, name):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts:
        raise RuntimeError(f'Unsafe inventory path: {name}')
    return root / relative


def build(work, gnu, sdk, output):
    os.umask(0o077)
    for existing in [work, gnu, sdk]:
        if output == existing or output.is_relative_to(existing):
            raise RuntimeError('Debugger output must be outside immutable build inputs')
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    objects, temporary = output / 'objects', output / 'tmp'
    objects.mkdir()
    temporary.mkdir()
    environment = dict(os.environ, LC_ALL='C', PYTHONDONTWRITEBYTECODE='1',
                       TMPDIR=str(temporary), TMP=str(temporary), TEMP=str(temporary))
    frozen = {}
    report = {
        'schemaVersion': 1, 'kind': 'gcc-wasi-debugger-runtime-build',
        'status': 'running', 'host': 'native', 'target': 'wasm32-wasi',
        'startedAt': datetime.now(timezone.utc).isoformat(), 'commands': [],
    }

    def save():
        (output / 'build.json').write_text(json.dumps(report, indent=2) + '\n')

    def artifact(path):
        return {'path': str(Path(path).absolute()), **identity(path)}

    def freeze(path):
        receipt = artifact(path)
        previous = frozen.setdefault(receipt['path'], content(receipt))
        if previous != content(receipt):
            raise RuntimeError(f'Changed debugger build input: {path}')
        return receipt

    def require_identity(path, expected):
        receipt = freeze(path)
        if content(receipt) != content(expected):
            raise RuntimeError(f'Debugger input identity mismatch: {path}')
        return receipt

    def run(command, argv):
        command, argv = str(command), list(map(str, argv))
        result = subprocess.run([command, *argv], cwd=output, env=environment,
                                capture_output=True, text=True, timeout=180)
        receipt = {'command': command, 'argv': argv, 'cwd': str(output),
                   'stdin': None, 'status': result.returncode,
                   'stdout': result.stdout, 'stderr': result.stderr}
        report['commands'].append(receipt)
        save()
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout or f'{command} failed')
        return receipt

    def source_check(component):
        source = work / ('gcc' if component == 'gcc' else 'wabt-source')
        return json.loads(run(sys.executable, ['-B', HERE / 'prepare-source.py',
                          '--component', component, '--source', source])['stdout'])

    try:
        report['recipe'] = freeze(Path(__file__).resolve())
        report['sourceGate'] = freeze(HERE / 'prepare-source.py')
        report['sourceLock'] = freeze(HERE / 'sources.lock.json')
        report['runtimeLock'] = freeze(HERE / 'runtime.lock.json')
        report['debuggerLock'] = freeze(HERE / 'debugger-runtime.lock.json')
        lock = json.loads((HERE / 'debugger-runtime.lock.json').read_text())
        sources = json.loads((HERE / 'sources.lock.json').read_text())
        runtime_lock = json.loads((HERE / 'runtime.lock.json').read_text())
        if lock['gccCommit'] != sources['gcc']['commit']:
            raise RuntimeError('Debugger lock uses another GCC revision')
        if (lock['sdk']['archiveSha256'] != sources['wasiSdk']['sha256']
                or lock['sdk']['archiveSha256'] != runtime_lock['wasiLibc']['sdkArchiveSha256']
                or lock['sdk']['wasiLibcCommit'] != runtime_lock['wasiLibc']['commit']):
            raise RuntimeError('Debugger SDK lock differs from the existing runtime pin')
        for component in ['gcc', 'wabt']:
            for patch in sources[component].get('patches', []):
                if freeze(checked_path(HERE, patch['path']))['sha256'] != patch['sha256']:
                    raise RuntimeError('Source patch differs from its lock')
        report['gccSource'] = source_check('gcc')
        report['wabtSource'] = source_check('wabt')
        report['gccCommit'] = lock['gccCommit']
        report['nativeBuild'] = freeze(work / 'native-build.json')
        native = json.loads((work / 'native-build.json').read_text())
        if (native['gccSource'] != report['gccSource']
                or native['sourceLockSha256'] != report['sourceLock']['sha256']
                or native['host'] != 'native' or native['target'] != 'wasm32-wasi'):
            raise RuntimeError('Native GCC was not built from the current locked source')
        if freeze(HERE / 'build-native.sh')['sha256'] != native['recipeSha256']:
            raise RuntimeError('Native GCC build recipe changed')
        compiler = work / 'gcc-native/gcc'
        report['nativeCompiler'] = {name: freeze(compiler / name)
                                   for name in ['cc1', 'cc1plus', 'xgcc']}
        for name, tool in report['nativeCompiler'].items():
            if tool['sha256'] != native['tools'][name]['sha256']:
                raise RuntimeError('Native GCC binary identity mismatch')
        wabt = work / 'wabt-native'
        report['assemblerBuild'] = freeze(wabt / 'provenance.json')
        assembler = json.loads((wabt / 'provenance.json').read_text())
        if (assembler['source'] != report['wabtSource'] or not assembler['inputsUnchanged']
                or assembler['host'] != 'native'):
            raise RuntimeError('WABT was not built from the current locked source')
        for name, expected in assembler['recipes'].items():
            require_identity(checked_path(HERE, name), expected)
        report['tools'] = {name: freeze(path) for name, path in {
            'compiler': compiler / 'cc1plus', 'assembler': wabt / 'wat2wasm',
            'validator': wabt / 'wasm-validate', 'objdump': wabt / 'wasm-objdump',
            'ar': sdk / 'bin/llvm-ar', 'nm': sdk / 'bin/llvm-nm',
            'linker': sdk / 'bin/wasm-ld', 'python': Path(sys.executable),
        }.items()}
        for name in ['wat2wasm', 'wasm-validate', 'wasm-objdump']:
            require_identity(wabt / name, assembler['files'][name])
        report['runtimeImport'] = freeze(work / 'runtime-current/runtime-build.json')
        imported = json.loads((work / 'runtime-current/runtime-build.json').read_text())
        if (imported['runtimeLock'] != content(report['runtimeLock'])
                or imported['sdkArchiveSha256'] != lock['sdk']['archiveSha256']):
            raise RuntimeError('Existing target runtime uses another SDK archive')
        runtime = work / 'runtime-current/sysroot'
        imported_by_name = {item['path']: item for item in imported['files']}
        report['runtime'] = {}
        for name in ['crt1-command.o', 'libc.a', 'libm.a',
                     'libc-printscan-long-double.a', 'libclang_rt.builtins-wasm32.a']:
            relative = 'lib/wasm32-wasi/' + name
            report['runtime'][name] = require_identity(runtime / relative, imported_by_name[relative])
        report['baseGnuRuntime'] = {
            'root': str(gnu), 'build': freeze(gnu / 'build.json'),
            'receipt': freeze(gnu / 'libstdcxx-build.json'),
        }
        base = report['baseGnuRuntime']
        built = json.loads((gnu / 'build.json').read_text())
        qualified = json.loads((gnu / 'libstdcxx-build.json').read_text())
        if (qualified['status'] != 'passed' or built['gccSource'] != report['gccSource']
                or built['nativeCompiler'] != {name: tool['sha256']
                                             for name, tool in report['nativeCompiler'].items()}
                or qualified['debugger'] is not False or built['debugger'] is not False):
            raise RuntimeError('Base GNU runtime does not match the unchanged qualified compiler')
        require_identity(gnu / 'build.json', qualified['buildReceipt'])
        base['qualification'] = require_identity(
            checked_path(gnu, qualified['qualification']['path']), qualified['qualification'])
        qualification = json.loads(Path(base['qualification']['path']).read_text())
        if (qualification['status'] != 'passed'
                or qualification['buildReceipt'] != content(base['build'])):
            raise RuntimeError('Base GNU qualification covers another runtime build')
        base['libraries'] = {name: require_identity(gnu / 'sysroot/lib/wasm32-wasi' / name, expected)
                             for name, expected in built['libraries'].items()}
        for item in qualified['files']:
            require_identity(checked_path(gnu / 'sysroot', item['path']), item)
        base['unchanged'] = True
        report['lockedGccFiles'] = {name: require_identity(work / 'gcc' / name, expected)
                                   for name, expected in lock['gccFiles'].items()}
        report['sdkFiles'] = {name: require_identity(sdk / name, expected)
                             for name, expected in lock['sdk']['files'].items()}
        include = gnu / 'sysroot/include/c++' / sources['gcc']['version']
        configured = sorted(path for path in include.glob('wasm32-*') if path.is_dir())
        if len(configured) != 1:
            raise RuntimeError('Expected one configured GNU target header directory')
        require_identity(include / 'debugging', lock['gccFiles']['libstdc++-v3/include/std/debugging'])
        require_identity(gnu / 'target-headers/include/wasm32-wasi/__errno.h', built['errnoHeader'])
        report['includeDirectories'] = list(map(str, [
            include, configured[0], compiler / 'include',
            gnu / 'target-headers/include/wasm32-wasi',
            sdk / 'share/wasi-sysroot/include/wasm32-wasi',
        ]))
        flags = [
            '-quiet', '-O0', '-g0', '-std=gnu++26', '-mno-simd128',
            '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics', '-fuse-cxa-atexit',
            '-fdiagnostics-color=never', '-nostdinc', '-D__GCC_WASI_SINGLE_THREAD__=1',
            '-D_WASI_EMULATED_SIGNAL=1',
            *[argument for directory in report['includeDirectories']
              for argument in ['-isystem', directory]],
        ]
        report['compilerArguments'] = flags
        source = work / 'gcc/libstdc++-v3/src/c++26/debugging.cc'
        report['source'] = freeze(source)
        assembly, obj, dependencies = [objects / ('debugging' + suffix)
                                        for suffix in ['.wat', '.o', '.d']]
        run(compiler / 'cc1plus', [*flags, '-M', '-MF', dependencies,
                                 '-MT', 'debugging.o', source, '-o', os.devnull])
        names = shlex.split(dependencies.read_text().replace('\\\n', ' ').split(':', 1)[1])
        report['headers'] = [freeze(name) for name in sorted(set(names)) if Path(name) != source]
        report['compile'] = run(compiler / 'cc1plus', [*flags, source, '-o', assembly])
        report['assembly'] = artifact(assembly)
        report['assemble'] = run(wabt / 'wat2wasm', ['-r', '--enable-annotations', assembly, '-o', obj])
        report['object'] = artifact(obj)
        report['validate'] = run(wabt / 'wasm-validate', [obj])
        symbols = run(sdk / 'bin/llvm-nm', ['--defined-only', obj])
        defined = {line.split()[-1] for line in symbols['stdout'].splitlines() if line.split()}
        if not set(SYMBOLS).issubset(defined):
            raise RuntimeError('Unmodified GNU debugging source did not define all required symbols')
        report['symbols'] = SYMBOLS
        report['symbolTable'] = symbols
        installed = output / 'sysroot/lib/wasm32-wasi'
        installed.mkdir(parents=True)
        report['archive'] = run(sdk / 'bin/llvm-ar', ['rcs', installed / 'libstdc++debugger.a', obj])
        signal_library = sdk / 'share/wasi-sysroot/lib/wasm32-wasi/libwasi-emulated-signal.a'
        shutil.copyfile(signal_library, installed / signal_library.name)
        report['libraries'] = {name: artifact(installed / name)
                               for name in ['libstdc++debugger.a', signal_library.name]}
        report['files'] = [{'path': 'lib/wasm32-wasi/' + name, **content(receipt)}
                           for name, receipt in report['libraries'].items()]
        report['profile'] = lock['profile']
        if source_check('gcc') != report['gccSource'] or source_check('wabt') != report['wabtSource']:
            raise RuntimeError('Source changed during debugger runtime build')
        report['inputs'] = [{'path': name, **value} for name, value in sorted(frozen.items())]
        report['inputsUnchanged'] = all(identity(name) == expected for name, expected in frozen.items())
        if not report['inputsUnchanged']:
            raise RuntimeError('Debugger runtime inputs changed during build')
        report['status'] = 'built-unverified'
        report['completedAt'] = datetime.now(timezone.utc).isoformat()
        save()
        print(json.dumps({'status': report['status'], 'build': str(output / 'build.json'),
                          'libraries': report['files']}))
    except Exception as error:
        report.update(status='failed', error=str(error),
                      completedAt=datetime.now(timezone.utc).isoformat())
        save()
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['work', 'gnu', 'sdk', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    paths = [getattr(args, name).expanduser().resolve() for name in ['work', 'gnu', 'sdk', 'output']]
    if any(any(character.isspace() for character in str(path)) for path in paths):
        parser.error('GCC dependency paths must not contain whitespace')
    build(*paths)
