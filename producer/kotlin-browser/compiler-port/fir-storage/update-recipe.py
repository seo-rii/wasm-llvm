#!/usr/bin/env python3
"""Pin the actual cache/IR-lock/thread-local source substitutions, without editing originals."""
import difflib
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
SOURCE = REPO / 'out/kotlin-compiler-port/sources'
CLOSURE = REPO / 'producer/kotlin-browser/compiler-port/closure.lock.json'
closure_bytes = CLOSURE.read_bytes()
closure = json.loads(closure_bytes)
assert closure['source']['commit'] == '4d78aae1e337cd40f69baa865aed950fe807a775'
pins = {pin['path']: pin for pin in closure['files']}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)

cache_paths = [
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrCommonMemberStorage.kt',
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrDeclarationStorage.kt',
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrClassifierStorage.kt',
    'compiler/fir/tree/src/org/jetbrains/kotlin/fir/declarations/ExpectActualAttributes.kt',
    'compiler/fir/resolve/src/org/jetbrains/kotlin/fir/resolve/transformers/mpp/FirExpectActualMatchingContextImpl.kt',
]
lock_paths = [
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrSymbolsMappingForLazyClasses.kt',
    'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/util/SymbolTableSlice.kt',
    'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/declarations/lazy/IrLazySymbolTable.kt',
    'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/declarations/lazy/lazyUtil.kt',
]
ir_lock = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/IrLock.kt'
thread_local = 'compiler/util/src/org/jetbrains/kotlin/utils/threadLocal.kt'
paths = cache_paths + [ir_lock] + lock_paths + [thread_local]
references = [
    'compiler/fir/entrypoint/src/org/jetbrains/kotlin/fir/pipeline/convertToIr.kt',
    'compiler/resolution.common/src/org/jetbrains/kotlin/resolve/calls/mpp/AbstractExpectActualAnnotationMatchChecker.kt',
    'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/util/DescriptorSymbolTableExtension.kt',
    'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/util/SymbolTableExtension.kt',
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrConverter.kt',
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrLocalCallableStorage.kt',
]

def verified(relative):
    data = (SOURCE / relative).read_bytes()
    pin = pins[relative]
    assert len(data) == pin['bytes'] and digest(data) == pin['sha256']
    assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == pin['gitBlob']
    return data, pin

thread_body = '''private class ThreadLocalDelegate<T>(private val initializer: () -> T) : ReadWriteProperty<Any?, T> {
    // One slot belongs to this real delegate in the serial compiler Worker.
    // No Thread, source session or value is retained in a global registry.
    private var hasValue = false
    private var value: Any? = null

    override operator fun getValue(thisRef: Any?, property: KProperty<*>): T {
        if (!hasValue) {
            val created = initializer()
            if (created == null) throw NullPointerException()
            // The original ConcurrentMap.getOrPut performs putIfAbsent after
            // its callback: a value installed through reentry wins.
            if (!hasValue) {
                value = created
                hasValue = true
            }
        }
        @Suppress("UNCHECKED_CAST")
        return value as T
    }

    override operator fun setValue(thisRef: Any?, property: KProperty<*>, value: T) {
        if (value == null) throw NullPointerException()
        this.value = value
        hasValue = true
    }

    override fun toString(): String =
        if (hasValue) "ThreadLocalDelegate(#worker=>$value)" else "ThreadLocalDelegate()"
}
'''

changes = []
sources = []
for relative in paths:
    data, pin = verified(relative)
    original = data.decode()
    result = original
    if relative in cache_paths:
        result = once(result, 'import java.util.concurrent.ConcurrentHashMap\n',
            'import org.jetbrains.kotlin.utils.SerialFirCacheMap\n')
        result = result.replace('import java.util.concurrent.ConcurrentMap\n', '')
        result = re.sub(r'\bConcurrent(?:Hash)?Map\b', 'SerialFirCacheMap', result)
    elif relative == ir_lock:
        result = once(result, 'class IrLock', '''class IrLock {
    @PublishedApi
    internal var serialDepth: Int = 0
}

/** A synchronous, reentrant scope in one serial compiler Worker. */
inline fun <T> IrLock.withLock(block: () -> T): T {
    serialDepth++
    try {
        return block()
    } finally {
        serialDepth--
    }
}''')
    elif relative in lock_paths:
        result = once(result, 'import org.jetbrains.kotlin.ir.IrLock\n',
            'import org.jetbrains.kotlin.ir.IrLock\nimport org.jetbrains.kotlin.ir.withLock\n')
        assert result.count('synchronized(lock)') > 0
        result = result.replace('synchronized(lock)', 'lock.withLock')
        result = result.replace('    @Volatile\n', '')
        assert 'synchronized(' not in result and '@Volatile' not in result
    elif relative == thread_local:
        result = once(result, 'import java.util.concurrent.ConcurrentHashMap\n', '')
        offset = result.index('private class ThreadLocalDelegate<T>')
        result = result[:offset] + thread_body
    assert result != original
    output = result.encode()
    sources.append({**pin, 'patchedBytes': len(output), 'patchedSha256': digest(output)})
    for line in difflib.unified_diff(original.splitlines(keepends=True), result.splitlines(keepends=True),
            fromfile='a/' + relative, tofile='b/' + relative):
        changes.append(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n')

reference_pins = []
for relative in references:
    _, pin = verified(relative)
    reference_pins.append(pin)
patch = ''.join(changes).encode()
patch_path = HERE / 'patches/serial-fir-storage.patch'
patch_path.parent.mkdir(parents=True, exist_ok=True)
patch_path.write_bytes(patch)
adapter = (HERE / 'SerialFirCacheMap.kt').read_bytes()
traversal_source = 'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrDeclarationStorage.kt'
traversal_text = verified(traversal_source)[0].decode()
traversal_start = '    private fun fillUnboundSymbols(cache: Map<out FirCallableDeclaration, IrSymbol>) {'
traversal_end = '\n    }'
offset = traversal_text.index(traversal_start)
assert traversal_text.count(traversal_start) == 1
traversal_body = traversal_text[offset:traversal_text.index(traversal_end, offset) + len(traversal_end)].encode()
observer_paths = ['FirStorageProbe.kt', 'OriginalProbeSupport.kt', 'PortableProbeSupport.kt',
    'FirStorageJvmEntry.kt', 'FirStorageWasmEntry.kt', 'traversal.mjs']
lock = {
    'schemaVersion': 1,
    'kind': 'official-fir-ir-serial-cache-lock-source-port',
    'source': closure['source'],
    'sourceClosureLockSha256': digest(closure_bytes),
    'sources': sources,
    'referenceDependencies': reference_pins,
    'replacedOriginalPaths': paths,
    'patch': {'path': 'patches/serial-fir-storage.patch', 'bytes': len(patch), 'sha256': digest(patch)},
    'adapter': {'path': 'SerialFirCacheMap.kt', 'outputPath': 'compiler-port-fir-storage/SerialFirCacheMap.kt',
        'bytes': len(adapter), 'sha256': digest(adapter)},
    'generator': {'path': Path(__file__).name, 'sha256': digest(Path(__file__).read_bytes())},
    'traversal': {'sourcePath': traversal_source, 'start': traversal_start, 'end': traversal_end,
        'bytes': len(traversal_body), 'sha256': digest(traversal_body)},
    'observers': [{'path': name, 'bytes': len((HERE / name).read_bytes()),
        'sha256': digest((HERE / name).read_bytes())} for name in observer_paths],
    'hostProfile': 'serial-compiler-worker',
    'usedOperations': ['get', 'set', 'put', 'getValue', 'putAll', 'putIfAbsent',
        'ConcurrentMap.getOrPut', 'computeIfAbsent', 'Map.entries', 'Map.keys', 'Map.values',
        'filter/filterKeys/mapKeys', 'inline reentrant IrLock scope', 'per-delegate threadLocal get/set'],
    'ownership': [
        'Common-member storage is created per platform conversion and shared across its actual module conversions.',
        'Declaration/classifier storages retain real component and common-member owners; no global caches are added.',
        'FirExpectActualMappingStorage stays a real FirSession component with the original FirCache owner.',
        'Nested expect/actual maps and delegates own their own entries/values until their owner is released.',
        'cloneFilteringSymbols retains the original shallow/filter copy algorithm, including its exact copied fields.',
    ],
    'callbackAudit': [
        {'source': cache_paths[1], 'operation': 'computeIfAbsent',
            'callback': 'DataClassGeneratedFunctionsStorage()', 'sameCacheMutation': False},
        {'source': cache_paths[4], 'operation': 'computeIfAbsent',
            'callback': 'new nested expect-to-compatibility cache', 'sameCacheMutation': False},
        {'source': cache_paths[1], 'operation': 'getOrPut',
            'callbacks': ['dependency module descriptor/IrModuleFragment', 'external/builtin package fragments',
                'original synthetic property', 'supertype delegate field symbol'], 'reentryMustRetainInsertedWinner': True},
        {'source': cache_paths[2], 'operation': 'getOrPut',
            'callback': 'classifiersGenerator.createIrClassForNotFoundClass', 'reentryMustRetainInsertedWinner': True},
        {'source': cache_paths[1], 'operation': 'Map iteration',
            'callback': 'fillUnboundSymbols lazy-resolves and generates genuine declarations', 'weakTraversalRequired': True},
        {'source': thread_local, 'operation': 'getOrPut',
            'callback': 'actual Fir2IrLocalCallableStorage and symbol-table scope initialization', 'perDelegateLifetime': True},
    ],
    'semantics': [
        'Normal equality/hash keys and runtime null rejection; null compute results are not installed.',
        'getOrPut runs the callback before putIfAbsent, preserving a reentrant inserted winner.',
        'Actual compute callbacks only allocate another container. Exceptions/null release their reservation.',
        'Backed read-only views and next-node-prefetch weak iterators retain current visited values and can observe generation-time appends.',
        'Insertion order is an implementation detail, not a compiler or ConcurrentHashMap ordering promise.',
        'Reentrant inline serial lock scopes restore depth on exceptions and non-local returns.',
        'Actual lazy initialization retry/null/set order is unchanged; a setter does not discard the original initializer.',
    ],
    'integrationGates': [
        'No full ConcurrentMap/MutableMap API, mutable collection views, remove/clear, or multi-thread synchronization is claimed.',
        'JDK bin-specific outcomes for compute callbacks violating its no-same-map-update contract are outside this selected API.',
        'Weak iteration can omit later appends; exact JDK iteration order and visibility of new keys are not promised.',
        'The threadLocal diagnostic label is #worker rather than an invented JVM thread id.',
        'Coupled real PSI/JVM facade/descriptor dependencies in full storage/symbol-table files remain separate closure gates.',
        'No fixture descriptor/symbol replacements, public Kotlin support or full compiler success are provided.',
        'Product memory/time costs and full browser source-to-program compiler acceptance remain unmeasured.',
    ],
}
(HERE / 'sources.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(json.dumps({'sources': len(sources), 'references': len(reference_pins),
    'sourceLockSha256': digest((HERE / 'sources.lock.json').read_bytes()), 'adapterSha256': digest(adapter),
    'patchSha256': digest(patch)}))
