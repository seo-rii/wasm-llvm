#!/usr/bin/env python3
"""Unpack the actual selected-source target KLIB into a bounded immutable probe index."""
import argparse
import hashlib
import json
import stat
import zipfile
from pathlib import Path

TARGET_SHA256 = '3c97b68581963cf32c18d8b6d93b467f3accc9eae2689c1655e8ed4b31f52d28'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--klib', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    assert hashlib.file_digest(args.klib.open('rb'), 'sha256').hexdigest() == TARGET_SHA256, 'Target stdlib pin differs'
    assert not args.output.exists()
    root = args.output / 'files'
    root.mkdir(parents=True, mode=0o700)
    paths = set()
    total = 0
    records = []
    directories = []
    with zipfile.ZipFile(args.klib) as archive:
        assert len(archive.infolist()) <= 16384
        for info in archive.infolist():
            path = info.filename.rstrip('/') if info.is_dir() else info.filename
            assert path and len(path) <= 4096 and not path.startswith('/') and '\\' not in path and '\0' not in path
            assert len(path.split('/')) <= 32 and all(part not in ('', '.', '..') for part in path.split('/'))
            assert path not in paths and not stat.S_ISLNK(info.external_attr >> 16)
            paths.add(path)
            destination = root / path
            if info.is_dir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                directories.append(path)
                continue
            assert info.file_size <= 64 * 1024 * 1024
            total += info.file_size
            assert total <= 128 * 1024 * 1024
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            digest = hashlib.sha256()
            size = 0
            with archive.open(info) as source, destination.open('xb') as output:
                destination.chmod(0o600)
                while chunk := source.read(65536):
                    size += len(chunk)
                    assert size <= info.file_size
                    digest.update(chunk)
                    output.write(chunk)
            assert size == info.file_size
            records.append({'path': path, 'bytes': size, 'sha256': digest.hexdigest()})
    result = {'schemaVersion': 1, 'kind': 'selected-source-patched-wasm-wasi-stdlib-probe-index',
              'stdlibSha256': TARGET_SHA256, 'sourceCommit': '4d78aae1e337cd40f69baa865aed950fe807a775',
              'decodedBytes': total, 'files': sorted(records, key=lambda item: item['path']), 'directories': sorted(directories)}
    (args.output / 'index.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'files': len(records), 'directories': len(directories), 'decodedBytes': total}))


if __name__ == '__main__':
    main()
