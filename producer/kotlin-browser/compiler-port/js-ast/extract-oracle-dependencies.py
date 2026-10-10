#!/usr/bin/env python3
"""Extract genuine transitive host support only, never compiler AST classes."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import zipfile

PREFIXES = ('org/jetbrains/kotlin/com/intellij/', 'org/jetbrains/kotlin/it/unimi/')
ROOTS = ('org/jetbrains/kotlin/com/intellij/util/SmartList',
         'org/jetbrains/kotlin/it/unimi/dsi/fastutil/objects/ObjectOpenHashSet')


def dependencies(data):
    assert data[:4] == b'\xca\xfe\xba\xbe'
    count = struct.unpack_from('>H', data, 8)[0]
    strings, classes = {}, []
    offset, index = 10, 1
    while index < count:
        tag = data[offset]
        offset += 1
        if tag == 1:
            size = struct.unpack_from('>H', data, offset)[0]
            offset += 2
            strings[index] = data[offset:offset + size].decode('utf-8', 'replace')
            offset += size
        elif tag == 7:
            classes.append(struct.unpack_from('>H', data, offset)[0])
            offset += 2
        elif tag in (8, 16, 19, 20):
            offset += 2
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            offset += 4
        elif tag in (5, 6):
            offset += 8
            index += 1
        elif tag == 15:
            offset += 3
        else:
            raise AssertionError('Unknown class constant ' + str(tag))
        index += 1
    # Include descriptor/signature and nested-class names as well as CONSTANT_Class.
    return {name for value in strings.values() for name in
            __import__('re').findall(r'org/jetbrains/kotlin/(?:com/intellij|it/unimi)/[A-Za-z0-9_/$]+', value)}


def main():
    source, output = map(Path, sys.argv[1:])
    selected = {}
    with zipfile.ZipFile(source) as archive:
        pending = list(ROOTS)
        available = set(archive.namelist())
        while pending:
            name = pending.pop()
            assert name.startswith(PREFIXES)
            path = name + '.class'
            if path in selected or path not in available:
                continue
            data = archive.read(path)
            selected[path] = data
            pending.extend(dependencies(data))
        assert all(root + '.class' in selected for root in ROOTS)
        with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as jar:
            for name, data in sorted(selected.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.external_attr = 0o600 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                jar.writestr(info, data)
    output.chmod(0o600)
    pins = [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            for name, data in sorted(selected.items())]
    print(json.dumps({'classes': pins, 'compilerAstClassesExtracted': False}))


if __name__ == '__main__':
    main()
