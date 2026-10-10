import assert from 'node:assert/strict';
import {sha256,verifyFile} from '../../scripts/source.mjs';

function selected(text,start,end){
 const offset=text.indexOf(start),limit=text.indexOf(end,offset);
 assert(offset>=0&&limit>offset,'Changed exact serializer projection boundaries');
 return text.slice(offset,limit);
}
export function projectSerializerTransport({original,prepared,inventory,observer,support,variant,mode}){
 assert(['original','common'].includes(variant));assert(['writer','save'].includes(mode));
 verifyFile(original,inventory.inputOriginal);verifyFile(prepared,inventory.output);
 const text=(variant==='common'?prepared:original).toString(),common=variant==='common';
 const writer=selected(text,'private class DataWriter {','private class JsIrAstSerializer {');
 const saver=selected(text,'    fun saveTo(rawOutput:','    private fun DataWriter.writeFragment(');
 const head=original.toString().slice(0,original.toString().indexOf('package '));
 const imports=common?
 'import org.jetbrains.kotlin.js.portable.*\nimport org.jetbrains.kotlin.portable.text.compilerUtf8Bytes\n':
 'import java.io.ByteArrayOutputStream\nimport java.io.DataOutputStream\nimport java.io.OutputStream\nimport java.nio.charset.StandardCharsets\nprivate val SerializationCharset = StandardCharsets.UTF_8\n';
 let body=writer.replace('private class DataWriter {','private class ProbeDataWriter {');
 if(mode==='writer'){
  // This observer-owned sink only transfers the exact selected DataWriter saveTo result into another real writer.
  body+=common?`\nprivate fun transferSaved(source: ProbeDataWriter, destination: ProbeDataWriter) {
    source.saveTo(JsAstStreamOutput(object : CompilerByteSink {
        override fun write(bytes: ByteArray, offset: Int, length: Int) = destination.data.write(bytes.copyOfRange(offset, offset + length))
        override fun flush() {}
        override fun close() {}
    }))
}\n`:'\nprivate fun transferSaved(source: ProbeDataWriter, destination: ProbeDataWriter) { source.saveTo(DataOutputStream(destination.data)) }\n';
 }else{
  // Prebuilt section bytes/counts are a bounded method fixture, outside all compiler namespaces.
  body+=`\nprivate class SaveBoundary {
    private val stringMap = mapOf("first" to 0, "second" to 1)
    private val nameMap = mapOf("name" to 0)
    private val stringSerializer = ProbeDataWriter().also { it.writeString("a\\ud800z") }
    private val nameSerializer = ProbeDataWriter().also { it.writeInt(-27) }
    private val fragmentSerializer = ProbeDataWriter().also { it.writeBoolean(true); it.writeDouble(Double.NaN) }
${saver}\n}\n`;
 }
 const withoutPackage=bytes=>bytes.toString().replace(/^package[^\n]*\n/,'');
 let code=head+'package org.jetbrains.kotlin.js.outputprobe\n'+imports+'\n'+body+'\n'+(support?withoutPackage(support)+'\n':'')+withoutPackage(observer);
 const allImports=[...code.matchAll(/^import[^\n]+/gm)].map(m=>m[0]);
 code=code.replace(/^import[^\n]+\n/gm,'').replace(/^(package[^\n]*\n)/m,'$1'+[...new Set(allImports)].join('\n')+'\n');
 return {bytes:Buffer.from(code),spans:{writer:{bytes:Buffer.byteLength(writer),sha256:sha256(Buffer.from(writer))},saveTo:{bytes:Buffer.byteLength(saver),sha256:sha256(Buffer.from(saver))}},
  scope:mode==='writer'?'Exact complete selected DataWriter body with observer-only buffer transfer sink':'Exact complete selected DataWriter and saveTo bodies with explicit prebuilt section/count fixture',
  fullSerializer:false,shippingSource:false,variant,mode};
}
