#!/usr/bin/env python3
"""Import exact SDK archive bytes and the existing source-pinned WASI linker."""
import argparse
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def identity(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def linker_inputs(linker):
    """Bind the exact linker archive to its original producer source metadata."""
    packed = (ROOT / linker['archive']).read_bytes()
    if identity(packed)['sha256'] != linker['archiveSha256']:
        raise RuntimeError('Browser wasm-ld archive differs from the source-pinned LLVM producer')
    producer_bytes = (ROOT / linker['producerManifest']).read_bytes()
    toolchain_bytes = (ROOT / linker['toolchainReceipt']).read_bytes()
    if identity(producer_bytes)['sha256'] != linker['producerManifestSha256']:
        raise RuntimeError('Original LLVM producer manifest hash mismatch')
    if identity(toolchain_bytes)['sha256'] != linker['toolchainReceiptSha256']:
        raise RuntimeError('LLVM toolchain receipt hash mismatch')
    producer = json.loads(producer_bytes)
    toolchain = json.loads(toolchain_bytes)
    if (toolchain['producer']['manifestSha256'] != linker['producerManifestSha256']
            or toolchain['producer']['manifest'] != linker['producerManifestOriginalPath']
            or toolchain['producer']['id'] != producer['producerId']):
        raise RuntimeError('LLVM toolchain receipt does not identify the original producer manifest')
    if (toolchain['assets']['lld.zip'] != linker['archiveSha256']
            or toolchain['llvmCommit'] != linker['commit']
            or toolchain['llvmVersion'] != linker['version']):
        raise RuntimeError('LLVM toolchain receipt does not identify the pinned linker')
    llvm = producer['sources']['llvm']
    if any(llvm[key] != linker[key] for key in ['repository', 'commit', 'version']):
        raise RuntimeError('Original LLVM producer identifies another source revision')
    return packed, producer_bytes, toolchain_bytes


def prepare(archive, output):
    lock_bytes = (HERE / 'runtime.lock.json').read_bytes()
    lock = json.loads(lock_bytes)
    with archive.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != lock['wasiLibc']['sdkArchiveSha256']:
        raise RuntimeError('WASI SDK archive hash mismatch')
    linker = lock['browserLinker']
    packed, producer_bytes, toolchain_bytes = linker_inputs(linker)
    output.mkdir(parents=True, exist_ok=False)
    sysroot = output / 'sysroot'
    prefix = 'wasi-sdk-33.0-x86_64-linux/'
    headers = prefix + 'share/wasi-sysroot/include/wasm32-wasi/'
    libs = prefix + 'share/wasi-sysroot/lib/wasm32-wasi/'
    builtins = prefix + 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a'
    inventory = []
    required_libs = {'crt1-command.o', 'libc.a', 'libm.a'}
    with tarfile.open(archive) as source:
        for member in source:
            relative = None
            # SDK33 includes two complete libc++ header trees here. This GCC
            # profile uses its own libstdc++ and never exposes those trees.
            if member.name.startswith(headers) and not member.name[len(headers):].startswith(('eh/', 'noeh/')):
                relative = member.name[len(prefix + 'share/wasi-sysroot/'):]
            elif member.name.startswith(libs) and member.name[len(libs):] in required_libs:
                relative = 'lib/wasm32-wasi/' + member.name[len(libs):]
            elif member.name == builtins:
                relative = 'lib/wasm32-wasi/libclang_rt.builtins-wasm32.a'
            if relative is None or member.isdir():
                continue
            parts = pathlib.PurePosixPath(relative).parts
            if '..' in parts or pathlib.PurePosixPath(relative).is_absolute():
                raise RuntimeError('Unsafe SDK archive path')
            if not member.isfile():
                raise RuntimeError(f'Unexpected SDK link/special file: {member.name}')
            data = source.extractfile(member).read()
            destination = sysroot / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            inventory.append({'path': relative, 'archiveMember': member.name, **identity(data)})
    patches = lock['wasiLibc'].get('patches', [])
    for patch in patches:
        name = pathlib.PurePosixPath(patch['path'])
        if name.is_absolute() or '..' in name.parts:
            raise RuntimeError('Unsafe runtime patch path')
        patch_file = HERE / name
        if identity(patch_file.read_bytes())['sha256'] != patch['sha256']:
            raise RuntimeError(f'WASI header patch hash mismatch: {name}')
        subprocess.run(['patch', '--batch', '--forward', '-p1', '-d', str(sysroot), '-i', str(patch_file)], check=True)
    for item in inventory:
        modified = identity((sysroot / item['path']).read_bytes())
        if modified['sha256'] != item['sha256']:
            item['archiveIdentity'] = {key: item[key] for key in ['bytes', 'sha256']}
            item.update(modified)
    for name in required_libs | {'libclang_rt.builtins-wasm32.a'}:
        if not (sysroot / 'lib/wasm32-wasi' / name).is_file():
            raise RuntimeError(f'Missing target library: {name}')
    for name in ['stdio.h', 'stdlib.h', 'math.h', 'stdint.h']:
        if not (sysroot / 'include/wasm32-wasi' / name).is_file():
            raise RuntimeError(f'Missing target header: {name}')
    with zipfile.ZipFile(io.BytesIO(packed)) as source:
        if source.namelist() != ['lld']:
            raise RuntimeError('Unexpected linker archive members')
        module = source.read('lld')
    if module[:8] != b'\0asm\x01\0\0\0':
        raise RuntimeError('The linker is not a WebAssembly executable')
    (output / 'ld.wasm').write_bytes(module)
    (output / 'llvm-toolchain.json').write_bytes(toolchain_bytes)
    (output / 'llvm-producer.json').write_bytes(producer_bytes)
    receipt = {
        'schemaVersion': 1, 'kind': 'gcc-wasi-runtime-import', 'target': 'wasm32-wasi',
        'runtimeLock': identity(lock_bytes), 'sdkArchiveSha256': digest,
        'patches': patches,
        'files': sorted(inventory, key=lambda item: item['path']),
        'linker': {'path': 'ld.wasm', **identity(module), **linker},
        'provenance': {
            'llvm-producer.json': identity(producer_bytes),
            'llvm-toolchain.json': identity(toolchain_bytes),
        },
    }
    (output / 'runtime-build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'files': len(inventory), 'bytes': sum(x['bytes'] for x in inventory), 'linker': identity(module)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk-archive', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    prepare(args.sdk_archive.resolve(), args.output.resolve())
