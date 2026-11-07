#!/usr/bin/env python3
"""Bind the GNU runtime's embedded timezone data and single-thread cache port."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent


def identity(file):
    file = Path(file)
    with file.open('rb') as stream:
        return {'bytes': file.stat().st_size,
                'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def pinned(source):
    lock_file = HERE / 'tzdb.lock.json'
    lock = json.loads(lock_file.read_text())
    assert lock['schemaVersion'] == 1
    assert lock['kind'] == 'gnu-libstdcxx-static-timezone-database'
    assert lock['gccCommit'] == json.loads((HERE / 'sources.lock.json').read_text())['gcc']['commit']
    expected_paths = {'source': 'libstdc++-v3/src/c++20/tzdb.cc',
                      'data': 'libstdc++-v3/src/c++20/tzdata.zi',
                      'patch': 'patches/libstdcxx-wasi-tzdb-cache.patch'}
    for key, relative in expected_paths.items():
        assert lock[key]['path'] == relative
        actual = (HERE if key == 'patch' else source) / relative
        assert identity(actual) == {field: lock[key][field] for field in ['bytes', 'sha256']}, key
    data = (source / lock['data']['path']).read_text()
    assert data.startswith('# version ' + lock['version'] + '\n')
    assert lock['data']['license'] == 'public-domain'
    assert lock['data']['licenseNotice'] in data.splitlines()[2]
    assert lock['distribution']['mode'] == 'embedded'
    assert lock['distribution']['requiredGuestFiles'] == []
    assert lock['distribution']['automaticNetworkUpdates'] is False
    return lock, {'lock': identity(lock_file), 'recipe': identity(Path(__file__)),
                  **{key: {field: lock[key][field] for field in ['bytes', 'sha256']}
                     for key in expected_paths},
                  'version': lock['version'], 'embedded': True, 'singleThread': True}


def verify_private_object(inspected):
    instructions = re.findall(r'\|\s+([A-Za-z0-9_.]+)(?:\s|$)', inspected, re.M)
    assert not any('.atomic.' in opcode or opcode == 'atomic.fence' for opcode in instructions), \
        'Private GNU tzdb contains atomic instructions'
    # GNU also has ordinary, mangled __gnu_cxx::__atomic_add functions.
    # Match actual unresolved C ABI helpers, not that name inside C++ symbols.
    atomic_helpers = [line.strip() for line in inspected.splitlines()
                      if ('undefined' in line and re.search(r'<__atomic_[^>]+>', line))
                      or re.search(r' <- [^\s]+\.__atomic_\w+(?:\s|$)', line)]
    assert not atomic_helpers, 'Private GNU tzdb has unresolved atomic runtime helpers: ' + repr(atomic_helpers)
    assert not re.search(r'^\s*- \[\+\] atomics\s*$', inspected, re.M), \
        'Private GNU tzdb advertises atomics'


def inspect(source, runtime, work, sdk):
    lock, result = pinned(source)
    assert result == json.loads((runtime / 'tzdb-inputs.json').read_text()), 'Timezone inputs changed during build'
    copied_source = runtime / 'source' / lock['source']['path']
    copied_data = runtime / 'source' / lock['data']['path']
    assert identity(copied_data) == result['data']
    # Reapply the actual patch independently, so a matching input pin cannot
    # hide a changed runtime source copy.
    with tempfile.TemporaryDirectory(prefix='gnu-tzdb-source-') as temporary:
        root = Path(temporary)
        expected = root / lock['source']['path']
        expected.parent.mkdir(parents=True)
        expected.write_bytes((source / lock['source']['path']).read_bytes())
        subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(HERE / lock['patch']['path'])],
                       cwd=root, check=True, capture_output=True)
        assert expected.read_bytes() == copied_source.read_bytes(), 'GNU tzdb source differs from the pinned port'
    header = runtime / 'install/include/c++/17.0.0/wasm32-wasi/bits/c++config.h'
    config = header.read_text()
    assert '#define _GLIBCXX_STATIC_TZDATA 1' in config
    assert not re.search(r'^#define _GLIBCXX_(HAS_GTHREADS|ZONEINFO_DIR)\b', config, re.M)
    object_file = runtime / 'build/src/c++20/tzdb.o'
    object_bytes = object_file.read_bytes()
    data_bytes = copied_data.read_bytes()
    assert object_bytes.count(data_bytes) == 1, 'GNU object lacks the complete pinned embedded tzdata bytes'
    archive = runtime / 'install/lib/libstdc++.a'
    ar = sdk / 'bin/llvm-ar'
    members = subprocess.check_output([str(ar), 't', str(archive)], text=True).splitlines()
    assert members.count('tzdb.o') == 1, 'GNU archive must contain exactly one real tzdb object'
    archived = subprocess.check_output([str(ar), 'p', str(archive), 'tzdb.o'])
    assert archived == object_bytes, 'Installed archive contains a different tzdb object'
    inspector = work / 'wabt-native/wasm-objdump'
    inspected = subprocess.check_output([str(inspector), '-x', '-d', '-r', str(object_file)], text=True)
    inspection = runtime / 'tzdb-object-inspection.txt'
    if inspection.exists():
        assert inspection.read_text() == inspected, 'Retained tzdb object inspection changed'
    else:
        with inspection.open('x') as stream:
            stream.write(inspected)
    verify_private_object(inspected)
    makefile = runtime / 'build/src/c++20/Makefile'
    result.update(patchedSource=identity(copied_source), configurationHeader=identity(header),
                  object=identity(object_file), archiveMember='tzdb.o', archive=identity(archive),
                  embeddedDataOffset=object_bytes.index(data_bytes), atomicInstructions=0,
                  atomicHelpers=[], inspection=identity(inspection), makefile=identity(makefile),
                  tools={'ar': identity(ar), 'inspector': identity(inspector)})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['pin', 'inspect'])
    parser.add_argument('--source', type=Path, required=True)
    for name in ['runtime', 'work', 'sdk']:
        parser.add_argument('--' + name, type=Path)
    args = parser.parse_args()
    if args.mode == 'pin':
        value = pinned(args.source)[1]
    else:
        if any(getattr(args, name) is None for name in ['runtime', 'work', 'sdk']):
            parser.error('inspect requires --runtime, --work and --sdk')
        value = inspect(args.source, args.runtime, args.work, args.sdk)
    print(json.dumps(value, indent=2))


if __name__ == '__main__':
    main()
