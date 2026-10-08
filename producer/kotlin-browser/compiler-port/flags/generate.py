#!/usr/bin/env python3
"""Translate only the exact pinned compiler flag declarations and OR expressions.

This generates compiler dependency sources, never transforms user Kotlin source.
New upstream method bodies or field initializers require a reviewed new recipe.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def declarations(text):
    pattern = r"public static final (BooleanFlagField|FlagField<[^>]+>) (\w+) = (FlagField\.[^;]+);"
    result = []
    for match in re.finditer(pattern, text):
        kind, name, expression = match.groups()
        if not re.fullmatch(r"FlagField\.(booleanFirst\(\)|booleanAfter\(\w+\)|after\(\w+, ProtoBuf\.[A-Za-z.]+\.values\(\)\))", expression):
            raise ValueError("Unsupported field initializer: " + name)
        result.append((kind, name, expression, match.start(), match.end()))
    return result


def methods(text):
    pattern = r"public static int (\w+)\((.*?)\)\s*\{\s*return\s+(.*?);\s*\}"
    result = []
    for match in re.finditer(pattern, text, re.S):
        name, parameters, body = match.groups()
        parameters = re.sub(r"@(NotNull|Nullable)\s+", "", parameters)
        arguments = []
        for parameter in parameters.split(','):
            pieces = parameter.strip().split()
            if len(pieces) != 2:
                raise ValueError("Unsupported parameter: " + parameter)
            kind, parameter_name = pieces
            if not (kind == 'boolean' or re.fullmatch(r"ProtoBuf\.[A-Za-z.]+", kind)):
                raise ValueError("Unsupported parameter type: " + kind)
            arguments.append(("Boolean" if kind == "boolean" else kind, parameter_name))
        terms = [' '.join(term.split()) for term in body.split('|')]
        if not all(re.fullmatch(r"[A-Z_]+\.toFlags\(!?\w+\)", term) for term in terms):
            raise ValueError("Unsupported flag method body: " + name)
        result.append((name, arguments, terms, match.start(), match.end()))
    if len(result) != len(re.findall(r"public static int \w+\(", text)):
        raise ValueError("A public flag method was not translated")
    return result


def render_method(name, arguments, terms, delegate=None):
    parameters = ', '.join(f'{name}: {kind}' for kind, name in arguments)
    body = ('Flags.' + name + '(' + ', '.join(name for _, name in arguments) + ')') if delegate else ' or '.join(terms)
    return f'        @JvmStatic fun {name}({parameters}): Int = {body}\n'


def generate(source_root, output):
    here = Path(__file__).resolve().parent
    recipe_bytes = (here / 'sources.lock.json').read_bytes()
    recipe = json.loads(recipe_bytes)
    if recipe['source']['commit'] != '4d78aae1e337cd40f69baa865aed950fe807a775':
        raise ValueError('Unsupported Kotlin compiler source pin')
    runtime_bytes = (here / 'FlagFields.kt.inc').read_bytes()
    if digest(runtime_bytes) != recipe['fieldImplementationSha256']:
        raise ValueError('Flag field implementation changed')
    output.mkdir(parents=True, exist_ok=False)
    originals = []
    for pin in recipe['sources']:
        data = (source_root / pin['path']).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if len(data) != pin['bytes'] or digest(data) != pin['sha256'] or blob != pin['gitBlob']:
            raise ValueError('Original source hash mismatch: ' + pin['path'])
        originals.append(data.decode('utf-8'))
    fields = [declarations(text) for text in originals]
    functions = [methods(text) for text in originals]
    results = []
    for index, (class_name, package_name) in enumerate([
        ('Flags', 'org.jetbrains.kotlin.metadata.deserialization'),
        ('IrFlags', 'org.jetbrains.kotlin.backend.common.serialization'),
    ]):
        if len(fields[index]) != recipe['sources'][index]['fieldCount'] or len(functions[index]) != recipe['sources'][index]['methodCount']:
            raise ValueError('Source declaration inventory changed')
        text = '/* Generated from exact official flag declarations; Apache-2.0. */\n'
        text += f'package {package_name}\n\nimport kotlin.jvm.*\nimport org.jetbrains.kotlin.metadata.ProtoBuf\n'
        text += 'import org.jetbrains.kotlin.protobuf.Internal\n'
        if index:
            text += 'import org.jetbrains.kotlin.metadata.deserialization.Flags\n'
            text += 'import org.jetbrains.kotlin.metadata.deserialization.Flags.BooleanFlagField\n'
            text += 'import org.jetbrains.kotlin.metadata.deserialization.Flags.FlagField\n'
        text += '\n' + ('open class Flags protected constructor() {' if not index else 'class IrFlags private constructor() : Flags() {') + '\n'
        if not index:
            text += runtime_bytes.decode('utf-8') + '\n'
        text += '    companion object {\n'
        if index:
            for kind, name, _, _, _ in fields[0]:
                text += f'        @JvmField val {name}: {kind} = Flags.{name}\n'
        for kind, name, expression, _, _ in fields[index]:
            text += f'        @JvmField val {name}: {kind} = {expression}\n'
        text += '\n'
        if index:
            for name, arguments, terms, _, _ in functions[0]:
                text += render_method(name, arguments, terms, delegate=True)
        for name, arguments, terms, _, _ in functions[index]:
            text += render_method(name, arguments, terms)
        text += '    }\n}\n'
        data = text.encode('utf-8')
        filename = class_name + '.kt'
        with (output / filename).open('xb') as file:
            file.write(data)
        results.append({'path': filename, 'bytes': len(data), 'sha256': digest(data), 'original': recipe['sources'][index],
                        'fields': [{'name': name, 'start': start, 'end': end} for _, name, _, start, end in fields[index]],
                        'methods': [{'name': name, 'start': start, 'end': end} for name, _, _, start, end in functions[index]]})
    receipt = {'schemaVersion': 1, 'kind': 'official-compiler-flags-source-generation', 'source': recipe['source'],
               'recipeSha256': digest(recipe_bytes), 'generatorSha256': digest(Path(__file__).read_bytes()),
               'fieldImplementationSha256': digest(runtime_bytes), 'sources': results, 'browserCompiler': False}
    with (output / 'receipt.json').open('x') as file:
        json.dump(receipt, file, indent=2)
        file.write('\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    arguments = parser.parse_args()
    result = generate(arguments.source_root.resolve(), arguments.output.resolve())
    print(json.dumps({'sources': len(result['sources']), 'browserCompiler': result['browserCompiler']}))
