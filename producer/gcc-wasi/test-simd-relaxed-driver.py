#!/usr/bin/env python3
"""Exercise real xgcc option forwarding, header preprocessing and Wasm objects."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time


def identity(file):
    with file.open('rb') as stream:
        return {'bytes': file.stat().st_size,
                'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def target_features(file):
    data = file.read_bytes()
    assert data[:8] == b'\0asm\1\0\0\0', 'Not a Wasm object'
    offset = 8

    def uleb(end):
        nonlocal offset
        value = shift = 0
        while offset < end and shift < 35:
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
            shift += 7
        raise AssertionError('Invalid unsigned LEB128')

    def name(end):
        nonlocal offset
        size = uleb(end)
        assert offset + size <= end
        result = data[offset:offset + size].decode('utf-8')
        offset += size
        return result

    found = None
    while offset < len(data):
        kind = data[offset]
        offset += 1
        size = uleb(len(data))
        end = offset + size
        assert end <= len(data)
        if kind == 0 and name(end) == 'target_features':
            assert found is None, 'Duplicate target_features'
            found = {}
            for _ in range(uleb(end)):
                assert offset < end
                prefix = chr(data[offset])
                offset += 1
                feature = name(end)
                assert prefix in '+-' and feature not in found
                found[feature] = prefix
            assert offset == end
        offset = end
    return found or {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['work', 'sysroot', 'output']:
        parser.add_argument('--' + key, type=Path, required=True)
    args = parser.parse_args()
    work, sysroot, output = [getattr(args, name).resolve() for name in ['work', 'sysroot', 'output']]
    output.mkdir(parents=True, exist_ok=False)
    compiler = work / 'gcc-native/gcc'
    assembler = work / 'wabt-native/wat2wasm'
    (output / 'as').symlink_to(assembler)
    (output / 'tmp').mkdir(mode=0o700)
    # Native builds intentionally clear the draft target's unsupported libc++ driver option.
    specs = work / 'native-driver.specs'
    paths = [Path(__file__).resolve(), work / 'native-build.json', specs, assembler,
             compiler / 'xgcc', compiler / 'cc1', compiler / 'cc1plus',
             compiler / 'include/wasm_simd128.h', compiler / 'include/wasm_relaxed_simd.h']
    frozen = {str(file): identity(file) for file in paths}
    report = {'kind': 'gcc-wasi-relaxed-simd-driver-qualification', 'status': 'running',
              'startedUnix': time.time(), 'inputs': frozen, 'cases': []}
    profiles = [
        ('enabled', ['-msimd128', '-mrelaxed-simd'], True, True),
        ('disable-then-enable', ['-msimd128', '-mno-relaxed-simd', '-mrelaxed-simd'], True, True),
        ('enable-then-disable', ['-msimd128', '-mrelaxed-simd', '-mno-relaxed-simd'], False, True),
        ('simd-only', ['-msimd128'], False, True),
        ('default', [], False, True),
        ('missing-simd', ['-mrelaxed-simd'], True, False),
        ('disable-simd-last', ['-msimd128', '-mrelaxed-simd', '-mno-simd128'], True, False),
    ]
    enabled = ('#include <wasm_relaxed_simd.h>\n'
               '#ifndef __wasm_relaxed_simd__\n#error missing relaxed macro\n#endif\n'
               'v128_t probe(v128_t a, v128_t b) { return wasm_i8x16_relaxed_swizzle(a, b); }\n')
    disabled = ('#ifdef __wasm_relaxed_simd__\n#error unexpected relaxed macro\n#endif\n'
                'int probe(int value) { return value + 1; }\n')
    try:
        for language in ['c', 'c++']:
            for optimization in ['0', '2']:
                for profile, flags, relaxed, success in profiles:
                    name = f'{profile}-{language.replace("+", "p")}-o{optimization}'
                    source = output / (name + ('.cc' if language == 'c++' else '.c'))
                    source.write_text(enabled if relaxed else disabled)
                    obj = output / (name + '.o')
                    command = [str(compiler / 'xgcc'), '-B' + str(output) + '/',
                               '-B' + str(compiler) + '/', '-specs=' + str(specs),
                               '-O' + optimization, '-x', language, '-v', '-nostdinc',
                               '-isystem', str(compiler / 'include'), '-isystem',
                               str(sysroot / 'include/wasm32-wasi'), *flags,
                               '-c', str(source), '-o', str(obj)]
                    result = subprocess.run(command, cwd=output, text=True, capture_output=True,
                                            timeout=60, env={**os.environ, 'LC_ALL': 'C',
                                                            'TMPDIR': str(output / 'tmp')})
                    entry = {'id': name, 'command': command, 'exitCode': result.returncode,
                             'stdout': result.stdout, 'stderr': result.stderr,
                             'source': identity(source)}
                    report['cases'].append(entry)
                    assert (result.returncode == 0) == success, name + ': ' + result.stderr
                    invocations = []
                    for line in result.stderr.splitlines():
                        if line.strip().startswith(str(output / 'as') + ' '):
                            invocations.append(shlex.split(line.strip()))
                    if success:
                        assert len(invocations) == 1, name + ': assembler invocation missing'
                        argv = invocations[0]
                        assert argv.count('--enable-relaxed-simd') == int(relaxed), name + ': wrong feature forwarding'
                        features = target_features(obj)
                        assert (features.get('relaxed-simd') == '+') == relaxed, name + ': wrong object features'
                        if relaxed:
                            assert features.get('simd128') == '+'
                        entry.update(assemblerArgv=argv, targetFeatures=features, object=identity(obj))
                    else:
                        assert not obj.exists() and not invocations, name + ': invalid dependency reached assembler'
                        assert 'requires' in result.stderr and '-msimd128' in result.stderr
                    entry['status'] = 'passed'
        for file, expected in frozen.items():
            assert identity(Path(file)) == expected, 'Changed input: ' + file
        report.update(status='passed', inputsUnchanged=True,
                      counts={'cases': 28, 'objectEmissions': 20, 'rejections': 8})
    except Exception as error:
        report.update(status='failed', error=str(error))
    finally:
        report['finishedUnix'] = time.time()
        (output / 'qualification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['status', 'counts', 'error'] if key in report}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
