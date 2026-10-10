import assert from 'node:assert/strict';

export const FRAGMENT = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/ir2wasm/WasmCompiledModuleFragment.kt';
export const CONTEXT = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/ir2wasm/codegenContexts/WasmTypeCodegenContext.kt';
export const WRITER = 'wasm/wasm.ir/src/org/jetbrains/kotlin/wasm/ir/convertors/WasmIrToBinary.kt';
export const PATHS = [FRAGMENT, CONTEXT, WRITER];

export const REPLACEMENTS = {
    [FRAGMENT]: [
        ['definedDeclarations.functionTypes.putIfAbsent(funTypeSignature, funType)', 'definedDeclarations.functionTypes.getOrPut(funTypeSignature) { funType }'],
        ['            for (symbol in linkerData.globalLiterals) {\n                definedDeclarations.globalLiteralGlobals.computeIfAbsent(symbol.value) { string ->',
            '            for (symbol in linkerData.globalLiterals) {\n                val string = symbol.value\n                definedDeclarations.globalLiteralGlobals.getOrPut(string) {'],
    ],
    [CONTEXT]: [
        ['wasmFileFragment.definedFunctionTypes.putIfAbsent(signature, wasmFunctionType)', 'wasmFileFragment.definedFunctionTypes.getOrPut(signature) { wasmFunctionType }'],
    ],
    [WRITER]: [
        ['                    .toSortedMap()', '                    .toList().sortedBy { it.first }'],
    ],
};

/** Only the audited serial/non-null map operations and one ascending snapshot. */
export function transformWasmCollections(sourcePath, bytes) {
    assert(PATHS.includes(sourcePath), 'Unselected Wasm collections source');
    let text = bytes.toString('utf8');
    for (const [from, to] of REPLACEMENTS[sourcePath]) {
        const count = sourcePath === CONTEXT ? 2 : 1;
        assert.equal(text.split(from).length - 1, count, 'Selected source operation changed: ' + sourcePath);
        assert(!text.includes(to), 'Already transformed source: ' + sourcePath);
        text = text.split(from).join(to);
    }
    return Buffer.from(text);
}
