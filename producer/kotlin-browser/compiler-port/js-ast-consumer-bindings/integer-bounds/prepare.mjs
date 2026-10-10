import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { DESERIALIZER } from '../integer/prepare.mjs';
import { verifyAstIntegerConsumerPreparation } from '../integer/verify.mjs';
import { transformLengthBoundary } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');

const OUTPUT_PATH = 'compiler-port-js-ast-integer-bounds/' + DESERIALIZER;
async function inputs(sourceRoot, preparedInteger, retainedSources) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'pinned-js-ast-byte-length-boundary');
    assert.equal(sha256(await readRegular(path.join(HERE, '../../closure.lock.json'))), lock.primaryClosureSha256);
    const closure = JSON.parse(await readRegular(path.join(HERE, '../../closure.lock.json')));
    assert.deepEqual(lock.source, closure.source);
    for (const pin of lock.sources) assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
    for (const pin of [...lock.sources, ...lock.predecessor, ...lock.tools, ...lock.observers])
        verifyFile(await readRegular(path.join(lock.sources.includes(pin) ? sourceRoot : HERE, pin.path)), pin);
    assert(preparedInteger?.receiptPath && preparedInteger.commonSources?.length === 1);
    const filename = path.resolve(preparedInteger.commonSources[0]);
    assert(filename.startsWith(path.join(REPO, 'out') + path.sep));
    const outputRoot = filename.slice(0, -preparedInteger.receipt.file.path.length - 1);
    const receipt = await verifyAstIntegerConsumerPreparation({ sourceRoot, outputRoot, receiptPath: preparedInteger.receiptPath,
        retainedSources });
    assert.deepEqual(receipt, preparedInteger.receipt);
    const bytes = await readRegular(filename); assert.equal(sha256(bytes), lock.predecessorOutput.sha256);
    const receiptBytes = await readRegular(preparedInteger.receiptPath);
    const binding = { component: 'jsAstIntegerConsumerReceipt', logicalPath: 'compiler-port-js-ast-integer-consumer/' + DESERIALIZER, componentRelativePath: receipt.file.path,
        filename, bytes: bytes.length, sha256: sha256(bytes), receiptSha256: sha256(receiptBytes),
        sourceLockSha256: receipt.sourceLockSha256, preparationToolSha256: receipt.prepareToolSha256 };
    const transformed = transformLengthBoundary(bytes, lock.originalReadBytes);
    assert.equal(sha256(transformed), lock.output.sha256); assert.equal(transformed.length, lock.output.bytes);
    return { lock, lockBytes, receipt, binding, transformed };
}

function receiptFor(input) {
    return { schemaVersion: 1, kind: 'pinned-js-ast-byte-length-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.lock.tools.find(pin => pin.path === 'prepare.mjs').sha256,
        predecessorBindings: [input.binding], sourceFiles: input.lock.sources,
        file: { path: OUTPUT_PATH, ...input.lock.output }, resourceBound: 'Payload must fit in the already allocated input ByteArray; subtraction avoids offset+length overflow.',
        intentionalMalformedContractChange: 'Negative, overflow and truncated payload lengths throw IllegalArgumentException before transform/copy/allocation, leaving cursor after the prefix.',
        normalSerializedBytesChanged: false, integerBindingRetained: true, originalSourceUnmodified: true,
        fullDeserializerBuilt: false, byteBufferPorted: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareAstIntegerBounds({ sourceRoot, outputRoot, preparedInteger, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    for (const root of [sourceRoot, path.dirname(preparedInteger.receiptPath)])
        assert(root !== outputRoot && !root.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(root + path.sep));
    await assertNoSymlink(outputRoot); const input = await inputs(sourceRoot, preparedInteger, retainedSources);
    const filename = path.join(outputRoot, OUTPUT_PATH); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await assertNoSymlink(filename); await writeFile(filename, input.transformed, { flag: 'wx', mode: 0o600 });
    const receipt = receiptFor(input), receiptPath = path.join(outputRoot, 'integer-bounds-inputs.json'); await writeJson(receiptPath, receipt);
    return { commonSources: [filename], replacedOriginalPaths: ['compiler-port-js-ast-integer-consumer/' + DESERIALIZER], predecessorBindings: [input.binding], receipt, receiptPath };
}
export async function verifyAstIntegerBounds({ sourceRoot, outputRoot, preparedInteger, retainedSources, receiptPath }) {
    const input = await inputs(sourceRoot, preparedInteger, retainedSources);
    assert.deepEqual(await readRegular(path.join(outputRoot, OUTPUT_PATH)), input.transformed);
    const receipt = JSON.parse(await readRegular(receiptPath)); assert.deepEqual(receipt, receiptFor(input)); return receipt;
}
