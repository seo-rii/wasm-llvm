#!/usr/bin/env python3
"""Reconstruct pinned LLVM source identities without compiling or changing its checkout.

Read existing immutable Git objects through an alternate object store. A new private
bare repository and index receive the five patches and explicit WASI signal stub.
No pre-existing repository, object store or index is modified.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess

QUALIFICATION = 'ff18b37c934f7526885f5a49d77698712615f23a'
EXPECTED_TREE = '18386f7effc475e5e41f103bfd0ca83bd07fa068'
EXPECTED_DIFF = '3b567858e77542dc30f8aeffb51a83a7d7ea951cabf8e163105f15a7aa9c8b1b'
MANIFEST_SHA = 'de99e0be692a813c854edf8f42606f35226c285b567b246c617a1cecc74c62d9'
HERE = Path(__file__).resolve().parent
DEFAULT_SOURCE = HERE.parents[2]


def sha(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--seed-git', type=Path,
                        default=HERE.parent / 'clang-input-verification-ff18b37.git')
    parser.add_argument('--output', type=Path, default=HERE / 'expected-clang-inputs.json')
    parser.add_argument('--scratch', type=Path, default=HERE / 'reconstruction.git')
    args = parser.parse_args()
    os.umask(0o077)
    source = args.source.resolve()
    producer = source / 'producer/clang-browser'
    manifest_bytes = (producer / 'manifest.json').read_bytes()
    assert sha(manifest_bytes) == MANIFEST_SHA, 'Producer manifest changed'
    manifest = json.loads(manifest_bytes)
    assert not args.output.exists() and not args.scratch.exists(), 'Use new output and scratch paths'
    subprocess.run(['git', 'init', '--bare', str(args.scratch)], check=True, capture_output=True)
    (args.scratch / 'objects/info/alternates').write_text(str(args.seed_git.resolve() / 'objects') + '\n')
    env = {**os.environ, 'GIT_INDEX_FILE': str(args.scratch.resolve() / 'qualification.index')}

    def git(*arguments, data=None):
        return subprocess.check_output(['git', '--git-dir=' + str(args.scratch), *arguments],
                                       input=data, env=env, stderr=subprocess.PIPE)

    commit = manifest['sources']['llvm']['commit']
    patch_source = manifest['sources']['wasiHostPatch']
    patch_commit = patch_source['commit']
    for revision in [commit, patch_commit, patch_commit + '^']:
        assert git('cat-file', '-t', revision).strip() == b'commit'
    yowasp_patch = git('diff', '--binary', '--full-index', patch_commit + '^', patch_commit)
    patches = [{**patch_source, 'sha256': sha(yowasp_patch)}]
    git('read-tree', commit)
    git('apply', '--cached', '--3way', '-', data=yowasp_patch)
    for name in ['llvmWasiClosePatch', 'lldWasmOnlyPatch', 'clangdEmscriptenStdinPatch',
                 'wasmFunctionEndPatch']:
        spec = manifest['sources'][name]
        data = (producer / spec['path']).read_bytes()
        assert sha(data) == spec['sha256'], 'Local patch digest mismatch: ' + spec['path']
        git('apply', '--cached', '--3way', '-', data=data)
        patches.append(spec)

    signals_path = 'llvm/lib/Support/Signals.cpp'
    signals = git('show', ':' + signals_path).decode()
    signature = 'void llvm::sys::PrintStackTraceOnErrorSignal(StringRef Argv0,'
    block = ('void llvm::sys::AddSignalHandler(sys::SignalHandlerCallback FnPtr,\n'
             '                                 void *Cookie) {}\n'
             'void llvm::sys::RunInterruptHandlers() {}')
    assert signature not in signals and signals.count(block) == 1, 'Unexpected signal stub input'
    changed = signals.replace(block, block + '\n' + signature + '\n'
                              '                                           bool DisableCrashReporting) {}')
    blob = git('hash-object', '-w', '--stdin', data=changed.encode()).decode().strip()
    git('update-index', '--cacheinfo', '100644,' + blob + ',' + signals_path)
    tree = git('write-tree').decode().strip()
    diff = git('diff', '--binary', '--full-index', commit, tree)
    assert tree == EXPECTED_TREE and sha(diff) == EXPECTED_DIFF, 'Reconstructed LLVM identity differs'
    result = {
        'schemaVersion': 1, 'kind': 'independently-reconstructed-clang-inputs',
        'qualificationCommit': QUALIFICATION, 'checkedAt': datetime.now(timezone.utc).isoformat(),
        'manifestSha256': sha(manifest_bytes), 'repository': manifest['sources']['llvm']['repository'],
        'commit': commit, 'tree': tree, 'diffSha256': sha(diff), 'patches': patches,
        'signalStub': {'path': signals_path, 'resultBlob': blob, 'resultSha256': sha(changed.encode())},
        'method': 'New private bare repository/index; apply pinned YoWASP binary diff and four checksum-pinned local patches, then explicit WASI signal stub; hash reconstructed Git tree and full binary diff.',
        'seedGit': str(args.seed_git.resolve()), 'reconstructedGit': str(args.scratch.resolve()),
        'limits': 'Independent source-input reconstruction only; not an independent compiler rebuild or host SDK byte inspection.'
    }
    with args.output.open('x') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    print(json.dumps({'passed': True, 'result': str(args.output), 'tree': tree, 'diffSha256': sha(diff)}))


if __name__ == '__main__':
    main()
