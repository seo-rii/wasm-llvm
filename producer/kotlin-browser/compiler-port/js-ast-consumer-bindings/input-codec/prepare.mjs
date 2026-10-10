import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { generateCompilerUtf8 } from '../../text/generate.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const OUTPUT = 'compiler-port-js-ast-input/org/jetbrains/kotlin/js/portable/JsAstInput.kt';
async function inputs(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'pinned-selected-js-ast-input-codec');
    const closureBytes = await readRegular(path.join(HERE, '../../closure.lock.json')); assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes); assert.deepEqual(lock.source, closure.source);
    assert.deepEqual(lock.consumer, closure.files.find(pin => pin.path === lock.consumer.path));
    const original = verifyFile(await readRegular(path.join(sourceRoot, lock.consumer.path)), lock.consumer);
    const calls = [...original.toString().matchAll(/\bbuffer\.([^\n]+)/g)].map(match => match[1]); assert.deepEqual(calls, lock.selectedCalls);
    for (const pin of [...lock.dependencies, ...lock.tools, ...lock.observers, lock.implementation]) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const textLock = JSON.parse(await readRegular(path.join(HERE, '../../text/sources.lock.json')));
    const algorithm = generateCompilerUtf8(await readRegular(path.join(HERE, '../../text/upstream/utf8Encoding.kt')));
    assert.equal(sha256(algorithm), textLock.generatedAlgorithm.sha256);
    assert.deepEqual(lock.sharedDependencies, [textLock.generatedAlgorithm, textLock.api]);
    return { lock, lockBytes, implementation: verifyFile(await readRegular(path.join(HERE, lock.implementation.path)), lock.implementation) };
}
function receiptFor(input) {
    const bytes = input.implementation;
    return { schemaVersion: 1, kind: 'selected-js-ast-input-codec-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.lock.tools.find(pin => pin.path === 'prepare.mjs').sha256,
        consumer: input.lock.consumer, selectedCalls: input.lock.selectedCalls, sharedDependencies: input.lock.sharedDependencies,
        file: { path: OUTPUT, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) },
        backing: 'Original ByteArray reference; big-endian primitive reads with atomic exhaustion and checked seek.',
        utf8Policy: 'Existing pinned compilerUtf8String replacement-mode JVM grouping; no normalization.',
        javaFacadeIntroduced: false, consumerIntegrated: false, fullDeserializerBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareJsAstInput({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    await assertNoSymlink(outputRoot); const input = await inputs(sourceRoot);
    const filename = path.join(outputRoot, OUTPUT); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, input.implementation, { flag: 'wx', mode: 0o600 }); const receipt = receiptFor(input), receiptPath = path.join(outputRoot, 'js-ast-input-inputs.json');
    await writeJson(receiptPath, receipt); return { commonSources: [filename], replacedOriginalPaths: [], sharedDependencies: input.lock.sharedDependencies, receipt, receiptPath };
}
export async function verifyJsAstInput({ sourceRoot, outputRoot, receiptPath }) {
    const input = await inputs(sourceRoot), receipt = receiptFor(input); verifyFile(await readRegular(path.join(outputRoot, OUTPUT)), receipt.file);
    assert.deepEqual(JSON.parse(await readRegular(receiptPath)), receipt); return receipt;
}
