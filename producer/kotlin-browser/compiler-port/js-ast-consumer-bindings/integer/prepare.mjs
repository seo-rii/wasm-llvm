import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
export const DESERIALIZER = 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/serialization/JsIrAstDeserializer.kt';
export const OPERATIONS = 'compiler/frontend.common/src/org/jetbrains/kotlin/resolve/constants/evaluate/OperationsMapGenerated.kt';
export const INTEGER_IMPORT = 'import org.jetbrains.kotlin.js.util.AstInteger as BigInteger';

/** Guard actual selected sources, without mistaking an import flag for a source path. */
export async function guardSelectedIntegerConsumers(retainedSources) {
    assert(Array.isArray(retainedSources) && retainedSources.length > 0);
    assert.equal(new Set(retainedSources.map(item => relativePath(item.path))).size, retainedSources.length);
    const imports = [];
    for (const { path: sourcePath, filename } of retainedSources) {
        if (!sourcePath.endsWith('.kt')) continue;
        const bytes = await readRegular(filename); const text = bytes.toString();
        if (/\bjava\.math\.BigInteger\b/.test(text)) imports.push({ path: sourcePath, bytes: bytes.length, sha256: sha256(bytes) });
    }
    assert.deepEqual(imports.map(item => item.path).sort(), [DESERIALIZER, OPERATIONS].sort(), 'Changed selected JVM BigInteger consumer closure');
    return imports;
}

export async function prepareAstIntegerConsumer({ sourceRoot, outputRoot, retainedSources }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.kind, 'pinned-js-ast-signed-integer-consumer-binding');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const closureBytes = await readRegular(path.join(HERE, '../../closure.lock.json'));
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes); const originals = new Map();
    for (const pin of lock.sources) {
        assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path))), pin));
    }
    for (const pin of [...lock.astDependencies, ...lock.observers, ...lock.tools]) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const astLock = JSON.parse(verifyFile(await readRegular(path.join(HERE, lock.astSourceLock.path)), lock.astSourceLock));
    for (const pin of lock.astDependencies) assert(astLock.portable.some(item => item.sha256 === pin.sha256 && item.bytes === pin.bytes));
    const original = originals.get(DESERIALIZER); const text = original.toString();
    assert.equal(text.split('import java.math.BigInteger').length, 2);
    assert.equal(text.split('JsBigIntLiteral(BigInteger(readByteArray()))').length, 2);
    const bytes = Buffer.from(text.replace('import java.math.BigInteger', INTEGER_IMPORT));
    assert.equal(bytes.length, lock.prepared.bytes); assert.equal(sha256(bytes), lock.prepared.sha256);
    const selectedConsumers = retainedSources ? await guardSelectedIntegerConsumers(retainedSources) : null;
    const filename = path.join(outputRoot, 'compiler-port-js-ast-integer-consumer', DESERIALIZER);
    await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    for (const pin of lock.sources) assert.deepEqual(await readRegular(path.join(sourceRoot, pin.path)), originals.get(pin.path));
    const receipt = { schemaVersion: 1, kind: 'js-ast-signed-integer-consumer-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), primaryClosureSha256: lock.primaryClosureSha256,
        prepareToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), sources: lock.sources,
        astSourceLock: lock.astSourceLock, astDependencies: lock.astDependencies,
        file: { path: path.relative(outputRoot, filename), bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) },
        originalSourceUnmodified: true, transformation: 'Only genuine BigInteger import rebound to existing signed AstInteger',
        selectedConsumers, fullDeserializerBuilt: false, byteBufferPorted: false, fullCompilerBuilt: false, languageReadiness: false };
    const receiptPath = path.join(outputRoot, 'integer-consumer-inputs.json'); await writeJson(receiptPath, receipt);
    return { commonSources: [filename], replacedOriginalPaths: [DESERIALIZER], astDependencies: lock.astDependencies,
        receipt, receiptPath };
}
