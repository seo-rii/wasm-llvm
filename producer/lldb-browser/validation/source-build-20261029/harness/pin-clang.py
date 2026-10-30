#!/usr/bin/env python3
"""Validate and install a candidate compiler, then derive its own split sysroots."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
from prepare import BASE, FIXTURE, inventory

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--clang-source', type=Path, required=True)
    parser.add_argument('--receipt-sha256', required=True)
    parser.add_argument('--work-dir', type=Path, required=True)
    options = parser.parse_args()
    os.umask(0o077)
    source = options.clang_source.resolve(strict=True)
    raw = (source / 'clang-build-receipt.json').read_bytes()
    if sha(raw) != options.receipt_sha256:
        raise RuntimeError('Clang source receipt differs from the explicitly selected artifact')
    receipt = json.loads(raw)
    if receipt.get('manifestSha256') != 'de99e0be692a813c854edf8f42606f35226c285b567b246c617a1cecc74c62d9':
        raise RuntimeError('Clang candidate is not from the expected producer manifest')
    # The ordinary consumer contract validates source inputs, sidecars, recipe,
    # patch identities and hashes before atomically replacing this task's assets.
    subprocess.run(['node', 'scripts/sync-wasm-clang.mjs', str(source)], cwd=FIXTURE, check=True)
    work = options.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=False)
    sysroot = work / 'sysroot'
    sysroot.mkdir()
    total = 0
    files = set()
    with tarfile.open(FIXTURE / 'static/clang/bin/sysroot.tar.gz', 'r:gz') as archive:
        for member in archive:
            name = Path(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isdir() or member.isfile()):
                raise RuntimeError(f'Unexpected sysroot member: {member.name}')
            dest = sysroot / name
            if member.isdir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            total += member.size
            if name in files or total > 128 * 1024**2 or len(files) >= 20000:
                raise RuntimeError('Duplicate or excessive sysroot archive')
            files.add(name)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as input_file, dest.open('xb') as output:
                shutil.copyfileobj(input_file, output)
    toolchain = json.loads((FIXTURE / 'static/clang/runtime-build.json').read_bytes())['toolchain']
    toolchain_file = work / 'toolchain.json'
    toolchain_file.write_text(json.dumps(toolchain, indent=2) + '\n')
    splitter = BASE / 'producer/producer/clang-browser/scripts/package-language-sysroots.mjs'
    split = work / 'profiles'
    code = ('const {packageLanguageSysroots}=await import(process.argv[1]);'
            'const result=await packageLanguageSysroots({sysroot:process.argv[2],toolchainReceipt:process.argv[3],output:process.argv[4]});'
            'console.log(JSON.stringify({manifestSha256:result.manifestSha256}));')
    subprocess.run(['node', '--input-type=module', '-e', code, splitter.as_uri(), str(sysroot),
                    str(toolchain_file), str(split)], check=True)
    for name in ['c-sysroot.tar.gz', 'cpp-addon.tar.gz']:
        shutil.copyfile(split / name, FIXTURE / 'static/clang/bin' / name)
    shutil.copyfile(split / 'language-sysroots.v1.json', FIXTURE / 'static/clang/language-sysroots.v1.json')
    # The separately shipped print/scan support library remains pinned to the
    # consumer snapshot, as in the product's normal compiler configuration.
    names = ['runtime-manifest.v1.json', 'libc-printscan-long-double.a.gz', 'bin/memfs.wasm.gz',
             'bin/clang.wasm.gz', 'bin/lld.wasm.gz', 'bin/sysroot.tar.gz',
             'bin/c-sysroot.tar.gz', 'bin/cpp-addon.tar.gz', 'language-sysroots.v1.json']
    support = FIXTURE / 'static/clang/libc-printscan-long-double.a.gz'
    if not support.exists():
        support.write_bytes(subprocess.check_output(['git', 'show', 'HEAD:static/clang/libc-printscan-long-double.a.gz'], cwd=FIXTURE))
    pins = {}
    for name in names:
        data = (FIXTURE / 'static/clang' / name).read_bytes()
        logical = gzip.decompress(data) if name.endswith('.gz') else data
        pins[name] = {'bytes': len(data), 'sha256': sha(data),
                      'uncompressedBytes': len(logical), 'uncompressedSha256': sha(logical)}
    output = ('// Task-local candidate pins, derived from the verified source build.\n'
              "export const BUNDLED_CLANG_LANGUAGE_SYSROOT_PROFILES = Object.freeze({c:Object.freeze({asset:'bin/c-sysroot.tar.gz'}),cppAddon:Object.freeze({asset:'bin/cpp-addon.tar.gz'})});\n"
              'export const BUNDLED_CLANG_ASSET_INTEGRITY = Object.freeze(' + json.dumps(pins, indent=2) + ');\n')
    (FIXTURE / 'src/lib/playground/clangAssetIntegrity.ts').write_text(output)
    evidence = {'sourceReceiptSha256': sha(raw), 'producerManifestSha256': receipt['manifestSha256'],
                'splitterSha256': sha(splitter.read_bytes()), 'derivedPins': pins,
                'installed': inventory(FIXTURE / 'static/clang')}
    (work / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'status': 'candidate-pinned', 'receiptSha256': sha(raw), 'evidence': str(work / 'evidence.json')}))

if __name__ == '__main__':
    main()
