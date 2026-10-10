#!/usr/bin/env python3
"""Refresh the reviewed complete Java-to-common port and small loader host patch."""
import argparse
import collections
import difflib
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
JAVA = 'core/descriptors/src/org/jetbrains/kotlin/builtins/KotlinBuiltIns.java'
LOADER = 'core/descriptors/src/org/jetbrains/kotlin/builtins/BuiltInsLoader.kt'
DEPENDENCIES = [
    'core/descriptors/src/org/jetbrains/kotlin/resolve/DescriptorUtils.java',
    'core/descriptors/src/org/jetbrains/kotlin/resolve/DescriptorUtils.kt',
    'core/descriptors/src/org/jetbrains/kotlin/descriptors/descriptorUtil.kt',
    'core/descriptors/src/org/jetbrains/kotlin/descriptors/findClassInModule.kt',
    'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/ModuleDescriptorImpl.kt',
    'core/descriptors/src/org/jetbrains/kotlin/builtins/functions/BuiltInFictitiousFunctionClassFactory.kt',
    'core/descriptors/src/org/jetbrains/kotlin/builtins/UnsignedType.kt',
    'core/deserialization/src/org/jetbrains/kotlin/serialization/deserialization/builtins/BuiltInsLoaderImpl.kt',
]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def method_inventory(text):
    result = []
    pattern = re.compile(r'^    (public|protected|private)( static)? (?:(\w+(?:<[^\n]+>)?) )?(\w+)\(([^\n]*)\) \{', re.M)
    for match in pattern.finditer(text):
        visibility, static, return_type, name, params = match.groups()
        parameters = []
        for parameter in params.split(',') if params else []:
            parameter = re.sub(r'@(?:NotNull|Nullable)\s*', '', parameter).replace('final ', '').strip()
            parameter_type, parameter_name = parameter.rsplit(' ', 1)
            parameters.append({'type': parameter_type, 'name': parameter_name})
        nullable = text[max(0, match.start() - 30):match.start()].strip().endswith('@Nullable')
        result.append({'name': name, 'visibility': visibility, 'static': bool(static), 'returnType': return_type,
                       'nullable': nullable, 'parameters': parameters})
    assert len(result) == 169, ('Incomplete selected method inventory', len(result))
    assert sum(item['name'] == 'KotlinBuiltIns' for item in result) == 1
    return result

def loader_port(text):
    assert text.count('import java.util.*\n') == 1
    text = text.replace('import java.util.*\n', '')
    start = text.index('    companion object {\n')
    assert text[start:].endswith('    }\n}\n')
    return text[:start] + '''    companion object {
        private var factory: (() -> BuiltInsLoader)? = null
        private var initializationStarted = false

        /** Register the legitimate profile loader before its first use. One registry per compiler Worker. */
        fun registerFactory(create: () -> BuiltInsLoader) {
            check(factory == null && !initializationStarted) { "BuiltInsLoader factory is already registered or initialization has started" }
            factory = create
        }

        val Instance: BuiltInsLoader by lazy(LazyThreadSafetyMode.NONE) {
            initializationStarted = true
            val create = factory ?: throw IllegalStateException("No BuiltInsLoader factory was registered for the browser compiler profile")
            create()
        }
    }
}
'''

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, default=REPO / 'out/kotlin-compiler-port/sources')
    args = parser.parse_args()
    closure = json.loads((HERE.parent / 'closure.lock.json').read_text())
    pins = {pin['path']: pin for pin in closure['files']}
    sources = []
    originals = {}
    for filename in [JAVA, LOADER, *DEPENDENCIES]:
        pin = pins[filename]
        data = (args.source_root / filename).read_bytes()
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        assert len(data) == pin['bytes'] and digest(data) == pin['sha256'] and blob == pin['gitBlob'], filename
        sources.append({key: pin[key] for key in ['path', 'bytes', 'gitBlob', 'sha256']})
        originals[filename] = data
    java = originals[JAVA].decode()
    inventory = method_inventory(java)
    base = (HERE / 'KotlinBuiltIns.kt').read_bytes()
    common_inventory = re.findall(r'\bfun (\w+)\(', base.decode())
    assert collections.Counter(common_inventory) == collections.Counter(item['name'] for item in inventory if item['name'] != 'KotlinBuiltIns'), 'Missing/extra methods in actual common source'
    aliases = []
    explicit = {'BuiltInsModule', 'BuiltInPackagesImportedByDefault', 'BuiltInsPackageScope', 'StorageManager',
                'AdditionalClassPartsProvider', 'PlatformDependentDeclarationFilter', 'ClassDescriptorFactories'}
    for method in inventory:
        name = method['name']
        if name.startswith('get') and not method['static'] and method['visibility'] != 'private' and not method['parameters'] and name[3:] not in explicit:
            property_name = name[3].lower() + name[4:]
            aliases.append({'method': name, 'property': property_name, 'type': method['returnType']})
    output = base.decode().replace('    // GENERATED_GETTER_ALIASES', '\n'.join(
        f'    @get:JvmName("{item["property"]}Property")\n    val {item["property"]}: {item["type"]} get() = {item["method"]}()'
        for item in aliases)).encode()
    patched_loader = loader_port(originals[LOADER].decode()).encode()
    patch = ''.join(difflib.unified_diff(originals[LOADER].decode().splitlines(True), patched_loader.decode().splitlines(True),
                                         fromfile='a/' + LOADER, tofile='b/' + LOADER)).encode()
    patch_root = HERE / 'patches'
    patch_root.mkdir(exist_ok=True)
    (patch_root / 'explicit-builtins-loader.patch').write_bytes(patch)
    lock = {'schemaVersion': 1, 'kind': 'official-kotlin-builtins-common-source-port', 'source': closure['source'],
            'sources': sources, 'originalJavaPath': JAVA, 'replacedOriginalPaths': [JAVA, LOADER],
            'portable': {'path': 'KotlinBuiltIns.kt', 'bytes': len(base), 'sha256': digest(base),
                         'outputPath': 'compiler-port-builtins/KotlinBuiltIns.kt', 'outputBytes': len(output), 'outputSha256': digest(output)},
            'patch': {'path': 'patches/explicit-builtins-loader.patch', 'bytes': len(patch), 'sha256': digest(patch)},
            'patchedLoader': {'path': LOADER, 'bytes': len(patched_loader), 'sha256': digest(patched_loader)},
            'generator': {'path': 'update-recipe.py', 'sha256': digest(Path(__file__).read_bytes())},
            'methods': inventory, 'getterAliases': aliases,
            'semantics': {'methodCoverage': 'all 168 methods and protected constructor; original private algorithms retained',
                          'maps': 'request-local equality-key maps; original EnumMap has no externally observed iteration',
                          'module': 'real ModuleDescriptorImpl initialized by real provider, or explicit existing module',
                          'caches': 'real StorageManager lazy/memoized functions; no independent global reset',
                          'assertions': 'enabled official compiler invariant policy; original JVM reference uses -ea',
                          'loader': 'one explicit legitimate factory per Worker; no absent-resource or empty-provider fallback',
                          'parentTraversal': 'exact non-strict DescriptorUtils.getParentOfType loop specialized to BuiltInsPackageFragment'},
            'readiness': {'sourcePort': 'implemented', 'jvmDifferential': 'not-run', 'wasmDifferential': 'not-run', 'browserCompiler': False}}
    (HERE / 'sources.lock.json').write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'methods': len(inventory), 'syntheticGetterAliases': len(aliases), 'patchSha256': digest(patch)}))

if __name__ == '__main__':
    main()
