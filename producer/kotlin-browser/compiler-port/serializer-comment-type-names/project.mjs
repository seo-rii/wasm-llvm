import assert from 'node:assert/strict';
import {sha256,verifyFile} from '../../scripts/source.mjs';

function span(text,start,end) {
    const offset=text.indexOf(start),limit=text.indexOf(end,offset);assert(offset>=0&&limit>offset);
    const value=text.slice(offset,limit);return {text:value,start:offset,end:limit,bytes:Buffer.byteLength(value),sha256:sha256(Buffer.from(value))};
}
/** Exact selected method bodies in an explicitly observer-only container. */
export function projectCommentMethods({original,prepared,originalPin,preparedPin,variant,observer}) {
    verifyFile(original,originalPin);verifyFile(prepared,preparedPin);assert(['original','common'].includes(variant));
    const text=(variant==='original'?original:prepared).toString();
    const writer=span(text,'private class DataWriter {','private class JsIrAstSerializer');
    const comment=span(text,'    private fun DataWriter.writeComment(','    private inline fun DataWriter.withLocation(');
    const comments=span(text,'    private inline fun DataWriter.withComments(','\n}\n');
    const imports='import org.jetbrains.kotlin.js.backend.ast.*\nimport org.jetbrains.kotlin.js.portable.*\n'+
        (variant==='original'?'import java.io.ByteArrayOutputStream\nimport java.io.DataOutputStream\nimport java.nio.charset.StandardCharsets\nprivate val SerializationCharset=StandardCharsets.UTF_8\n':'import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes\n');
    const header=original.toString().slice(0,original.toString().indexOf('package '));
    let code=header+'package org.jetbrains.kotlin.js.commentprobe\n'+imports+'\n'+writer.text+'\n'+
        'private class CommentBoundary(private val commentTypeNames:JsCommentTypeNameReporter) {\n'+comment.text+comments.text+'\n'+
        '    fun direct(writer:DataWriter,comment:JsComment) {writer.writeComment(comment)}\n'+
        '    fun node(writer:DataWriter,node:JsNode) {writer.withComments(node) {writer.writeInt(123456)}}\n}\n'+
        observer.toString().replace(/^package[^\n]*\n/m,'');
    const importsAll=[...code.matchAll(/^import[^\n]+/gm)].map(x=>x[0]);code=code.replace(/^import[^\n]+\n/gm,'').replace(/^(package[^\n]*\n)/m,'$1'+[...new Set(importsAll)].join('\n')+'\n');
    const metadata=x=>({start:x.start,end:x.end,bytes:x.bytes,sha256:x.sha256});
    return {bytes:Buffer.from(code),variant,spans:{writer:metadata(writer),writeComment:metadata(comment),withComments:metadata(comments)},
        fullSerializer:false,shippingSource:false,innerFixture:'exact DataWriter.writeInt(123456) callback for withComments; complete genuine Serializer JVM observed separately'};
}
