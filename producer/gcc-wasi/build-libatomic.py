#!/usr/bin/env python3
"""Build the locked GNU libatomic port without modifying the compiler sysroot."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SIZES = (1, 2, 4, 8, 16)
SIZED_OBJECTS = ('load', 'store', 'cas', 'exch', 'fadd', 'fsub', 'fand',
                 'fior', 'fxor', 'fnand', 'tas')
PLAIN_OBJECTS = ('gload', 'gstore', 'gcas', 'gexch', 'glfree', 'lock',
                 'init', 'fenv', 'fence', 'flag')
EXPECTED_MEMBERS = sorted([name + '.o' for name in PLAIN_OBJECTS] +
                          [f'{name}_{size}_.o' for size in SIZES for name in SIZED_OBJECTS])
EXTERNAL_FUNCTIONS = {'memcpy', 'memmove', 'memcmp', 'memset'}


def identity(path):
    data = Path(path).read_bytes()
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def runtime_specs(library):
    # read_specs clears the old name as part of %rename. An empty *cc1plus:
    # section at EOF can send its whitespace scanner beyond the input buffer.
    return f'''%rename cc1plus gcc_wasi_original_cc1plus

*startfile:
{library}/crt1-command.o

*lib:
-lm -lc

*libgcc:
{library}/libclang_rt.builtins-wasm32.a

*link:
%{{!o:-o a.out}} --fatal-warnings -L{library} -e _start

'''


def check_configuration(text, makefile):
    definitions = dict(re.findall(r'^#define ([A-Z][A-Z0-9_]*) ([0-9]+)[ \t]*$', text, re.M))
    # mode(word) is DImode in this GCC target even though pointers are 32 bits.
    # The port's lock word is explicitly U_4 and does not depend on UWORD.
    required = {'WORDSIZE': '8', **{f'HAVE_INT{size}': '1' for size in SIZES}}
    for operation in ('LDST', 'CAS', 'EXCHANGE', 'FETCH_ADD', 'FETCH_OP'):
        required.update({f'HAVE_ATOMIC_{operation}_{size}': '1' for size in SIZES[:-1]})
        required[f'HAVE_ATOMIC_{operation}_16'] = '0'
    # GNU test_and_set is a one-byte flag operation, even for the legacy
    # exported _16 name. It is not a native 128-bit atomic operation.
    required.update({f'HAVE_ATOMIC_TAS_{size}': '1' for size in SIZES})
    for name, expected in required.items():
        if definitions.get(name) != expected:
            raise RuntimeError(f'Unexpected GNU libatomic configure result: {name}={definitions.get(name)}')
    if definitions.get('HAVE_IFUNC') == '1':
        raise RuntimeError('Wasm libatomic must not use ELF IFUNC dispatch')
    flags = dict(re.findall(r'^(CFLAGS|XCFLAGS|config_path|SIZES) = (.*)$', makefile, re.M))
    if flags.get('config_path', '').split() != ['wasm']:
        raise RuntimeError('GNU libatomic did not select only the Wasm port')
    if flags.get('SIZES', '').split() != list(map(str, SIZES)):
        raise RuntimeError('GNU libatomic does not include all five sized ABIs')
    actual_flags = shlex.split(flags.get('CFLAGS', '') + ' ' + flags.get('XCFLAGS', ''))
    if '-matomics' not in actual_flags or '-mno-atomics' in actual_flags:
        raise RuntimeError('GNU libatomic must use native Wasm atomics')
    if '-fno-link-libatomic' not in actual_flags or '-pthread' in actual_flags:
        raise RuntimeError('GNU libatomic must not self-link or depend on pthread')
    return {'definitions': {key: definitions[key] for key in required}, 'flags': flags}


def decode_object(member, text):
    """Read actual WABT function indices and linking symbols, retaining aliases."""
    symbols = {}
    for name, index, flags in re.findall(
            r'^\s+- \d+: F <([^>]+)> func=(\d+) \[ ([^\]]+) \]', text, re.M):
        index = int(index)
        record = symbols.setdefault(index, {'imports': [], 'exports': []})
        if 'undefined' in flags.split():
            if not name.startswith('env.'):
                raise RuntimeError(f'Unexpected function import namespace: {member}: {name}')
            record['imports'].append(name[4:])
        elif 'binding=local' not in flags.split():
            record['exports'].append(name)
    functions, current = {}, None
    for line in text.splitlines():
        header = re.match(r'^\s*[a-f0-9]+ func\[(\d+)\](?: <([^>]+)>)?:', line)
        if header:
            index = int(header[1])
            current = {'id': f'{member}:{index}', 'index': index, 'name': header[2],
                       'exports': symbols.get(index, {}).get('exports', []),
                       'instructions': [], 'calls': []}
            functions[index] = current
            continue
        instruction = re.match(r'^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)(.*)$', line)
        if current is None or not instruction or instruction[1].startswith('local['):
            continue
        opcode, operands = instruction[1], instruction[2].strip()
        current['instructions'].append(opcode)
        if opcode in ('call_indirect', 'return_call_indirect', 'call_ref', 'return_call_ref'):
            raise RuntimeError(f'Unexpected indirect call in GNU libatomic: {member}')
        if opcode in ('call', 'return_call'):
            match = re.match(r'^(\d+)(?: <[^>]+>)?$', operands)
            if not match:
                raise RuntimeError(f'Cannot resolve library call: {member}: {line}')
            current['calls'].append(int(match[1]))
    for index, symbol in symbols.items():
        if symbol['exports'] and index not in functions:
            raise RuntimeError(f'Exported library function has no body: {member}: {index}')
    for function in functions.values():
        targets = []
        for index in function.pop('calls'):
            if index in functions:
                targets.append({'local': functions[index]['id']})
            else:
                imports = symbols.get(index, {}).get('imports', [])
                if len(imports) != 1:
                    raise RuntimeError(f'Unresolved library call index: {member}: {index}')
                targets.append({'import': imports[0]})
        function['targets'] = targets
    return {'member': member, 'functions': list(functions.values()),
            'imports': sorted({name for symbol in symbols.values() for name in symbol['imports']})}


def check_archive(objects, required_symbols):
    if sorted(item['member'] for item in objects) != EXPECTED_MEMBERS:
        raise RuntimeError('GNU libatomic archive member inventory differs')
    functions = {function['id']: function for item in objects for function in item['functions']}
    exports = {}
    for function in functions.values():
        for symbol in function['exports']:
            if symbol in exports:
                raise RuntimeError(f'Duplicate library definition: {symbol}')
            exports[symbol] = function['id']
    missing = sorted(set(required_symbols) - exports.keys())
    if missing:
        raise RuntimeError(f'GNU libatomic public ABI symbols are missing: {missing}')
    graph = {}
    for item in objects:
        for symbol in item['imports']:
            if symbol not in exports and symbol not in EXTERNAL_FUNCTIONS:
                raise RuntimeError(f'Unexpected GNU libatomic function import: {item["member"]}: {symbol}')
        for function in item['functions']:
            graph[function['id']] = [target.get('local') or exports.get(target.get('import'))
                                     for target in function['targets']
                                     if 'local' in target or target.get('import') in exports]
    visiting, finished = set(), set()

    def visit(node):
        if node in visiting:
            raise RuntimeError(f'Recursive GNU libatomic helper call: {node}')
        if node in finished:
            return
        visiting.add(node)
        for target in graph[node]:
            visit(target)
        visiting.remove(node)
        finished.add(node)

    for node in graph:
        visit(node)
    lock = next(item for item in objects if item['member'] == 'lock.o')
    if lock['imports']:
        raise RuntimeError('Lock primitives must not import helper functions')
    opcodes = {opcode for fn in lock['functions'] for opcode in fn['instructions']}
    required = {'i32.atomic.load', 'i32.atomic.store', 'i32.atomic.rmw.cmpxchg'}
    if not required <= opcodes:
        raise RuntimeError(f'Lock primitive native instructions are missing: {sorted(required - opcodes)}')
    for item in objects:
        if re.fullmatch(r'(?:load|store|cas|exch|fadd|fsub|fand|fior|fxor|fnand)_[1248]_\.o', item['member']):
            if any(symbol.startswith(('__atomic_', 'libat_')) for symbol in item['imports']):
                raise RuntimeError(f'Native-width helper calls libatomic again: {item["member"]}')
    return {'publicSymbols': sorted(set(required_symbols)), 'definedFunctions': len(functions),
            'callGraph': graph, 'recursiveCalls': False,
            'lockInstructions': sorted(opcodes), 'externalFunctions': sorted(
                {name for item in objects for name in item['imports']} - exports.keys())}


def build(work, sdk, sysroot, output, jobs=2):
    if jobs < 1:
        raise ValueError('jobs must be positive')
    source, compiler, wabt = work / 'gcc', work / 'gcc-native/gcc', work / 'wabt-native'
    if any(output == root or root in output.parents for root in [source, compiler, sysroot, sdk]):
        raise ValueError('libatomic output must be separate from source, compiler, SDK and imported sysroot')
    output.mkdir(parents=True, exist_ok=False)
    configuration, driver, members, logs = [output / name for name in
                                           ['configuration', 'driver', 'members', 'logs']]
    for directory in [configuration, driver, members, logs, output / 'tmp']:
        directory.mkdir()
    environment = dict(os.environ, LC_ALL='C', TMPDIR=str(output / 'tmp'),
                       TMP=str(output / 'tmp'), TEMP=str(output / 'tmp'), CONFIG_SITE=os.devnull)
    for name in ['CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'LIBS', 'CC', 'CXX',
                 'GCC_EXEC_PREFIX', 'COMPILER_PATH', 'LIBRARY_PATH', 'CPATH',
                 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH']:
        environment.pop(name, None)
    frozen = {}
    report = {'schemaVersion': 1, 'kind': 'gcc-wasi-libatomic-build', 'status': 'running',
              'target': 'wasm32-wasi', 'commands': [], 'objects': []}

    def save():
        (output / 'build.json').write_text(json.dumps(report, indent=2) + '\n')

    def freeze(path):
        path = Path(path).resolve()
        current = identity(path)
        if str(path) in frozen and frozen[str(path)] != current:
            raise RuntimeError(f'Changed libatomic input: {path}')
        frozen[str(path)] = current
        return {'path': str(path), **current}

    def record(path):
        return {'path': str(Path(path).resolve()), **identity(path)}

    def run(command, argv, cwd=output, extra_env=None, timeout=180):
        command, argv = str(command), list(map(str, argv))
        ordinal = len(report['commands'])
        stdout, stderr = [logs / f'{ordinal:03d}.{suffix}' for suffix in ['stdout', 'stderr']]
        receipt = {'command': command, 'argv': argv, 'cwd': str(cwd),
                   'environment': extra_env or {}, 'timeoutSeconds': timeout}
        report['commands'].append(receipt)
        with stdout.open('wb') as out, stderr.open('wb') as err:
            try:
                result = subprocess.run([command, *argv], cwd=cwd,
                                        env={**environment, **(extra_env or {})},
                                        stdout=out, stderr=err, timeout=timeout)
                receipt['status'] = result.returncode
            except (OSError, subprocess.TimeoutExpired) as error:
                receipt.update(status=None, error=str(error))
        receipt.update(stdout=record(stdout), stderr=record(stderr))
        save()
        if receipt.get('status') != 0:
            raise RuntimeError(f'libatomic command failed: {command}; status={receipt.get("status")}; '
                               f'error={receipt.get("error")}; logs={stdout}, {stderr}')
        return receipt

    try:
        report['recipes'] = {name: freeze(HERE / name) for name in
                             ['build-libatomic.py', 'prepare-source.py']}
        report['sourceLock'] = freeze(HERE / 'sources.lock.json')
        report['runtimeLock'] = freeze(HERE / 'runtime.lock.json')
        lock = json.loads((HERE / 'sources.lock.json').read_text())
        for patch in lock['gcc']['patches']:
            if freeze(HERE / patch['path'])['sha256'] != patch['sha256']:
                raise RuntimeError('GCC patch differs from the lock')
        source_check = run(sys.executable, [HERE / 'prepare-source.py', '--source', source], timeout=600)
        report['gccSource'] = json.loads(Path(source_check['stdout']['path']).read_text())
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
            'objdump': wabt / 'wasm-objdump', 'ar': sdk / 'bin/llvm-ar',
            'nm': sdk / 'bin/llvm-nm', 'ranlib': sdk / 'bin/llvm-ranlib',
            'linker': sdk / 'bin/wasm-ld', 'make': shutil.which('make'),
            'python': sys.executable, 'shell': '/bin/bash'}.items()}
        report['runtimeImport'] = freeze(sysroot.parent / 'runtime-build.json')
        imported = json.loads((sysroot.parent / 'runtime-build.json').read_text())
        if imported['runtimeLock'] != identity(HERE / 'runtime.lock.json'):
            raise RuntimeError('Target sysroot uses another runtime lock')
        for item in imported['files']:
            if freeze(sysroot / item['path']) != {
                    'path': str((sysroot / item['path']).resolve()),
                    **{key: item[key] for key in ['bytes', 'sha256']}}:
                raise RuntimeError(f'Target sysroot import changed: {item["path"]}')
        # GCC's public headers and real GNU sources are inputs too. The source
        # checker independently excludes extra files throughout the GCC tree.
        report['resourceHeaders'] = [freeze(path) for path in sorted((compiler / 'include').rglob('*')) if path.is_file()]
        report['librarySources'] = [freeze(path) for path in sorted((source / 'libatomic').rglob('*')) if path.is_file()]
        report['configureSupport'] = [freeze(path) for path in sorted(source.glob('*'))
                                      if path.is_file() and (path.suffix == '.m4' or path.name in {
                                          'config.guess', 'config.sub', 'config-ml.in', 'ltmain.sh',
                                          'libtool-ldflags', 'missing', 'install-sh', 'depcomp',
                                          'compile', 'mkinstalldirs', 'move-if-change'})]
        report['configureSupport'] += [freeze(path) for path in sorted((source / 'config').rglob('*')) if path.is_file()]
        report['configureSupport'] += [freeze(source / 'gcc/BASE-VER')]
        library = sysroot / 'lib/wasm32-wasi'
        builtins = library / 'libclang_rt.builtins-wasm32.a'
        report['runtimeLibraries'] = {name: freeze(library / name) for name in
                                     ['crt1-command.o', 'libc.a', 'libm.a', builtins.name]}
        specs = driver / 'runtime.specs'
        specs.write_text(runtime_specs(library))
        for name, command in {
            'gcc': [compiler / 'xgcc', '-B' + str(driver) + '/', '-B' + str(compiler) + '/',
                    '-specs=' + str(specs), '--sysroot=' + str(sysroot),
                    '-D__GCC_WASI_SINGLE_THREAD__=1', '-isystem', sysroot / 'include/wasm32-wasi'],
            'as': [wabt / 'wat2wasm'], 'ld': [sdk / 'bin/wasm-ld'],
            'collect-ld': [sdk / 'bin/wasm-ld'], 'nm': [sdk / 'bin/llvm-nm']}.items():
            wrapper = driver / name
            wrapper.write_text('#!/usr/bin/env bash\nset -euo pipefail\nexec '
                               + shlex.join(map(str, command)) + ' "$@"\n')
            wrapper.chmod(0o755)
        report['driver'] = [freeze(path) for path in sorted(driver.iterdir())]
        triple = Path(run(source / 'config.guess', [])['stdout']['path']).read_text().strip()
        run(source / 'libatomic/configure', ['--build=' + triple, '--host=wasm32-wasi',
            '--target=wasm32-wasi', '--disable-shared', '--enable-static', '--disable-multilib',
            '--disable-maintainer-mode', '--disable-symvers', '--disable-generated-files-in-srcdir',
            '--prefix=' + str(output / 'install')], cwd=configuration,
            extra_env={'CC': str(driver / 'gcc'), 'CFLAGS': '-O2 -g0 -save-temps=obj',
                       'AR': str(sdk / 'bin/llvm-ar'), 'RANLIB': str(sdk / 'bin/llvm-ranlib'),
                       'NM': str(sdk / 'bin/llvm-nm'), 'AS': str(driver / 'as'),
                       'LD': str(driver / 'ld'), 'MAKEINFO': 'true'}, timeout=600)
        report['configurationChecks'] = check_configuration(
            (configuration / 'auto-config.h').read_text(), (configuration / 'Makefile').read_text())
        # all/all-local/install would copy into the compiler build directory.
        run(report['tools']['make']['path'], [f'-j{jobs}', 'libatomic.la', 'MAKEINFO=true'],
            cwd=configuration, timeout=1800)
        report['configuration'] = {name: freeze(configuration / name) for name in
                                   ['auto-config.h', 'gstdint.h', 'Makefile', 'config.status', 'libtool', 'config.log']}
        archive = configuration / '.libs/libatomic.a'
        list_command = run(sdk / 'bin/llvm-ar', ['t', archive])
        member_names = Path(list_command['stdout']['path']).read_text().splitlines()
        if sorted(member_names) != EXPECTED_MEMBERS:
            raise RuntimeError(f'Unexpected archive members: {member_names}')
        decoded = []
        for member in member_names:
            extracted = run(sdk / 'bin/llvm-ar', ['p', archive, member])
            obj = members / member
            shutil.copyfile(extracted['stdout']['path'], obj)
            valid = run(wabt / 'wasm-validate', ['--enable-threads', obj])
            disassembly = run(wabt / 'wasm-objdump', ['-x', '-d', obj])
            symbols = run(sdk / 'bin/llvm-nm', ['--format=posix', obj])
            detail = decode_object(member, Path(disassembly['stdout']['path']).read_text())
            decoded.append(detail)
            assembly_candidates = [path for path in
                [configuration / Path(member).with_suffix('.s'),
                 configuration / '.libs' / Path(member).with_suffix('.s')] if path.is_file()]
            if len(assembly_candidates) != 1:
                raise RuntimeError(f'Expected one retained GCC assembly for {member}: {assembly_candidates}')
            report['objects'].append({'member': member, 'object': record(obj),
                                      'assembly': record(assembly_candidates[0]),
                                      'disassembly': disassembly['stdout'], 'symbols': symbols['stdout'],
                                      'validateCommand': report['commands'].index(valid),
                                      'inspection': detail})
        public = re.findall(r'^\s*((?:__atomic_|atomic_)[A-Za-z0-9_]+);$',
                            (source / 'libatomic/libatomic.map').read_text(), re.M)
        report['archiveInspection'] = check_archive(decoded, public)
        installed = output / 'sysroot/lib/wasm32-wasi/libatomic.a'
        installed.parent.mkdir(parents=True)
        shutil.copyfile(archive, installed)
        report['library'] = record(installed)
        report['files'] = [{'path': 'lib/wasm32-wasi/libatomic.a', **identity(installed)}]
        report['licenses'] = []
        for name in ['COPYING3', 'COPYING.RUNTIME']:
            origin, destination = source / name, output / 'licenses' / name
            destination.parent.mkdir(exist_ok=True)
            shutil.copyfile(origin, destination)
            report['licenses'].append({'source': freeze(origin), 'installed': record(destination)})
        report['profile'] = {'implementation': 'pinned-gnu-libatomic', 'atomics': True,
            'lockFreeSizes': [1, 2, 4, 8], 'lockFreeAlignment': 'natural',
            'lockFree16': False, 'sizedHelperAlignment': 'natural',
            'genericRuntimeUnalignedFallback': True, 'genericBuiltinMaySpecialize': True,
            'locks': {'slots': 64, 'watchBytes': 64, 'slotBytes': 64,
                      'acquisition': 'unique-slots-ascending', 'release': 'descending',
                      'sharedBss': True, 'startup': 'single-shared-initialization'},
            'pthread': False, 'tls': False, 'sharedRuntimeQualified': False}
        source_after = run(sys.executable, [HERE / 'prepare-source.py', '--source', source], timeout=600)
        if json.loads(Path(source_after['stdout']['path']).read_text()) != report['gccSource']:
            raise RuntimeError('GCC source changed during GNU libatomic build')
        report['inputs'] = [{'path': name, **value} for name, value in sorted(frozen.items())]
        report['inputsUnchanged'] = all(identity(name) == expected for name, expected in frozen.items())
        if not report['inputsUnchanged']:
            raise RuntimeError('GNU libatomic build inputs changed')
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
    parser.add_argument('--jobs', type=int, default=2)
    args = parser.parse_args()
    paths = [getattr(args, name).resolve() for name in ['work', 'sdk', 'sysroot', 'output']]
    if any(any(character.isspace() for character in str(path)) for path in paths):
        parser.error('GCC specs require whitespace-free build paths')
    build(*paths, jobs=args.jobs)
