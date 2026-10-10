import assert from 'node:assert/strict';
import { sha256 } from '../../../scripts/source.mjs';

/** Exact method bodies only; all extraction boundaries are pinned in sources.lock.json. */
export function extracts(deserializer, serializer, constants) {
    const d = deserializer.toString(), s = serializer.toString(), c = constants.toString();
    function between(text, start, end) {
        const begin = text.indexOf(start), finish = text.indexOf(end, begin + start.length);
        assert(begin >= 0 && finish > begin); return text.slice(begin, finish).trimEnd();
    }
    return {
        readInt: between(d, '    private fun readInt(): Int {', '\n    private fun readDouble'),
        readBytes: between(d, '    private inline fun <R> readBytes(', '\n    private fun readByteArray'),
        readByteArray: between(d, '    private fun readByteArray(): ByteArray', '\n    private fun readString'),
        writeByte: between(s, '    fun writeByte(byte: Int) {', '\n    fun writeByteArray'),
        writeByteArray: between(s, '    fun writeByteArray(byteArray: ByteArray) {', '\n    fun writeString'),
        visitBigInt: between(s, '            override fun visitBigInt(x: JsBigIntLiteral) {', '\n            override fun visitDouble'),
        literal: between(d, '                        BIGINT_LITERAL -> {', '\n                        ARRAY_LITERAL').split('\n')[1].trim(),
        expressionIds: between(c, 'object ExpressionIds {', '\nobject PropertyInitializerKinds')
    };
}

export function verifyExtracts(result, pins) {
    assert.deepEqual(Object.fromEntries(Object.entries(result).map(([name, text]) => [name, sha256(Buffer.from(text))])), pins);
}

export function inputSource(parts, portable) {
    return `package org.jetbrains.kotlin.js.astintegerprobe
import org.jetbrains.kotlin.js.backend.ast.JsBigIntLiteral
${portable ? 'import org.jetbrains.kotlin.js.util.AstInteger as BigInteger' : 'import java.math.BigInteger\nimport java.nio.ByteBuffer'}
class LiteralInput(private val source: ByteArray) {
    private val buffer = ${portable ? 'ProbeIntegerCursor(source)' : 'ByteBuffer.wrap(source)'}
${parts.readInt}
${parts.readBytes}
${parts.readByteArray}
    fun literal(): JsBigIntLiteral = ${parts.literal}
    fun position(): Int = buffer.position()
}
`;
}

export function writerSource(parts) {
    return `package org.jetbrains.kotlin.js.astintegerprobe
import org.jetbrains.kotlin.js.backend.ast.JsBigIntLiteral
import org.jetbrains.kotlin.js.backend.ast.JsVisitor
${parts.expressionIds}
class LiteralWriter {
    private val output = LiteralOutput()
${parts.writeByte}
${parts.writeByteArray}
    fun literal(node: JsBigIntLiteral): ByteArray {
        object : JsVisitor() {
${parts.visitBigInt}
        }.visitBigInt(node)
        return output.bytes()
    }
}
`;
}
