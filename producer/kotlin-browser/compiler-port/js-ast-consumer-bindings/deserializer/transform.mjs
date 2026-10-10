import assert from 'node:assert/strict';
export const DESERIALIZER = 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/serialization/JsIrAstDeserializer.kt';
export const REPLACEMENTS = [
    ['import java.nio.ByteBuffer', 'import org.jetbrains.kotlin.js.portable.JsAstInput\nimport org.jetbrains.kotlin.js.portable.jsAstCommentList'],
    ['import java.util.*\n', ''],
    ['private val buffer = ByteBuffer.wrap(source)', 'private val input = JsAstInput(source)'],
    ['private val fileStack: Deque<String> = ArrayDeque()', 'private val fileStack = ArrayDeque<String>()'],
    ['buffer.get()', 'input.readByte()'], ['buffer.int', 'input.readInt()'], ['buffer.double', 'input.readDouble()'],
    ['buffer.position()', 'input.position'], ['buffer.position(offset + length)', 'input.seek(offset + length)'],
    ['String(source, offset, length, SerializationCharset)', 'input.readUtf8(offset, length)'],
    ['fileStack.peek()', 'fileStack.firstOrNull()'], ['fileStack.push(deserializedFile)', 'fileStack.addFirst(deserializedFile)'],
    ['fileStack.pop()', 'fileStack.removeFirst()'],
    ['readArray { readComment() }.toList()', 'jsAstCommentList(readArray { readComment() })']
];
export function bindDeserializer(bytes) {
    let text = bytes.toString();
    for (const [from, to] of REPLACEMENTS) {
        const count = text.split(from).length - 1;
        assert.equal(count, from === 'fileStack.peek()' || from === 'readArray { readComment() }.toList()' ? 2 : 1, from);
        text = text.split(from).join(to);
    }
    assert(!/\b(?:ByteBuffer|Deque|buffer)\b/.test(text));
    return Buffer.from(text);
}
export function selectedMethods(bytes) {
    const text = bytes.toString();
    function between(start, end) { const i=text.indexOf(start), j=text.indexOf(end,i+start.length); assert(i>=0 && j>i); return text.slice(i,j).trimEnd(); }
    return {
        primitives: between('    private fun readByte(): Byte {', '\n    private inline fun readRepeated'),
        ifTrue: between('    private inline fun <T> ifTrue(', '\n    fun readFragments'),
        comment: between('    private fun readComment(): JsComment {', '\n    private inline fun <T : JsNode> withLocation'),
        location: between('    private inline fun <T : JsNode> withLocation(', '\n    private inline fun <T : JsNode> withComments'),
        comments: text.slice(text.indexOf('    private inline fun <T : JsNode> withComments('),text.lastIndexOf('\n}')).trimEnd()
    };
}
export function commentAddExpression(bytes) { const text=bytes.toString(); const begin=text.indexOf('        (ref.commentsBeforeNode ?:'); const end=text.indexOf('\n    }',begin); assert(begin>=0 && end>begin); return text.slice(begin,end).trim(); }
export function projection(bytes, common) {
    const methods=selectedMethods(bytes);
    return `package org.jetbrains.kotlin.js.deserializerprobe
import org.jetbrains.kotlin.js.backend.ast.*
${common ? 'import org.jetbrains.kotlin.js.portable.JsAstInput\nimport org.jetbrains.kotlin.js.portable.jsAstCommentList' : 'import java.nio.ByteBuffer\nimport java.util.*'}
class SelectedInput(private val source: ByteArray, private val stringTable: Array<String>) {
    private val ${common ? 'input = JsAstInput(source)' : 'buffer = ByteBuffer.wrap(source)'}
    private val fileStack${common ? ' = ArrayDeque<String>()' : ': Deque<String> = ArrayDeque()'}
${Object.values(methods).join('\n')}
    fun byte(): Byte = readByte()
    fun int(): Int = readInt()
    fun double(): Double = readDouble()
    fun text(): String = readString()
    fun bytes(): ByteArray = readByteArray()
    fun position(): Int = ${common ? 'input.position' : 'buffer.position()'}
    fun stack(): List<String> = fileStack.toList()
    fun location(action: () -> JsNode): JsNode = withLocation(action)
    fun comments(action: () -> JsNode): JsNode = withComments(action)
}
${common ? '' : 'private val SerializationCharset = Charsets.UTF_8'}
`;
}
