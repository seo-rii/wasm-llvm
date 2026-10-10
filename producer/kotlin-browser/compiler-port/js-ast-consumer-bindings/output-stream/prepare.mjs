import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { saveBody } from './project.mjs';
import { selectedDataWriter } from '../output-codec/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
export const OUTPUT = 'compiler-port-js-ast-output-stream/org/jetbrains/kotlin/js/portable/JsAstStreamOutput.kt';
async function inputs(sourceRoot) {
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
  assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'selected-js-ast-output-stream-protocol');
  const closureBytes = await readRegular(path.join(HERE, '../../closure.lock.json')), closure = JSON.parse(closureBytes);
  assert.equal(sha256(closureBytes), lock.primaryClosureSha256); assert.deepEqual(lock.source, closure.source);
  assert.deepEqual(lock.consumer, closure.files.find(pin => pin.path === lock.consumer.path));
  const original = verifyFile(await readRegular(path.join(sourceRoot, lock.consumer.path)), lock.consumer);
  selectedDataWriter(original, lock.dataWriterSpan); saveBody(original, lock.saveToSpan);
  for (const pin of [...lock.tools, ...lock.observers, ...lock.observerDependencies, lock.implementation])
    verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
  return { lock, lockBytes, implementation: verifyFile(await readRegular(path.join(HERE, lock.implementation.path)), lock.implementation) };
}
function receiptFor(input) {
  return { schemaVersion: 1, kind: 'selected-js-ast-output-stream-preparation', source: input.lock.source,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.lock.tools.find(pin => pin.path === 'prepare.mjs').sha256,
    consumer: input.lock.consumer, dataWriterSpan: input.lock.dataWriterSpan, saveToSpan: input.lock.saveToSpan,
    file: { path: OUTPUT, bytes: input.implementation.length, sha256: sha256(input.implementation), gitBlob: gitBlob(input.implementation) },
    sinkContract: 'Synchronous requested byte slices; single request and Worker; normal Throwable identity/suppression and close once.',
    threadDeathPrecedence: false, nativeConcurrencyParity: false, backingArrayIdentityParity: false,
    serializerIntegrated: false, fullSerializerBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareJsAstOutputStream({ sourceRoot, outputRoot }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
  assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
  assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
  await assertNoSymlink(outputRoot); const input = await inputs(sourceRoot);
  const filename = path.join(outputRoot, OUTPUT); await assertNoSymlink(filename);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, input.implementation, { flag: 'wx', mode: 0o600 });
  const receipt = receiptFor(input), receiptPath = path.join(outputRoot, 'output-stream-inputs.json'); await writeJson(receiptPath, receipt);
  return { commonSources: [filename], replacedOriginalPaths: [], receipt, receiptPath };
}
export async function verifyJsAstOutputStream({ sourceRoot, outputRoot, receiptPath }) {
  const input = await inputs(sourceRoot), receipt = receiptFor(input);
  verifyFile(await readRegular(path.join(outputRoot, OUTPUT)), receipt.file);
  assert.deepEqual(JSON.parse(await readRegular(receiptPath)), receipt); return receipt;
}
