#!/usr/bin/env python3
"""Bind the complete descriptor algorithm port and the exact remaining selected common caller."""
import collections
import difflib
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
JAVA = 'core/descriptors/src/org/jetbrains/kotlin/resolve/DescriptorUtils.java'
REFLECTION = 'core/descriptors/src/org/jetbrains/kotlin/builtins/ReflectionTypes.kt'
CALLERS = [
    'core/descriptors/src/org/jetbrains/kotlin/descriptors/DescriptorVisibilities.java',
    'core/descriptors/src/org/jetbrains/kotlin/builtins/KotlinBuiltIns.java',
    REFLECTION,
]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def main():
    closure_bytes = (HERE.parent / 'closure.lock.json').read_bytes()
    closure = json.loads(closure_bytes)
    original_root = REPO / 'out/kotlin-compiler-port/sources'
    pins = {item['path']: item for item in closure['files']}
    sources = []
    for path in [JAVA, *CALLERS]:
        pin = pins[path]
        data = (original_root / path).read_bytes()
        assert len(data) == pin['bytes'] and digest(data) == pin['sha256']
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == pin['gitBlob']
        sources.append({key: pin[key] for key in ['path', 'bytes', 'gitBlob', 'sha256']})
    java = (original_root / JAVA).read_text()
    names = re.findall(r'^    (?:public|private) static (?:<[^>]+>\s+)?[^=\n(]+? (\w+)\(', java, re.M)
    assert len(names) == 70
    base = (HERE / 'DescriptorUtils.kt').read_bytes()
    functions = re.findall(r'\bfun (?:<[^>]+>\s+)?(\w+)\(', base.decode())
    assert collections.Counter(names) == collections.Counter(functions), 'Missing or extra original algorithm method'
    common = base.replace(b'        // JVM_CLASS_PARENT_ADAPTER', b'')
    adapter = (HERE / 'JvmParentAdapter.inc').read_bytes()
    assert base.count(b'classifier?.let { it::class }') == 1
    jvm = base.replace(b'        // JVM_CLASS_PARENT_ADAPTER', adapter).replace(b'classifier?.let { it::class }', b'classifier?.let { it.javaClass }')
    reflection = (original_root / REFLECTION).read_text()
    old = 'DescriptorUtils.getParentOfType(descriptor, PackageFragmentDescriptor::class.java)'
    assert reflection.count(old) == 1
    changed = reflection.replace(old, 'DescriptorUtils.getParentOfType(descriptor, org.jetbrains.kotlin.resolve.DescriptorType.PACKAGE_FRAGMENT)')
    patch = ''.join(difflib.unified_diff(reflection.splitlines(True), changed.splitlines(True), fromfile='a/' + REFLECTION, tofile='b/' + REFLECTION)).encode()
    (HERE / 'patches').mkdir(exist_ok=True)
    (HERE / 'patches/typed-parent-caller.patch').write_bytes(patch)
    complete_scan = []
    for pin in closure['files']:
        if not pin['path'].endswith(('.kt', '.java')): continue
        body = (original_root / pin['path']).read_text()
        records = [{'line': line_number, 'text': line.strip()} for line_number, line in enumerate(body.splitlines(), 1)
                   if 'getParentOfType' in line]
        if records: complete_scan.append({'path': pin['path'], 'sourceSha256': pin['sha256'], 'records': records})
    assert {item['path'] for item in complete_scan if any('DescriptorUtils.getParentOfType' in record['text'] for record in item['records'])} == set(CALLERS)
    type_bytes = (HERE / 'DescriptorType.kt').read_bytes()
    recipe = {'schemaVersion': 1, 'kind': 'official-descriptor-utils-common-source-port', 'source': closure['source'],
              'sourceClosureLockSha256': digest(closure_bytes), 'sources': sources, 'originalJavaPath': JAVA,
              'methods': names, 'parentTypes': ['ClassDescriptor', 'DeclarationDescriptorWithVisibility', 'PackageFragmentDescriptor', 'BuiltInsPackageFragment'],
              'replacedOriginalPaths': [JAVA, REFLECTION], 'callerScan': complete_scan,
              'callerDisposition': {
                  CALLERS[0]: 'root frozen DescriptorVisibilities port already uses exact typed reified traversal',
                  CALLERS[1]: 'frozen KotlinBuiltIns port already specializes exact non-strict BuiltInsPackageFragment traversal',
                  REFLECTION: 'one exact common typed-key caller patch',
                  'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/PsiIrFileEntry.kt': 'separate PSI TreeUtil host boundary; not DescriptorUtils parent caller',
                  'compiler/ir/ir.psi2ir/src/org/jetbrains/kotlin/psi2ir/generators/LoopExpressionGenerator.kt': 'separate PSI extension host boundary; not DescriptorUtils parent caller',
              },
              'portable': {'path': 'DescriptorUtils.kt', 'bytes': len(base), 'sha256': digest(base),
                           'outputPath': 'compiler-port-descriptor-utils/DescriptorUtils.kt', 'outputBytes': len(common), 'outputSha256': digest(common)},
              'typedKey': {'path': 'DescriptorType.kt', 'bytes': len(type_bytes), 'sha256': digest(type_bytes)},
              'jvmAdapter': {'path': 'JvmParentAdapter.inc', 'bytes': len(adapter), 'sha256': digest(adapter), 'outputBytes': len(jvm), 'outputSha256': digest(jvm)},
              'patch': {'path': 'patches/typed-parent-caller.patch', 'bytes': len(patch), 'sha256': digest(patch),
                        'outputPath': REFLECTION, 'outputBytes': len(changed.encode()), 'outputSha256': digest(changed.encode())},
              'generator': {'path': 'update-recipe.py', 'sha256': digest(Path(__file__).read_bytes())},
              'semantics': {'algorithms': 'all seventy original static methods retained, including private algorithms',
                            'parentTraversal': 'exact strict/non-strict traversal using explicit supported descriptor-kind casts; no unknown-key fallback',
                            'ancestry': 'reference identity as original Java ==; constructor/class checks retain original equality semantics',
                            'overrideSets': 'original linked postorder for getAllOverriddenDescriptors; original unordered set semantics for getAllOverriddenDeclarations',
                            'source': 'actual PropertySetterDescriptor.correspondingProperty and genuine SourceFile.NO_SOURCE_FILE rules',
                            'jvm': 'Class overloads available in generated comparison/JVM adapter only, absent from common C source',
                            'assertionText': 'getInnerClassByName assertion uses actual KClass text instead of java.lang.Class text; assertion condition unchanged'},
              'integrationGates': ['complete concrete descriptor/type/visibility helper closure',
                                   'separate PSI sources remain explicit unclosed host boundaries',
                                   'future Java getParentOfType callers outside selected closure require real typed bindings; no generic fallback'],
              'readiness': {'sourcePort': 'implemented', 'jvmDifferential': 'not-run', 'wasmDifferential': 'not-run', 'browserCompiler': False}}
    (HERE / 'sources.lock.json').write_text(json.dumps(recipe, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'methods': len(names), 'parentCallerFiles': len(CALLERS), 'scanFiles': len(complete_scan), 'patchSha256': digest(patch)}))

if __name__ == '__main__': main()
