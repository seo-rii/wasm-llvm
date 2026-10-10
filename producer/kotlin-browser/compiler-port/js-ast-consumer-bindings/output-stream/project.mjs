import assert from 'node:assert/strict';
import { projectDataWriter } from '../output-codec/project.mjs';
import { sha256 } from '../../../scripts/source.mjs';

export function saveBody(original, pin) {
  const text = original.toString(), start = text.indexOf('    fun saveTo(rawOutput: OutputStream) {');
  const end = text.indexOf('    private fun DataWriter.writeFragment(', start);
  assert(start >= 0 && end > start);
  const body = text.slice(start, end);
  assert.equal(Buffer.byteLength(body), pin.bytes); assert.equal(sha256(Buffer.from(body)), pin.sha256);
  return body;
}
export function projectSaveBoundary(original, writerPin, saverPin, common) {
  const writer = projectDataWriter(original, writerPin, common);
  let code = writer.bytes.toString().replace(/\nprivate fun transferSaved[^\n]+\n/, '\n');
  let method = saveBody(original, saverPin);
  const changes = [];
  const replace = (target, before, after) => {
    assert.equal(target.split(before).length, 2, 'Nonunique stream projection span'); changes.push({ before, after });
    return target.replace(before, after);
  };
  if (common) {
    code = replace(code, 'fun saveTo(output: JsAstByteWriter)', 'fun saveTo(output: JsAstStreamOutput)');
    code = replace(code, 'data.writeTo(it)', 'it.write(data.toByteArray())');
    code = code.replace('import org.jetbrains.kotlin.js.portable.JsAstByteWriter\n',
      'import org.jetbrains.kotlin.js.portable.JsAstByteWriter\nimport org.jetbrains.kotlin.js.portable.JsAstStreamOutput\nimport org.jetbrains.kotlin.js.portable.CompilerByteSink\nimport org.jetbrains.kotlin.js.portable.useJsAstOutput\n');
    method = replace(method, 'rawOutput: OutputStream', 'rawOutput: CompilerByteSink');
    method = replace(method, 'DataOutputStream(rawOutput).use {', 'JsAstStreamOutput(rawOutput).useJsAstOutput {');
  } else code = code.replace('import java.io.DataOutputStream\n', 'import java.io.DataOutputStream\nimport java.io.OutputStream\n');
  // Fixtures supply only prebuilt section bytes and count keys. No IR/AST compiler classes are invented.
  const fields = `
private class SaveBoundary {
    private val stringMap = mapOf("first" to 0, "second" to 1)
    private val nameMap = mapOf("name" to 0)
    private val stringSerializer = ProbeDataWriter().also { it.writeString("a\\ud800z") }
    private val nameSerializer = ProbeDataWriter().also { it.writeInt(-27) }
    private val fragmentSerializer = ProbeDataWriter().also { it.writeBoolean(true); it.writeDouble(Double.NaN) }
`;
  return { bytes: Buffer.from(code + fields + method + '\n}\n'), changes: [...writer.changes, ...changes],
    scope: 'Exact complete DataWriter and exact selected serializer saveTo body; explicit prebuilt section/count fixtures outside compiler namespaces',
    fullSerializer: false, shippingSource: false };
}
