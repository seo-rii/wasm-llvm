#!/usr/bin/env python3
"""Freeze the actual input closure of the isolated full GNU EH build."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent


def identity(file):
    file = Path(file)
    with file.open('rb') as stream:
        return {'bytes': file.stat().st_size,
                'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def collect(work, sdk):
    files = {Path(__file__).resolve()}
    for name in ['build-libstdcxx.sh', 'fp-extension-math-probe.py', 'prepare-source.py',
                 'sources.lock.json', 'runtime.lock.json', 'patches/libstdcxx-wasi-config.patch',
                 'patches/libstdcxx-wasi-eh-config.patch', 'patches/wasi-libc-errno.patch']:
        files.add(HERE / name)
    source_lock = json.loads((HERE / 'sources.lock.json').read_text())
    files.update(HERE / patch['path'] for project in ['gcc', 'wabt']
                 for patch in source_lock[project]['patches'])
    runtime_lock = json.loads((HERE / 'runtime.lock.json').read_text())
    files.add(HERE / runtime_lock['exceptionHandling']['license']['path'])
    source = work / 'gcc'
    for directory in ['libstdc++-v3', 'config', 'include', 'libgcc', 'libiberty', 'libbacktrace']:
        files.update(file for file in (source / directory).rglob('*') if file.is_file())
    files.update(source.glob('*.m4'))
    for name in ['contrib/relpath.sh', 'config.guess', 'config.sub', 'config-ml.in', 'ltmain.sh',
                 'libtool-ldflags', 'missing', 'install-sh', 'depcomp', 'compile', 'mkinstalldirs',
                 'move-if-change', 'COPYING', 'COPYING3', 'COPYING.RUNTIME',
                 'gcc/BASE-VER', 'gcc/DATESTAMP', 'gcc/DEV-PHASE']:
        if (source / name).is_file():
            files.add(source / name)
    for name in ['native-build.json', 'native-driver.specs']:
        files.add(work / name)
    for name in ['cc1', 'cc1plus', 'xgcc']:
        files.add(work / 'gcc-native/gcc' / name)
    for directory in [work / 'gcc-native/gcc/include', work / 'libstdcxx-eh-tools/install',
                      sdk / 'share/wasi-sysroot/include/wasm32-wasi']:
        files.update(file for file in directory.rglob('*') if file.is_file())
    files.add(work / 'libstdcxx-eh-tools/autoconf-2.69.tar.xz')
    for name in ['wat2wasm', 'wasm-objdump']:
        files.add(work / 'wabt-native' / name)
    for name in ['llvm-ar', 'llvm-ranlib', 'llvm-nm', 'wasm-ld']:
        files.add(sdk / 'bin' / name)
    files.update(file for file in (sdk / 'share/wasi-sysroot/lib/wasm32-wasi').glob('*') if file.is_file())
    files.add(sdk / 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a')
    files.add(sdk / runtime_lock['exceptionHandling']['unwinder']['sdkRelativePath'])
    for name in ['bash', 'make', 'python3', 'perl', 'm4', 'patch']:
        command = shutil.which(name)
        if not command:
            raise RuntimeError('Missing GNU build tool ' + name)
        files.add(Path(command).resolve())
    return [{'path': str(file), **identity(file)} for file in sorted(files)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['snapshot', 'verify'])
    for name in ['work', 'sdk', 'runtime']:
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    work, sdk, runtime = (getattr(args, name).resolve() for name in ['work', 'sdk', 'runtime'])
    current = collect(work, sdk)
    snapshot = runtime / 'eh-build-inputs.json'
    if args.mode == 'snapshot':
        if snapshot.exists():
            if json.loads(snapshot.read_text())['inputs'] != current:
                raise RuntimeError('EH inputs changed; choose a fresh runtime directory')
        else:
            snapshot.write_text(json.dumps({'schemaVersion': 1, 'inputs': current}, indent=2) + '\n')
    else:
        previous = json.loads(snapshot.read_text())['inputs']
        if previous != current:
            expected = {x['path']: x for x in previous}
            actual = {x['path']: x for x in current}
            changed = [name for name in sorted(expected.keys() | actual.keys())
                       if expected.get(name) != actual.get(name)]
            raise RuntimeError('Full GNU EH build inputs changed: ' + repr(changed[:20]))
        receipt = {'schemaVersion': 1, 'status': 'passed', 'inputsUnchanged': True,
                   'snapshot': {'path': str(snapshot), **identity(snapshot)}, 'count': len(current)}
        (runtime / 'eh-build-input-check.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'mode': args.mode, 'inputs': len(current), 'status': 'passed'}))


if __name__ == '__main__':
    main()
