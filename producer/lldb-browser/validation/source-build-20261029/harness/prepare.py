#!/usr/bin/env python3
"""Freeze the small qualification fixture; never launches Chromium."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

BASE = Path(__file__).resolve().parent
FIXTURE = BASE / 'consumer'
CONFIG = json.loads((BASE / 'configuration.json').read_bytes())
DONOR = Path(CONFIG.get('dependencyDonor', '/home/seorii/dev/hancomac/.worktrees/wasm-idle-debug-next-java-20261028'))
PRODUCER = Path(CONFIG.get('producerRepository', '/home/seorii/dev/hancomac/wasm-llvm'))
SUPPORT_DONOR = Path(CONFIG['supportAssetDonor'])
HEAD = CONFIG['consumerRevision']
PRODUCER_HEAD = CONFIG['producerRevision']

def sha(data):
    return hashlib.sha256(data).hexdigest()

def inventory(root):
    result = {}
    for file in sorted(root.rglob('*')):
        if file.is_symlink():
            raise RuntimeError(f'Asset snapshot contains a symlink: {file}')
        if file.is_file():
            data = file.read_bytes()
            result[str(file.relative_to(root))] = {'bytes': len(data), 'sha256': sha(data)}
    return result

def restore_published_support():
    """Restore ignored compiler/editor/container files by the consumer's pins."""
    manifest_bytes = (FIXTURE / 'scripts/browser-test-assets.v1.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get('format') != 'wasm-idle-browser-test-assets-v1':
        raise RuntimeError('Unexpected published browser asset manifest')
    selected = {}
    for asset in manifest['assets']:
        if asset['group'] not in ['clang', 'clangd', 'container']:
            continue
        relative = Path(asset['target'])
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Published support asset escapes static directory')
        receipt = asset.get('decoded', asset)
        pin = {'bytes': receipt['size'], 'sha256': receipt['sha256']}
        name = str(relative)
        if name in selected and selected[name] != pin:
            raise RuntimeError(f'Conflicting published support pins: {name}')
        selected[name] = pin
    if not selected or not any(name.startswith('container-app/host/') for name in selected):
        raise RuntimeError('Published container host assets are required for the official UI')
    records = {}
    for name, expected in sorted(selected.items()):
        source = SUPPORT_DONOR / name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError(f'Missing regular pinned support cache file: {source}')
        data = source.read_bytes()
        if {'bytes': len(data), 'sha256': sha(data)} != expected:
            raise RuntimeError(f'Published support cache differs from pinned consumer: {name}')
        target = FIXTURE / 'static' / name
        if target.exists():
            if target.is_symlink() or not target.is_file() or target.read_bytes() != data:
                raise RuntimeError(f'Existing support snapshot differs: {name}')
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        records[name] = expected
    return {'manifestSha256': sha(manifest_bytes), 'source': str(SUPPORT_DONOR),
            'groups': ['clang', 'clangd', 'container'], 'assets': records}

def private_dependencies(source, target):
    target.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        if entry.name.startswith('.') and entry.name != '.bin':
            continue
        dest = target / entry.name
        if entry.name.startswith('@') and entry.is_dir() and not entry.is_symlink():
            private_dependencies(entry, dest)
            continue
        resolved = entry.resolve(strict=True)
        try:
            relative = resolved.relative_to(DONOR)
        except ValueError:
            relative = None
        if relative is not None and relative.parts[0] in ('packages', 'runtimes') and 'node_modules' not in relative.parts:
            resolved = FIXTURE / relative
        if dest.is_symlink():
            if Path(os.readlink(dest)) == dest:
                dest.unlink()
                dest.symlink_to(resolved, target_is_directory=True)
            elif dest.resolve() != resolved:
                raise RuntimeError(f'Dependency changed: {dest}')
        elif dest.exists():
            raise RuntimeError(f'Refusing existing dependency path: {dest}')
        else:
            dest.symlink_to(resolved, target_is_directory=True)

def main():
    global HEAD
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--consumer-revision', required=True)
    options = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}', options.consumer_revision):
        parser.error('A full published consumer main revision is required')
    os.umask(0o077)
    if (BASE / 'fixture-identity.json').exists():
        raise RuntimeError('Fixture already frozen; use its existing identity')
    if FIXTURE.exists():
        raise RuntimeError('Inspect the existing partial consumer before retrying preparation')
    if shutil.disk_usage(BASE).free < 256 * 1024**2:
        raise RuntimeError('At least 256 MiB is needed for the minimal source/asset snapshot')
    git_dir = Path(CONFIG['gitDirectory'])
    subprocess.run(['git', '-C', str(git_dir), 'fetch', 'origin', 'main:refs/remotes/origin/main'], check=True)
    subprocess.run(['git', '-C', str(git_dir), 'merge-base', '--is-ancestor', options.consumer_revision,
                    'refs/remotes/origin/main'], check=True)
    published_main = subprocess.check_output(['git', '-C', str(git_dir), 'rev-parse', 'refs/remotes/origin/main'], text=True).strip()
    HEAD = options.consumer_revision
    subprocess.run(['git', '-C', str(git_dir), 'worktree', 'add', '--detach', '--no-checkout', str(FIXTURE), HEAD], check=True)
    subprocess.run(['git', 'sparse-checkout', 'set', 'src', 'scripts', 'packages', 'runtimes', 'examples', '.github'], cwd=FIXTURE, check=True)
    # Only populate the empty index of this newly created task worktree.
    subprocess.run(['git', 'reset', '--hard', HEAD], cwd=FIXTURE, check=True)
    CONFIG['consumerRevision'] = HEAD
    CONFIG['publishedMainObserved'] = published_main
    (BASE / 'configuration.json').write_text(json.dumps(CONFIG, indent=2) + '\n')
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=FIXTURE, text=True).strip()
    if actual != HEAD:
        raise RuntimeError('Unexpected consumer HEAD')
    lock = (FIXTURE / 'pnpm-lock.yaml').read_bytes()
    if lock != (DONOR / 'pnpm-lock.yaml').read_bytes():
        raise RuntimeError('Dependency donor has a different lockfile')
    if (FIXTURE / 'static').exists():
        raise RuntimeError('Static snapshot already exists')
    paths = ['static/clang', 'static/wasm-rust', 'static/worker.js', 'static/favicon.png',
             'static/image.jpeg', 'static/.nojekyll', 'static/_headers',
             'static/compressed-runtime-assets.v1.json', 'static/layered-runtime-assets.v1.json']
    process = subprocess.Popen(['git', 'archive', HEAD, *paths], cwd=FIXTURE, stdout=subprocess.PIPE)
    with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
        for member in archive:
            relative = Path(member.name)
            if relative.is_absolute() or '..' in relative.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError(f'Unexpected Git archive member: {member.name}')
            archive.extract(member, FIXTURE)
    if process.wait():
        raise RuntimeError('Git asset snapshot failed')
    support = restore_published_support()
    # Limit only the delivery indexes, retaining all immutable C/Rust payload bytes.
    compressed = FIXTURE / 'static/compressed-runtime-assets.v1.json'
    data = json.loads(compressed.read_bytes())
    data['assets'] = [name for name in data['assets'] if (FIXTURE / 'static' / (name + '.gz')).is_file()]
    data['sizes'] = {name: data['sizes'][name] for name in data['assets']}
    compressed.write_text(json.dumps(data, indent=2) + '\n')
    layered = FIXTURE / 'static/layered-runtime-assets.v1.json'
    data = json.loads(layered.read_bytes())
    data['layers'] = {name: value for name, value in data['layers'].items() if (FIXTURE / 'static' / name).is_file()}
    data['assets'] = {name: value for name, value in data['assets'].items() if value['layer'] in data['layers']}
    layered.write_text(json.dumps(data, indent=2) + '\n')
    private_dependencies(DONOR / 'node_modules', FIXTURE / 'node_modules')
    for group in ['packages', 'runtimes']:
        for package in (FIXTURE / group).iterdir():
            source = DONOR / package.relative_to(FIXTURE) / 'node_modules'
            if source.is_dir():
                private_dependencies(source, package / 'node_modules')
    shutil.copyfile(BASE / 'qualification-cpp-browser.mjs', FIXTURE / 'scripts/qualification-cpp-browser.mjs')
    producer_files = ['producer/clang-browser/scripts/package-language-sysroots.mjs',
                      'test/native-wasm-debug/container-adaptors.cpp',
                      'test/native-wasm-debug/function-end.cpp']
    receipts = {}
    for name in producer_files:
        data = subprocess.check_output(['git', 'show', f'{PRODUCER_HEAD}:{name}'], cwd=PRODUCER)
        dest = BASE / 'producer' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        receipts[name] = {'bytes': len(data), 'sha256': sha(data)}
    identity = {'consumerRevision': HEAD, 'consumerMain': HEAD, 'sourceKind': 'published-main',
                'publishedMainObserved': published_main, 'producerRevision': PRODUCER_HEAD,
                'dependencyDonor': str(DONOR), 'packageLockSha256': sha(lock),
                'publishedSupportRestoration': support,
                'static': inventory(FIXTURE / 'static'), 'producerFiles': receipts,
                'qualificationScope': 'C/C++, Rust, LLDB/WAMR, and receipt-pinned published container/editor UI support.'}
    (BASE / 'fixture-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    (BASE / 'preparation-status.json').write_text(json.dumps({'state': 'assets-and-source-frozen',
        'consumerFrozen': True, 'consumerRevision': HEAD, 'browserLaunched': False}, indent=2) + '\n')
    print(json.dumps({'consumer': HEAD, 'assetBytes': sum(v['bytes'] for v in identity['static'].values()),
                      'producer': PRODUCER_HEAD, 'status': 'prepared-no-browser'}))

if __name__ == '__main__':
    main()
