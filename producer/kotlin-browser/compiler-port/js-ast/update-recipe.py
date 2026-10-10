#!/usr/bin/env python3
"""Seal exact original and prepared source bytes. No compiler completion claim."""
from pathlib import Path
import hashlib
import json

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]


def pin(path, name):
    data = path.read_bytes()
    return {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'gitBlob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}


def main():
    closure_path = HERE.parent / 'closure.lock.json'
    closure = json.loads(closure_path.read_text())
    sources = [p for p in closure['files'] if p['path'].startswith('js/js.ast/src/')]
    assert len(sources) == 107
    java = [p for p in sources if p['language'] == 'java']
    portable = []
    for original in java:
        relative = original['path'].removeprefix('js/js.ast/src/').removesuffix('.java') + '.kt'
        p = pin(HERE / 'portable' / relative, 'portable/' + relative)
        p['originalPath'] = original['path']
        p['outputPath'] = 'compiler-port-js-ast/' + relative
        portable.append(p)
    replacements = {p['path'] for p in portable}
    for filename in sorted((HERE / 'portable').rglob('*.kt')):
        relative = filename.relative_to(HERE).as_posix()
        if relative in replacements:
            continue
        p = pin(filename, relative)
        p['originalPath'] = None
        p['outputPath'] = 'compiler-port-js-ast/' + relative.removeprefix('portable/')
        portable.append(p)
    dependencies = [pin(HERE.parent / 'collections/SmartList.kt', '../collections/SmartList.kt'),
                    pin(HERE.parent / 'assertions/CompilerAssertions.kt', '../assertions/CompilerAssertions.kt')]
    reference = next(p for p in closure['files'] if p['path'].endswith('/utils/addToStdlib.kt'))
    lock = {'schemaVersion': 1, 'kind': 'official-java-js-ast-common-source-port', 'source': closure['source'],
            'primaryClosureSha256': hashlib.sha256(closure_path.read_bytes()).hexdigest(), 'sources': sources,
            'originalJavaSources': len(java), 'originalKotlinSources': len(sources) - len(java),
            'status': 'common-source-implementation-with-explicit-host-boundaries', 'portable': portable, 'commonDependencies': dependencies,
            'observers': [pin(HERE / name, name) for name in ('AstProbe.kt', 'OriginalProbeSupport.kt', 'PortableProbeSupport.kt', 'JvmEntry.kt', 'WasmEntry.kt')],
            'referenceDependencies': [reference], 'licenses': json.loads((HERE / 'license-pins.json').read_text()),
            'tools': [pin(HERE / name, name) for name in ('adapt.mjs', 'generate-properties.py', 'generate-character.py', 'update-recipe.py', 'extract-oracle-dependencies.py', 'browser.mjs', 'CharacterPolicy.java', 'license-pins.json')],
            'characterPolicy': pin(HERE / 'character-policy.json', 'character-policy.json'),
            'numberBoundary': {'sourceLock': pin(HERE / 'numbers/source.lock.json', 'numbers/source.lock.json'),
                               'evidence': pin(HERE / 'numbers/evidence/receipt.json', 'numbers/evidence/receipt.json')},
            'browserCompilerBuilt': False, 'languageReadiness': False}
    (HERE / 'sources.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
    print('Sealed', len(sources), 'original sources and', len(portable), 'common source files')


if __name__ == '__main__':
    main()
