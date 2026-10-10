import assert from 'node:assert/strict';
import { sha256 } from '../../../scripts/source.mjs';

export function selectedDataWriter(original, pin) {
  const text = original.toString('utf8');
  const start = text.indexOf('private class DataWriter {');
  const end = text.indexOf('private class JsIrAstSerializer {');
  assert(start >= 0 && end > start, 'Selected DataWriter boundaries changed');
  const body = text.slice(start, end);
  assert.equal(Buffer.byteLength(body), pin.bytes);
  assert.equal(sha256(Buffer.from(body)), pin.sha256);
  return body;
}

export function projectDataWriter(original, pin, common) {
  let body = selectedDataWriter(original, pin);
  const changes = [
    ['private class DataWriter {', 'private class ProbeDataWriter {'],
    ...(common ? [
      ['val data = ByteArrayOutputStream()', 'val data = JsAstByteWriter()'],
      ['private val output = DataOutputStream(data)', 'private val output = data'],
      ['fun saveTo(output: DataOutputStream)', 'fun saveTo(output: JsAstByteWriter)'],
      ['string.toByteArray(SerializationCharset)', 'string.compilerUtf8Bytes()'],
    ] : []),
  ];
  for (const [before, after] of changes) {
    assert.equal(body.split(before).length, 2, 'Nonunique DataWriter projection span: ' + before);
    body = body.replace(before, after);
  }
  const imports = common
    ? 'import org.jetbrains.kotlin.js.portable.JsAstByteWriter\nimport org.jetbrains.kotlin.portable.text.compilerUtf8Bytes\n'
    : 'import java.io.ByteArrayOutputStream\nimport java.io.DataOutputStream\nimport java.nio.charset.StandardCharsets\nprivate val SerializationCharset = StandardCharsets.UTF_8\n';
  const transfer = common ? 'source.saveTo(destination.data)' : 'source.saveTo(DataOutputStream(destination.data))';
  return { bytes: Buffer.from('package org.jetbrains.kotlin.js.outputprobe\n' + imports + '\n' + body +
    '\nprivate fun transferSaved(source: ProbeDataWriter, destination: ProbeDataWriter) { ' + transfer + ' }\n'), changes };
}
