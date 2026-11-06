#!/usr/bin/env python3
"""Build the locked GNU TLS cleanup port and import exact SDK threads archives."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
GNU_SOURCES = ('atexit_thread.cc', 'new_opnt.cc', 'new_op.cc', 'new_handler.cc',
               'del_op.cc', 'del_ops.cc')
PROFILE_FILES = {
    'ordinary': 'lib/wasm32-wasi-tls/libgcc-wasi-tls.a',
    'shared': 'lib/wasm32-wasi-threads/libgcc-wasi-tls-shared.a',
}
SDK_MEMBERS = {
    'share/wasi-sysroot/lib/wasm32-wasi-threads/libc.a': 'lib/wasm32-wasi-threads/libc.a',
    'share/wasi-sysroot/lib/wasm32-wasi-threads/libm.a': 'lib/wasm32-wasi-threads/libm.a',
    'lib/clang/22/lib/wasm32-unknown-wasi-threads/libclang_rt.builtins.a':
        'lib/wasm32-wasi-threads/libclang_rt.builtins-wasm32.a',
    'share/wasi-sysroot/lib/wasm32-wasi/libm.a': 'lib/wasm32-wasi-tls/libm.a',
    'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a':
        'lib/wasm32-wasi-tls/libclang_rt.builtins-wasm32.a',
}
TLS_ERRNO_HEADER = 'include/wasm32-wasi-tls/__errno.h'
SDK_ERRNO_HEADER = 'share/wasi-sysroot/include/wasm32-wasi/__errno.h'


def tls_errno_header(original):
    declaration = b'extern _Thread_local int errno;'
    if original.count(declaration) != 1:
        raise RuntimeError('Pinned SDK errno declaration changed')
    return original.replace(declaration, b'''#if !defined(__wasm_tls__)
#error "Native TLS errno requires the explicit TLS target profile"
#endif
#ifdef __cplusplus
extern thread_local int errno;
#else
extern _Thread_local int errno;
#endif''')


def identity(file):
    path = Path(file)
    with path.open('rb') as stream:
        return {'bytes': path.stat().st_size,
                'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def compile_arguments(profile, source, assembly, compiler, sysroot, gnu):
    if profile not in PROFILE_FILES:
        raise ValueError('Unknown TLS runtime profile')
    headers = gnu / 'include/c++/17.0.0'
    return ['-quiet', '-O2', '-g0', '-std=gnu++17', '-fdiagnostics-color=never',
            '-fno-stack-protector', '-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit',
            '-mtls', '-nostdinc',
            *(['-matomics', '-D_GLIBCXX_WASM_TLS_SHARED=1', '-D_REENTRANT=1']
              if profile == 'shared' else ['-mno-atomics']),
            '-isystem', str(compiler / 'include'), '-isystem', str(headers),
            '-isystem', str(headers / 'wasm32-wasi'), '-isystem', str(headers / 'backward'),
            '-isystem', str(assembly.parents[2] / 'sysroot/include/wasm32-wasi-tls'),
            '-isystem', str(sysroot / 'include/wasm32-wasi'), str(source), '-o', str(assembly)]


def check_object(profile, member, assembly, disassembly, symbols):
    if '__emutls_' in assembly or '__emutls_' in symbols:
        raise RuntimeError('GNU cleanup runtime must use native TLS')
    if profile == 'ordinary' and ('.atomic.' in disassembly or 'atomic.fence' in disassembly):
        raise RuntimeError('Ordinary TLS runtime must remain independent of atomics')
    if member == 'atexit_thread.o':
        for name in ['__cxa_thread_atexit', '__wasm_call_thread_dtors']:
            if not any(line.split()[:2] == [name, 'T'] for line in symbols.splitlines()):
                raise RuntimeError('GNU TLS runtime ABI missing: ' + name)
        for name in ['__wrap_exit', '__wrap___wasm_call_dtors']:
            present = any(line.split()[:2] == [name, 'T'] for line in symbols.splitlines())
            if present != (profile == 'ordinary'):
                raise RuntimeError('Unexpected GNU ordinary exit wrapper: ' + name)
        if 'wasm_tls_cleanups' not in symbols:
            raise RuntimeError('GNU per-thread cleanup list is missing')
        if any(name in symbols for name in ['single_thread', '__gthread_', 'pthread_']):
            raise RuntimeError('GNU cleanup must not use the non-threaded global list or pthreads')
    if profile == 'shared' and member == 'new_handler.o':
        for instruction in ['i32.atomic.load', 'i32.atomic.rmw.xchg']:
            if instruction not in disassembly:
                raise RuntimeError('GNU shared new handler lacks native atomics: ' + instruction)
    return {'nativeTls': '__emutls_' not in assembly,
            'ordinaryExitWrappers': profile == 'ordinary' and member == 'atexit_thread.o',
            'atomicInstructions': '.atomic.' in disassembly or 'atomic.fence' in disassembly}


def build(work, sdk, sdk_archive, source, sysroot, gnu, private_libc, output):
    compiler = work / 'gcc-native/gcc'
    if source != work / 'gcc':
        raise ValueError('The native receipt must identify work/gcc')
    if any(output == root or root in output.parents for root in [source, compiler, sdk, sysroot, gnu, private_libc]):
        raise ValueError('TLS output must be isolated from source, tools and input sysroots')
    output.mkdir(parents=True, exist_ok=False)
    for name in ['logs', 'tmp', 'objects', 'licenses', 'sysroot']:
        (output / name).mkdir()
    environment = dict(os.environ, LC_ALL='C', TMPDIR=str(output / 'tmp'),
                       TMP=str(output / 'tmp'), TEMP=str(output / 'tmp'))
    for name in ['CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'LIBS', 'CC', 'CXX',
                 'GCC_EXEC_PREFIX', 'COMPILER_PATH', 'LIBRARY_PATH', 'CPATH',
                 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH']:
        environment.pop(name, None)
    frozen = {}
    report = {'schemaVersion': 1, 'kind': 'gcc-wasi-tls-runtime-build', 'status': 'running',
              'target': 'wasm32-wasi', 'commands': [], 'objects': [], 'files': [], 'licenses': []}

    def save():
        (output / 'build.json').write_text(json.dumps(report, indent=2) + '\n')

    def record(file):
        return {'path': str(Path(file).resolve()), **identity(file)}

    def freeze(file):
        value = record(file)
        old = frozen.setdefault(value['path'], {key: value[key] for key in ['bytes', 'sha256']})
        if old != {key: value[key] for key in ['bytes', 'sha256']}:
            raise RuntimeError('Changed TLS build input: ' + value['path'])
        return value

    def tree(root):
        return [freeze(file) for file in sorted(root.rglob('*')) if file.is_file()]

    def run(command, argv, label, timeout=120):
        receipt = {'command': str(command), 'argv': list(map(str, argv)), 'cwd': str(output),
                   'timeoutSeconds': timeout}
        report['commands'].append(receipt)
        stdout, stderr = [output / 'logs' / (label + '.' + suffix) for suffix in ['stdout', 'stderr']]
        with stdout.open('xb') as out, stderr.open('xb') as err:
            try:
                result = subprocess.run([str(command), *receipt['argv']], cwd=output,
                                        env=environment, stdout=out, stderr=err, timeout=timeout)
                receipt['status'] = result.returncode
            except (OSError, subprocess.TimeoutExpired) as error:
                receipt.update(status=None, error=str(error))
        receipt.update(stdout=record(stdout), stderr=record(stderr))
        save()
        if receipt.get('status') != 0:
            raise RuntimeError(f'TLS command {label} failed: status={receipt.get("status")}; '
                               f'error={receipt.get("error")}; stderr={stderr}')
        return receipt

    def install(origin, relative):
        destination = output / 'sysroot' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, destination)
        value = {'path': relative, **identity(destination)}
        report['files'].append(value)
        return value

    try:
        report['recipes'] = {name: freeze(HERE / name) for name in ['build-tls-runtime.py', 'prepare-source.py']}
        report['sourceLock'] = freeze(HERE / 'sources.lock.json')
        report['runtimeLock'] = freeze(HERE / 'runtime.lock.json')
        lock = json.loads((HERE / 'sources.lock.json').read_text())
        if not any(item['path'] == 'patches/0026-wasm-tls-runtime.patch' for item in lock['gcc']['patches']):
            raise RuntimeError('GNU TLS source patch is not locked')
        for patch in lock['gcc']['patches']:
            if freeze(HERE / patch['path'])['sha256'] != patch['sha256']:
                raise RuntimeError('GCC patch differs from the lock')
        checked = run(sys.executable, [HERE / 'prepare-source.py', '--source', source], 'source-before', 600)
        report['gccSource'] = json.loads(Path(checked['stdout']['path']).read_text())
        report['nativeBuild'] = freeze(work / 'native-build.json')
        native = json.loads((work / 'native-build.json').read_text())
        if native['gccSource'] != report['gccSource'] or native['sourceLockSha256'] != report['sourceLock']['sha256']:
            raise RuntimeError('Native compiler does not identify the locked GNU TLS source')
        report['nativeCompiler'] = {name: freeze(compiler / name) for name in ['cc1', 'cc1plus', 'xgcc']}
        for name, item in report['nativeCompiler'].items():
            if item['sha256'] != native['tools'][name]['sha256']:
                raise RuntimeError('Native compiler identity mismatch')
        report['tools'] = {name: freeze(file) for name, file in {
            'assembler': work / 'wabt-native/wat2wasm', 'validator': work / 'wabt-native/wasm-validate',
            'objdump': work / 'wabt-native/wasm-objdump', 'ar': sdk / 'bin/llvm-ar',
            'nm': sdk / 'bin/llvm-nm', 'linker': sdk / 'bin/wasm-ld', 'python': sys.executable}.items()}
        report['runtimeImport'] = freeze(sysroot.parent / 'runtime-build.json')
        imported = json.loads((sysroot.parent / 'runtime-build.json').read_text())
        if imported['runtimeLock'] != identity(HERE / 'runtime.lock.json'):
            raise RuntimeError('Base runtime import uses another runtime lock')
        report['baseRuntimeFiles'] = []
        for item in imported['files']:
            actual = freeze(sysroot / item['path'])
            if {key: actual[key] for key in ['bytes', 'sha256']} != {key: item[key] for key in ['bytes', 'sha256']}:
                raise RuntimeError('Base runtime input changed: ' + item['path'])
            report['baseRuntimeFiles'].append(actual)
        report['gnuBuild'] = freeze(gnu.parent / 'build.json')
        report['gnuImport'] = freeze(gnu.parent / 'libstdcxx-build.json')
        gnu_build = json.loads((gnu.parent / 'build.json').read_text())
        gnu_import = json.loads((gnu.parent / 'libstdcxx-build.json').read_text())
        if gnu_build['status'] != 'built-unverified' or gnu_import['status'] != 'passed':
            raise RuntimeError('GNU headers require the actual built and qualified GNU runtime')
        if gnu_build['gccSource'] != report['gccSource'] or {key: gnu_import['buildReceipt'][key] for key in ['bytes', 'sha256']} != identity(gnu.parent / 'build.json'):
            raise RuntimeError('GNU headers come from another source/build receipt')
        if gnu_build['nativeCompiler'] != {name: item['sha256'] for name, item in report['nativeCompiler'].items()}:
            raise RuntimeError('GNU headers use another compiler')
        report['gnuHeaders'] = tree(gnu / 'include')
        imported_headers = {item['path']: item for item in gnu_import['files'] if item['path'].startswith('include/')}
        if {str(Path(item['path']).relative_to(gnu)) for item in report['gnuHeaders']} != set(imported_headers):
            raise RuntimeError('GNU header inventory differs from its qualified import')
        for item in report['gnuHeaders']:
            expected = imported_headers[str(Path(item['path']).relative_to(gnu))]
            if any(item[key] != expected[key] for key in ['bytes', 'sha256']):
                raise RuntimeError('Changed GNU header: ' + item['path'])
        report['resourceHeaders'] = tree(compiler / 'include')
        report['librarySources'] = [freeze(source / 'libstdc++-v3/libsupc++' / name) for name in GNU_SOURCES]
        report['sdkArchive'] = freeze(sdk_archive)
        runtime_lock = json.loads((HERE / 'runtime.lock.json').read_text())
        if report['sdkArchive']['sha256'] != runtime_lock['wasiLibc']['sdkArchiveSha256']:
            raise RuntimeError('SDK archive is not the pinned release')
        prefix = 'wasi-sdk-33.0-x86_64-linux/'
        report['sdkImports'] = []
        with tarfile.open(sdk_archive) as packed:
            for member in packed:
                if member.name == prefix + SDK_ERRNO_HEADER:
                    if not member.isfile() or 'sdkErrnoHeader' in report:
                        raise RuntimeError('Unexpected SDK errno header member')
                    original = packed.extractfile(member).read()
                    header = output / 'sysroot' / TLS_ERRNO_HEADER
                    header.parent.mkdir(parents=True, exist_ok=True)
                    header.write_bytes(tls_errno_header(original))
                    installed = {'path': TLS_ERRNO_HEADER, **identity(header)}
                    report['files'].append(installed)
                    report['sdkErrnoHeader'] = {'archiveMember': member.name,
                        'original': {'bytes': len(original), 'sha256': hashlib.sha256(original).hexdigest()},
                        'installed': installed, 'transformation': 'native-tls-profile-c-cpp-declaration'}
                    continue
                relative = SDK_MEMBERS.get(member.name.removeprefix(prefix)) if member.name.startswith(prefix) else None
                if relative is None:
                    continue
                if not member.isfile() or any(item['path'] == relative for item in report['sdkImports']):
                    raise RuntimeError('Unexpected SDK runtime archive member')
                destination = output / 'sysroot' / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(packed.extractfile(member).read())
                value = {'path': relative, **identity(destination)}
                report['files'].append(value)
                report['sdkImports'].append({**value, 'archiveMember': member.name})
        if sorted(item['path'] for item in report['sdkImports']) != sorted(SDK_MEMBERS.values()):
            raise RuntimeError('Missing SDK threads runtime archive')
        if 'sdkErrnoHeader' not in report:
            raise RuntimeError('Missing pinned SDK errno header')
        report['privateLibcBuild'] = freeze(private_libc / 'build.json')
        private = json.loads((private_libc / 'build.json').read_text())
        if (private['kind'] != 'gcc-wasi-private-tls-libc-build' or private['status'] != 'built-unverified'
                or not private['inputsUnchanged'] or private['profile']['threads']
                or private['profile']['atomicWaitNotify'] or not private['profile']['nativeTls']):
            raise RuntimeError('Missing real single-thread native TLS libc build')
        if private['runtimeLock'] != report['runtimeLock']:
            raise RuntimeError('Private libc uses another runtime lock')
        for item in private['inputs']:
            actual = freeze(item['path'])
            if any(actual[key] != item[key] for key in ['bytes', 'sha256']):
                raise RuntimeError('Changed private libc build input')
        report['privateLibcArchives'] = {}
        for name in ['libc.a', 'libc-printscan-long-double.a']:
            libc = private_libc / 'sysroot/lib/wasm32-wasi-tls' / name
            if identity(libc) != {key: private['libraries'][name][key] for key in ['bytes', 'sha256']}:
                raise RuntimeError('Changed private TLS libc archive: ' + name)
            report['privateLibcArchives'][name] = freeze(libc)
            install(libc, 'lib/wasm32-wasi-tls/' + name)
        for profile, archive_path in PROFILE_FILES.items():
            directory = output / 'objects' / profile
            directory.mkdir()
            objects = []
            for name in GNU_SOURCES:
                origin = source / 'libstdc++-v3/libsupc++' / name
                assembly, obj = directory / (Path(name).stem + '.wat'), directory / (Path(name).stem + '.o')
                compiled = run(compiler / 'cc1plus', compile_arguments(profile, origin, assembly, compiler, sysroot, gnu), profile + '-' + name + '-compile')
                assembled = run(work / 'wabt-native/wat2wasm', ['--enable-all', '-r', assembly, '-o', obj], profile + '-' + name + '-assemble')
                validated = run(work / 'wabt-native/wasm-validate', ['--enable-all', obj], profile + '-' + name + '-validate')
                disassembly = run(work / 'wabt-native/wasm-objdump', ['-x', '-d', obj], profile + '-' + name + '-inspect')
                symbols = run(sdk / 'bin/llvm-nm', ['--format=posix', obj], profile + '-' + name + '-symbols')
                inspection = check_object(profile, obj.name, assembly.read_text(), Path(disassembly['stdout']['path']).read_text(), Path(symbols['stdout']['path']).read_text())
                report['objects'].append({'profile': profile, 'member': obj.name, 'source': record(origin),
                    'assembly': record(assembly), 'object': record(obj), 'inspection': inspection,
                    'disassembly': disassembly['stdout'], 'symbols': symbols['stdout'],
                    'compileCommand': report['commands'].index(compiled), 'assembleCommand': report['commands'].index(assembled),
                    'validateCommand': report['commands'].index(validated)})
                objects.append(obj)
            archive = directory / Path(archive_path).name
            run(sdk / 'bin/llvm-ar', ['rcsD', archive, *objects], profile + '-archive')
            listing = run(sdk / 'bin/llvm-ar', ['t', archive], profile + '-members')
            if Path(listing['stdout']['path']).read_text().splitlines() != [obj.name for obj in objects]:
                raise RuntimeError('GNU TLS archive member order changed')
            install(archive, archive_path)
        license_sources = [(source / name, name) for name in ['COPYING3', 'COPYING.RUNTIME']]
        report['licenseSources'] = freeze(HERE / 'licenses/sources.json')
        for item in json.loads((HERE / 'licenses/sources.json').read_text()):
            if not (item['path'].startswith('wasi-libc-') or item['path'] == 'llvm-compiler-rt-LICENSE.TXT'):
                continue
            origin = HERE / 'licenses' / item['path']
            if identity(origin) != {key: item[key] for key in ['bytes', 'sha256']}:
                raise RuntimeError('Pinned runtime license changed')
            license_sources.append((origin, item['path']))
        for origin, name in license_sources:
            destination = output / 'licenses' / name
            shutil.copyfile(origin, destination)
            report['licenses'].append({'source': freeze(origin), 'installed': record(destination)})
        report['profile'] = {'implementation': 'pinned-gnu-atexit-thread-and-sdk-libc',
            'tlsModel': 'local-exec', 'pthread': False, 'allocator': 'pinned-sdk-dlmalloc',
            'registrationLimit': None, 'cleanupOrder': 'per-thread-lifo-including-registration-during-cleanup',
            'ordinary': {'atomics': False, 'libc': 'wasm32-wasi-tls', 'atomicWaitNotify': False,
                'memory': 'private', 'crt': 'wasm32-wasi/crt1-command.o',
                'linkFlags': ['--wrap=exit', '--wrap=__wasm_call_dtors']},
            'shared': {'atomics': True, 'libc': 'wasm32-wasi-threads', 'cleanup': '__wasm_call_thread_dtors',
                'hostReservation': 'lld-stack-before-heap', 'fixedMemory': True,
                'imports': ['env.memory', 'wasi_snapshot_preview1.sched_yield']},
            'executionQualified': False}
        checked = run(sys.executable, [HERE / 'prepare-source.py', '--source', source], 'source-after', 600)
        if json.loads(Path(checked['stdout']['path']).read_text()) != report['gccSource']:
            raise RuntimeError('GCC source changed during TLS runtime build')
        report['inputs'] = [{'path': name, **value} for name, value in sorted(frozen.items())]
        report['inputsUnchanged'] = all(identity(name) == value for name, value in frozen.items())
        if not report['inputsUnchanged']:
            raise RuntimeError('TLS runtime build inputs changed')
        report['status'] = 'built-unverified'
        save()
    except Exception as error:
        report.update(status='failed', error=str(error))
        save()
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['work', 'sdk', 'sdk-archive', 'gcc-source', 'sysroot', 'gcc-cxx-sysroot', 'tls-libc', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    build(*(getattr(args, name).resolve() for name in
            ['work', 'sdk', 'sdk_archive', 'gcc_source', 'sysroot', 'gcc_cxx_sysroot', 'tls_libc', 'output']))
