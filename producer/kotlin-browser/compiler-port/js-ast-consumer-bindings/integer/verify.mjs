import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256, verifyFile } from '../../../scripts/source.mjs';
import { DESERIALIZER, INTEGER_IMPORT, guardSelectedIntegerConsumers } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function verifyAstIntegerConsumerPreparation({ sourceRoot, outputRoot, receiptPath, retainedSources }) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../../closure.lock.json'));
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes);
    for (const pin of lock.sources) {
        assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
        verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    }
    for (const pin of [...lock.astDependencies, ...lock.observers, ...lock.tools, lock.astSourceLock, lock.astEvidence]) {
        verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    }
    const bytes = Buffer.from((await readRegular(path.join(sourceRoot, DESERIALIZER))).toString().replace('import java.math.BigInteger', INTEGER_IMPORT));
    assert.equal(sha256(bytes), lock.prepared.sha256);
    const file = { path: 'compiler-port-js-ast-integer-consumer/' + DESERIALIZER, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) };
    assert.deepEqual(await readRegular(path.join(outputRoot, file.path)), bytes);
    const expected = { schemaVersion: 1, kind: 'js-ast-signed-integer-consumer-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), primaryClosureSha256: lock.primaryClosureSha256,
        prepareToolSha256: sha256(await readRegular(path.join(HERE, 'prepare.mjs'))), sources: lock.sources,
        astSourceLock: lock.astSourceLock, astDependencies: lock.astDependencies, file,
        originalSourceUnmodified: true, transformation: 'Only genuine BigInteger import rebound to existing signed AstInteger',
        selectedConsumers: retainedSources ? await guardSelectedIntegerConsumers(retainedSources) : null,
        fullDeserializerBuilt: false, byteBufferPorted: false, fullCompilerBuilt: false, languageReadiness: false };
    const receipt = JSON.parse(await readRegular(receiptPath)); assert.deepEqual(receipt, expected);
    return receipt;
}
