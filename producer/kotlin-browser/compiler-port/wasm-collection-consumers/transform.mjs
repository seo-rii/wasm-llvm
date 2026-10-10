import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

export const FRAGMENT = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/ir2wasm/WasmCompiledModuleFragment.kt';
export const CONTEXT = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/ir2wasm/codegenContexts/WasmTypeCodegenContext.kt';
export const PATHS = [FRAGMENT, CONTEXT];
export const ENCODER_IMPORT = 'import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes as toByteArray';
export const DECODER_IMPORT = 'import org.jetbrains.kotlin.portable.text.compilerUtf8String';
export const REVERSE_ORIGINAL = 'fun <K, V : Any> Map<K, V>.reverse(): Map<V, K> = map { (k, v) -> v to k }.toMap()';
export const REVERSE_SELECTED = 'allFunctionTypes.map { [k, v] -> v to k }.toMap()';
const PACKAGE = 'package org.jetbrains.kotlin.backend.wasm.ir2wasm\n';

export function transformWasmCollectionConsumer(logicalPath, predecessor, lock) {
    assert(PATHS.includes(logicalPath));
    const pin = lock.predecessor.outputs.find(item => item.path === logicalPath); assert(pin);
    assert.equal(predecessor.length, pin.bytes, 'Changed collection predecessor');
    assert.equal(sha256(predecessor), pin.sha256, 'Changed collection predecessor');
    const replacements = logicalPath === FRAGMENT ? [
        ['import com.intellij.util.containers.reverse\n', ''],
        ['allFunctionTypes.reverse()', REVERSE_SELECTED],
        [PACKAGE, PACKAGE + '\n' + ENCODER_IMPORT + '\n'],
    ] : [
        ['String(result, Charsets.UTF_8)', 'result.compilerUtf8String()'],
        [PACKAGE, PACKAGE + '\n' + ENCODER_IMPORT + '\n' + DECODER_IMPORT + '\n'],
    ];
    let text = predecessor.toString(), changes = [];
    for (const [before, after] of replacements) {
        assert.equal(text.split(before).length, 2, 'Selected host boundary must occur once');
        const offset = Buffer.byteLength(text.slice(0, text.indexOf(before)));
        changes.push({ offset, original: before, originalBytes: Buffer.byteLength(before), originalSha256: sha256(Buffer.from(before)),
            replacement: after, replacementBytes: Buffer.byteLength(after), replacementSha256: sha256(Buffer.from(after)) });
        text = text.replace(before, after);
    }
    const bytes = Buffer.from(text), output = lock.outputs?.find(item => item.path === logicalPath);
    if (output) { assert.equal(bytes.length, output.bytes); assert.equal(sha256(bytes), output.sha256, 'Consumer output changed'); }
    return { bytes, changes };
}
