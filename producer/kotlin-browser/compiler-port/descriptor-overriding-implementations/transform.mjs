import assert from 'node:assert/strict';
export const JAVA = 'core/descriptors/src/org/jetbrains/kotlin/resolve/OverridingUtil.java';
export const OVERLAYS = [
    ['core/descriptors/src/org/jetbrains/kotlin/resolve/DescriptorEquivalenceForOverrides.kt', 'DescriptorEquivalenceForOverrides.kt', 'org.jetbrains.kotlin.portable.overriding.result'],
    ['core/descriptors/src/org/jetbrains/kotlin/resolve/overridingUtils.kt', 'overridingUtils.kt', null],
    ['core/descriptors/src/org/jetbrains/kotlin/resolve/scopes/GivenFunctionsMemberScope.kt', 'GivenFunctionsMemberScope.kt', null],
    ['core/deserialization/src/org/jetbrains/kotlin/serialization/deserialization/descriptors/DeserializedClassDescriptor.kt', 'DeserializedClassDescriptor.kt', 'org.jetbrains.kotlin.portable.classdescriptors.returnType'],
];
export const DIRECT = [
    'core/descriptors/src/org/jetbrains/kotlin/resolve/OverridingUtilTypeSystemContext.kt',
    'core/descriptors/src/org/jetbrains/kotlin/resolve/VisibilityUtil.kt',
    'core/descriptors/src/org/jetbrains/kotlin/types/checker/NewKotlinTypeChecker.kt',
];
export const CONSUMERS = [...OVERLAYS.map(row => row[0]), ...DIRECT];
function once(text, before, after) { assert.equal(text.split(before).length, 2, 'Exact overriding consumer anchor required'); return text.replace(before, after); }
export function transformConsumer(logical, bytes) {
    const spec = OVERLAYS.find(row => row[0] === logical); assert(spec, 'Unknown overriding consumer');
    let text = bytes.toString();
    if (spec[2]) { const match = /^package[^\r\n]+/m.exec(text); assert(match); const end = match.index + match[0].length;
        text = text.slice(0, end) + '\nimport ' + spec[2] + '\n' + text.slice(end); }
    else text = once(text, 'import java.util.*\n', '');
    if (spec[1] === 'overridingUtils.kt') text = once(text, 'val queue = LinkedList<H>(this)', 'val queue = this.toMutableList()');
    return Buffer.from(text);
}
export function reverseConsumer(logical, bytes) {
    const spec = OVERLAYS.find(row => row[0] === logical); assert(spec, 'Unknown overriding consumer');
    let text = bytes.toString();
    if (spec[2]) text = once(text, '\nimport ' + spec[2] + '\n', '');
    else { const anchor = spec[1] === 'overridingUtils.kt' ? 'import org.jetbrains.kotlin.utils.SmartSet\n' : 'import org.jetbrains.kotlin.utils.compact\n';
        text = once(text, anchor, anchor + 'import java.util.*\n'); }
    if (spec[1] === 'overridingUtils.kt') text = once(text, 'val queue = this.toMutableList()', 'val queue = LinkedList<H>(this)');
    return Buffer.from(text);
}
