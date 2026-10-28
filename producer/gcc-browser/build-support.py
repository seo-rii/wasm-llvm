#!/usr/bin/env python3
"""Fetch only hash-locked upstream sources into this build's isolated directory."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent


def file_sha256(path: pathlib.Path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify_patch_files(destination: pathlib.Path, files: dict, field: str):
    for name, hashes in files.items():
        path = destination / name
        actual = file_sha256(path) if path.exists() else None
        if actual != hashes[field]:
            raise RuntimeError(f"Patched source {field} mismatch: {path}")


def prepare_patches(destination: pathlib.Path, patches: list, *, fresh=False, patch_root=HERE):
    """Apply locked patches only to a fresh extraction; verify every resumed tree."""
    stamp = destination / '.gcc-wasm-patches.json'
    for patch in patches:
        if file_sha256(patch_root / patch['path']) != patch['sha256']:
            raise RuntimeError(f"Patch digest mismatch: {patch['path']}")
    if fresh:
        for patch in patches:
            verify_patch_files(destination, patch['files'], 'beforeSha256')
            command = ['patch', '--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch',
                       '-p1', '--input', str((patch_root / patch['path']).resolve())]
            subprocess.run([*command, '--dry-run'], cwd=destination, check=True)
            subprocess.run(command, cwd=destination, check=True)
            verify_patch_files(destination, patch['files'], 'afterSha256')
        if patches:
            stamp.write_text(json.dumps(patches, sort_keys=True) + '\n')
    elif patches or stamp.exists():
        if not stamp.exists() or json.loads(stamp.read_text()) != patches:
            raise RuntimeError(f"Source patch identity changed; use a fresh isolated build directory: {destination}")
    # Later patches may update a file from an earlier patch. Verify its final
    # identity, including on resume and immediately before issuing a receipt.
    files = {}
    for patch in patches:
        files.update(patch['files'])
    verify_patch_files(destination, files, 'afterSha256')
    return [{key: patch[key] for key in ('path', 'sha256', 'upstreamCommits')} for patch in patches]


def verify_source_patches(work: pathlib.Path):
    lock = json.loads((HERE / 'sources.lock.json').read_text())
    verified = []
    for name, item in lock['sources'].items():
        destination = work / 'sources' / item['directory']
        if (destination / '.gcc-wasm-source-sha256').read_text().strip() != item['sha256']:
            raise RuntimeError(f"Source digest stamp mismatch: {destination}")
        verified.extend({'source': name, **patch} for patch in
                        prepare_patches(destination, item.get('patches', [])))
    return verified


def prepare(work: pathlib.Path, minimum_free_gib: int):
    work.mkdir(parents=True, exist_ok=True)
    available = shutil.disk_usage(work).free
    if available < minimum_free_gib * 1024**3:
        raise RuntimeError(f"Build requires {minimum_free_gib} GiB free; {available / 1024**3:.2f} GiB available at {work}")
    lock = json.loads((HERE / 'sources.lock.json').read_text())
    sources = work / 'sources'
    sources.mkdir(exist_ok=True)
    downloads = work / 'downloads'
    downloads.mkdir(exist_ok=True)
    for name, item in lock['sources'].items():
        archive = downloads / item['url'].rsplit('/', 1)[1]
        if not archive.exists():
            temporary = archive.with_suffix(archive.suffix + '.partial')
            print(f"Downloading {name} {item['version']}", flush=True)
            with urllib.request.urlopen(item['url'], timeout=120) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output)
            temporary.rename(archive)
        actual = file_sha256(archive)
        if actual != item['sha256']:
            raise RuntimeError(f"Source digest mismatch: {archive}")
        destination = sources / item['directory']
        stamp = destination / '.gcc-wasm-source-sha256'
        if destination.exists():
            if not stamp.exists() or stamp.read_text().strip() != actual:
                raise RuntimeError(f"Refusing unknown source directory: {destination}")
            prepare_patches(destination, item.get('patches', []))
            continue
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                components = pathlib.PurePosixPath(member.name).parts
                if not components or components[0] != item['directory']:
                    raise RuntimeError(f"Unexpected archive root in {archive}: {member.name}")
            source.extractall(sources, filter='data')
        prepare_patches(destination, item.get('patches', []), fresh=True)
        stamp.write_text(actual + '\n')
    sdk = work / 'emsdk'
    if not sdk.exists():
        subprocess.run(['git', 'init', '--quiet', str(sdk)], check=True)
        subprocess.run(['git', '-C', str(sdk), 'remote', 'add', 'origin', lock['emsdk']['url']], check=True)
        subprocess.run(['git', '-C', str(sdk), 'fetch', '--depth=1', 'origin', lock['emsdk']['revision']], check=True)
        subprocess.run(['git', '-C', str(sdk), 'checkout', '--detach', '--quiet', 'FETCH_HEAD'], check=True)
    revision = subprocess.check_output(['git', '-C', str(sdk), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != lock['emsdk']['revision']:
        raise RuntimeError(f"Emsdk revision mismatch: {revision}")
    releases = json.loads((sdk / 'emscripten-releases-tags.json').read_text())
    if releases['releases'][lock['emsdk']['version']] != lock['emsdk']['releasesRevision']:
        raise RuntimeError('Emsdk release mapping differs from lock')
    subprocess.run([str(sdk / 'emsdk'), 'install', lock['emsdk']['version']], check=True)
    subprocess.run([str(sdk / 'emsdk'), 'activate', lock['emsdk']['version']], check=True)
    port = (sdk / 'upstream/emscripten/tools/ports/zlib.py').read_text()
    expected_port = lock['emscriptenPorts']['zlib']
    if f"VERSION = '{expected_port['version']}'" not in port or f"HASH = '{expected_port['sha512']}'" not in port:
        raise RuntimeError('Emscripten zlib port identity differs from lock')
    print(json.dumps({'sourcesVerified': list(lock['sources']), 'emsdkRevision': revision}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=pathlib.Path, required=True)
    parser.add_argument('--minimum-free-gib', type=int, default=16)
    parser.add_argument('--verify-patches', action='store_true',
                        help='Verify extracted source/patch identities without downloads or SDK setup')
    args = parser.parse_args()
    if args.verify_patches:
        print(json.dumps(verify_source_patches(args.work.resolve())))
    else:
        prepare(args.work.resolve(), args.minimum_free_gib)
