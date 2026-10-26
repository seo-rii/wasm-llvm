#!/usr/bin/env python3
"""Apply/verify exactly the locked GCC patches without changing its real index."""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent


def prepare(source, apply=False):
    lock = json.loads((HERE / 'sources.lock.json').read_text())['gcc']

    def git(*args, env=None):
        return subprocess.check_output(['git', '-C', str(source), *args], env=env)

    if git('rev-parse', 'HEAD').decode().strip() != lock['commit']:
        raise RuntimeError('GCC source revision differs from the lock')
    if git('ls-files', '--others', '--exclude-standard').strip():
        raise RuntimeError('GCC source contains untracked inputs')
    patches = []
    for patch in lock.get('patches', []):
        name = pathlib.PurePosixPath(patch['path'])
        if name.is_absolute() or '..' in name.parts:
            raise RuntimeError('Unsafe GCC patch path')
        data = (HERE / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != patch['sha256']:
            raise RuntimeError(f'GCC patch hash mismatch: {name}')
        patches.append(HERE / name)
    with tempfile.TemporaryDirectory(prefix='gcc-wasi-index-') as temp:
        env = dict(os.environ, GIT_INDEX_FILE=str(pathlib.Path(temp) / 'index'))
        git('read-tree', 'HEAD', env=env)
        prefixes = [b'']
        for patch in patches:
            git('apply', '--cached', str(patch), env=env)
            prefixes.append(git('diff', '--cached', '--binary', '--no-ext-diff', 'HEAD', env=env))
        expected = prefixes[-1]
    actual = git('diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.')
    if apply and actual != expected and actual in prefixes:
        # Reuse an incremental build only when its source is an exact prefix of
        # the newly locked patch set. Never apply over unrelated local changes.
        remaining = patches[prefixes.index(actual):]
        git('apply', '--check', *map(str, remaining))
        git('apply', *map(str, remaining))
        actual = git('diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.')
    if actual != expected:
        raise RuntimeError('GCC source differs from exactly the locked patch set')
    return {
        'gccCommit': lock['commit'],
        'patches': lock.get('patches', []),
        'sourceDiffSha256': hashlib.sha256(actual).hexdigest(),
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(prepare(args.source.resolve(), args.apply), sort_keys=True))
