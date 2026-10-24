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
        actual = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
        if actual != item['sha256']:
            raise RuntimeError(f"Source digest mismatch: {archive}")
        destination = sources / item['directory']
        stamp = destination / '.gcc-wasm-source-sha256'
        if destination.exists():
            if not stamp.exists() or stamp.read_text().strip() != actual:
                raise RuntimeError(f"Refusing unknown source directory: {destination}")
            continue
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                components = pathlib.PurePosixPath(member.name).parts
                if not components or components[0] != item['directory']:
                    raise RuntimeError(f"Unexpected archive root in {archive}: {member.name}")
            source.extractall(sources, filter='data')
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
    print(json.dumps({'sourcesVerified': list(lock['sources']), 'emsdkRevision': revision}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=pathlib.Path, required=True)
    parser.add_argument('--minimum-free-gib', type=int, default=16)
    args = parser.parse_args()
    prepare(args.work.resolve(), args.minimum_free_gib)
