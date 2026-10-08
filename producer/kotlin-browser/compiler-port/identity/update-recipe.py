#!/usr/bin/env python3
"""Record the exact selected reference-index/owned-hash host substitutions."""
import difflib
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
SOURCE = REPO / 'out/kotlin-compiler-port/sources'
CLOSURE = REPO / 'producer/kotlin-browser/compiler-port/closure.lock.json'
closure_bytes = CLOSURE.read_bytes()
closure = json.loads(closure_bytes)
pins = {pin['path']: pin for pin in closure['files']}
COMMIT = '4d78aae1e337cd40f69baa865aed950fe807a775'
assert closure['source']['commit'] == COMMIT

def digest(data):
    return hashlib.sha256(data).hexdigest()

def replace_once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)

paths = [
    'compiler/util/src/org/jetbrains/kotlin/utils/SmartIdentityTable.kt',
    'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/IrElementBase.kt',
    'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/ir2wasm/WasmCompiledModuleFragment.kt',
    'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/serialization/WasmSerializer.kt',
    'compiler/fir/cones/src/org/jetbrains/kotlin/fir/types/ConeTypes.kt',
    'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/types/impl/IrTypeBase.kt',
    'core/descriptors/src/org/jetbrains/kotlin/types/ClassifierBasedTypeConstructor.kt',
]
changes = []
sources = []
for relative in paths:
    data = (SOURCE / relative).read_bytes()
    pin = pins[relative]
    assert len(data) == pin['bytes'] and digest(data) == pin['sha256']
    assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == pin['gitBlob']
    original = data.decode()
    result = original
    if relative.endswith('SmartIdentityTable.kt'):
        result = replace_once(result, 'import java.util.IdentityHashMap\n', '')
        result = result.replace('IdentityHashMap', 'IdentityIndex')
        result = replace_once(result, ' * At that point it switches to using an IdentityIndex.',
            ' * At that point it switches to the per-owner common IdentityIndex (linear lookup).')
    elif relative.endswith('IrElementBase.kt'):
        result = replace_once(result, 'import java.util.IdentityHashMap', 'import org.jetbrains.kotlin.utils.IdentityIndex')
        result = result.replace('IdentityHashMap<', 'IdentityIndex<')
    elif relative.endswith('WasmCompiledModuleFragment.kt') or relative.endswith('WasmSerializer.kt'):
        result = replace_once(result, 'import java.util.*', 'import org.jetbrains.kotlin.utils.IdentityIndex')
        result = result.replace('IdentityHashMap<', 'IdentityIndex<')
    if relative.endswith('ConeTypes.kt') or relative.endswith('IrTypeBase.kt'):
        result = replace_once(result, '    override fun hashCode(): Int = System.identityHashCode(this)',
            '    private val identityHashToken = Any()\n\n    override fun hashCode(): Int = identityHashToken.hashCode()')
    if relative.endswith('IrTypeBase.kt'):
        result = replace_once(result, 'IrErrorTypeImpl::class.java.hashCode()', 'IrErrorTypeImpl::class.hashCode()')
        result = replace_once(result, 'IrDynamicTypeImpl::class.java.hashCode()', 'IrDynamicTypeImpl::class.hashCode()')
    if relative.endswith('ClassifierBasedTypeConstructor.kt'):
        result = replace_once(result, '    private var hashCode = 0',
            '    private var hashCode = 0\n    private val identityHashToken = Any()')
        result = replace_once(result, '            System.identityHashCode(this)', '            identityHashToken.hashCode()')
    assert original != result
    sources.append({**pin, 'patchedBytes': len(result.encode()), 'patchedSha256': digest(result.encode())})
    changes.extend(difflib.unified_diff(original.splitlines(keepends=True), result.splitlines(keepends=True),
        fromfile='a/' + relative, tofile='b/' + relative))

patch = ''.join(changes).encode()
patch_path = HERE / 'patches/reference-index.patch'
patch_path.parent.mkdir(parents=True, exist_ok=True)
patch_path.write_bytes(patch)
adapter = (HERE / 'IdentityIndex.kt').read_bytes()
any_path = 'libraries/stdlib/wasm/builtins/kotlin/Any.kt'
any_bytes = (REPO / 'out/kotlin-stdlib-probe/sources' / any_path).read_bytes()
assert "Don't use outside, otherwise it could break classes reusing `_hashCode` field, like String." in any_bytes.decode()
projection_path = 'compiler/fir/cones/src/org/jetbrains/kotlin/fir/types/ConeTypeProjection.kt'
projection_bytes = (SOURCE / projection_path).read_bytes()
projection_pin = pins[projection_path]
assert len(projection_bytes) == projection_pin['bytes'] and digest(projection_bytes) == projection_pin['sha256']
assert hashlib.sha1(b'blob ' + str(len(projection_bytes)).encode() + b'\0' + projection_bytes).hexdigest() == projection_pin['gitBlob']
lock = {
    'schemaVersion': 1,
    'kind': 'official-reference-identity-common-source-port',
    'source': closure['source'],
    'sourceClosureLockSha256': digest(closure_bytes),
    'sources': sources,
    'referenceDependencies': [projection_pin],
    'patch': {'path': 'patches/reference-index.patch', 'bytes': len(patch), 'sha256': digest(patch)},
    'adapter': {'path': 'IdentityIndex.kt', 'outputPath': 'compiler-port-identity/IdentityIndex.kt',
        'bytes': len(adapter), 'sha256': digest(adapter)},
    'generator': {'path': Path(__file__).name, 'sha256': digest(Path(__file__).read_bytes())},
    'stdlibIdentityReference': {'path': any_path, 'bytes': len(any_bytes), 'sha256': digest(any_bytes),
        'gitBlob': hashlib.sha1(b'blob ' + str(len(any_bytes)).encode() + b'\0' + any_bytes).hexdigest(),
        'privatePrimitiveUsed': False, 'arbitraryObjectHashCodeUsed': False},
    'replacedOriginalPaths': paths,
    'usedOperations': ['constructor(expectedSize)', 'size', 'isEmpty', 'get', 'getValue', 'put', 'set', 'entry iteration'],
    'semantics': [
        'All key comparisons use reference identity; stored null is distinguished from an absent entry by getValue.',
        'The upstream SmartIdentityTable small-array and getOrCreate bodies stay unchanged; only the >10 backing index is replaced.',
        'Reference-ID insertion order and repeated-object behavior in WasmSerializer are unchanged.',
        'Attribute copy/filter/source-overwrite algorithms stay unchanged; identity-map iteration order is unspecified.',
        'Owned error/captured/local type hashes use one fresh private Any token per instance; no global identity registry.',
        'IrErrorTypeImpl and IrDynamicTypeImpl use their real common KClass hash; equal instances share a hash.',
    ],
    'integrationGates': [
        'IdentityIndex lookup is O(n); large-table compiler memory/time/product acceptance has not been measured.',
        'No JDK MutableMap equality/hash, mutable entry/key/value views or unused APIs are claimed.',
        'WasmSerializer OutputStream and WasmCompiledModuleFragment IntelliJ reverse helper remain separate real host boundaries.',
        'ClassTypeConstructorImpl Java Collections unmodifiable snapshot/live-view implementation is not ported by this unit.',
        'Cross-host numeric identity hash equality is neither meaningful nor claimed; hash stability and equal=>same hash are required.',
        'Complete selected FIR/IR source build and browser compilation are not proved by this preparation.',
    ],
}
(HERE / 'sources.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(json.dumps({'sources': len(sources), 'sourceLockSha256': digest((HERE / 'sources.lock.json').read_bytes()),
    'adapterSha256': digest(adapter), 'patchSha256': digest(patch)}))
