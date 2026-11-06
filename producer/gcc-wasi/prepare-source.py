#!/usr/bin/env python3
"""Apply/verify locked patches without changing the source Git index or objects."""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent


def prepare(source, apply=False, component='gcc'):
    lock = json.loads((HERE / 'sources.lock.json').read_text())[component]
    label = component.upper()
    read_env = dict(os.environ, GIT_OPTIONAL_LOCKS='0')

    def git(*args, env=None, input=None):
        return subprocess.check_output(
            ['git', '-C', str(source), *args],
            env=read_env if env is None else env, input=input)

    if git('rev-parse', 'HEAD').decode().strip() != lock['commit']:
        raise RuntimeError(f'{label} source revision differs from the lock')
    submodules = {}
    for name, revision in lock.get('submodules', {}).items():
        relative = pathlib.PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError(f'Unsafe {label} submodule path')
        entry = git('ls-tree', 'HEAD', '--', name).decode().split()
        if entry[:3] != ['160000', 'commit', revision]:
            raise RuntimeError(f'{label} submodule gitlink differs: {name}')
        child = source / relative
        if subprocess.check_output(['git', '-C', str(child), 'rev-parse',
                                    'HEAD'], env=read_env).decode().strip() != revision:
            raise RuntimeError(f'{label} submodule revision differs: {name}')
        if subprocess.check_output(['git', '-C', str(child), 'status',
                                    '--porcelain', '--untracked-files=all',
                                    '--ignored'], env=read_env):
            raise RuntimeError(f'{label} submodule contains modified inputs: {name}')
        submodules[name] = revision
    patches = []
    for patch in lock.get('patches', []):
        name = pathlib.PurePosixPath(patch['path'])
        if name.is_absolute() or '..' in name.parts:
            raise RuntimeError(f'Unsafe {label} patch path')
        data = (HERE / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != patch['sha256']:
            raise RuntimeError(f'{label} patch hash mismatch: {name}')
        patches.append(HERE / name)
    with tempfile.TemporaryDirectory(prefix='gcc-wasi-index-') as temp:
        temporary = pathlib.Path(temp)
        source_objects = pathlib.Path(git('rev-parse', '--git-path', 'objects').decode().strip())
        if not source_objects.is_absolute():
            source_objects = (source / source_objects).resolve()
        objects = temporary / 'objects'
        (objects / 'info').mkdir(parents=True)
        # A temporary index alone still lets apply --cached, add and write-tree
        # populate the real object database. Read existing objects through an
        # alternate and confine every new blob/tree to this invocation instead.
        (objects / 'info' / 'alternates').write_text(str(source_objects) + '\n')
        env = dict(read_env, GIT_INDEX_FILE=str(temporary / 'index'),
                   GIT_OBJECT_DIRECTORY=str(objects))
        git('read-tree', 'HEAD', env=env)
        prefixes = [b'']
        added_paths = set()
        for patch in patches:
            git('apply', '--cached', str(patch), env=env)
            prefixes.append(git('diff', '--cached', '--binary', '--no-ext-diff', 'HEAD', env=env))
            added_paths.update(filter(None, git(
                'diff', '--cached', '--name-only', '--diff-filter=A', '-z', 'HEAD',
                env=env).split(b'\0')))
        expected = prefixes[-1]
        # The ordered patch list and its aggregate pin must agree before an
        # incremental preparation can change any working-tree source file.
        if hashlib.sha256(expected).hexdigest() != lock.get('sourceDiffSha256'):
            raise RuntimeError(f'{label} combined patch diff differs from the lock')
        expected_tree = git('write-tree', env=env).decode().strip()

        def source_diff():
            # Enumerate against HEAD, independently of the real index: staged
            # additions must remain visible, and locked deletions may still be
            # present in an unpatched working tree.
            git('read-tree', 'HEAD', env=env)
            # GCC configure can consume ignored in-tree GMP/MPFR/MPC sources.
            # Ignore rules must not exempt any additional compilation inputs.
            untracked = set(filter(None, git(
                'ls-files', '--others', '-z', env=env).split(b'\0')))
            if untracked - added_paths:
                raise RuntimeError(f'{label} source contains untracked inputs')
            # Include precisely the new paths introduced by locked patches.
            # A normal working-tree diff omits untracked files such as a new
            # target .opt file. Hash the working files into a fresh temporary
            # index; copying the real index could reuse stale stat-cache data.
            git('add', '-u', '--', '.', env=env)
            for name in sorted(added_paths):
                path = source / os.fsdecode(name)
                if path.exists() or path.is_symlink():
                    git('add', '-f', '--', os.fsdecode(name), env=env)
            return git('diff', '--cached', '--binary', '--no-ext-diff', 'HEAD', env=env)

        actual = source_diff()
        if apply and actual != expected and actual in prefixes:
            # Reuse an incremental build only when its source is an exact prefix
            # of the newly locked patch set, including any added source files.
            # A single `git apply --check patch1 patch2` checks every patch
            # against the current working tree, so dependent patches fail on
            # a clean checkout. The temporary index has already verified the
            # ordered series. Apply its combined transition atomically instead.
            actual_tree = git('write-tree', env=env).decode().strip()
            transition = git('diff', '--binary', '--no-ext-diff',
                             actual_tree, expected_tree, env=env)
            git('apply', '--check', env=env, input=transition)
            git('apply', env=env, input=transition)
            actual = source_diff()
    if actual != expected:
        raise RuntimeError(f'{label} source differs from exactly the locked patch set')
    receipt = {
        f'{component}Commit': lock['commit'],
        'patches': lock.get('patches', []),
        'sourceDiffSha256': hashlib.sha256(actual).hexdigest(),
    }
    if component == 'wabt':
        receipt['submodules'] = submodules
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--component', choices=['gcc', 'wabt'], default='gcc')
    args = parser.parse_args()
    print(json.dumps(prepare(args.source.resolve(), args.apply, args.component), sort_keys=True))
