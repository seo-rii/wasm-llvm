import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, responseBytes, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifySourceMapTree } from '../source-map-json/verify-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
async function inputs() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'request-source-map-text-io-protocol');
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.deepEqual(lock.source, closure.source); assert.equal(lock.primaryClosureSha256, sha256(closureBytes));
    assert.deepEqual(lock.jsTree, closure.treeSnapshots.find(pin => pin.path === 'js')); verifySourceMapTree(lock);
    assert.deepEqual(lock.sources.map(pin => path.basename(pin.path)), ['SourceMap.kt', 'SourceMapParser.kt', 'SourceMapLocationRemapper.kt']);
    for (const pin of [...lock.implementations, ...lock.tools, ...lock.observers, ...lock.dependencies])
        verifyFile(await readRegular(path.join(HERE, pin.path), pin.bytes), pin);
    const ast = JSON.parse(await readRegular(path.join(HERE, '../js-ast/sources.lock.json'))), reader = ast.portable.find(pin => pin.path.endsWith('/AstSourceReader.kt'));
    const stream = JSON.parse(await readRegular(path.join(HERE, '../js-ast-consumer-bindings/output-stream/sources.lock.json')));
    const text = JSON.parse(await readRegular(path.join(HERE, '../text/sources.lock.json')));
    assert.deepEqual(lock.sharedDependencies, [
        { component: 'jsAstReceipt', path: reader.outputPath, bytes: reader.bytes, sha256: reader.sha256, gitBlob: reader.gitBlob },
        { component: 'jsAstOutputStreamReceipt', path: 'compiler-port-js-ast-output-stream/org/jetbrains/kotlin/js/portable/JsAstStreamOutput.kt',
            bytes: stream.implementation.bytes, sha256: stream.implementation.sha256, gitBlob: stream.implementation.gitBlob },
        ...[text.generatedAlgorithm, text.api].map(pin => ({ component: 'textReceipt', path: 'compiler-port-text/' + pin.path, bytes: pin.bytes, sha256: pin.sha256 })) ]);
    assert.equal(lock.jdkReference.repository, 'https://github.com/openjdk/jdk17u.git');
    assert.equal(lock.jdkReference.commit, 'c35a8d5a87559ad2734f1023bb321176c13c7ba0');
    assert.equal(lock.jdkReference.tag, 'jdk-17.0.20.1+1');
    assert.deepEqual(lock.jdkReference.files.map(pin => path.basename(pin.path)), ['BufferedWriter.java', 'PrintStream.java', 'StreamEncoder.java', 'Writer.java']);
    for (const pin of lock.jdkReference.files) {
        const filename = path.join(REPO, 'out/kotlin-source-map-text-io/jdk-reference', path.basename(pin.path)); let bytes;
        try { bytes = await readRegular(filename, pin.bytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!bytes) {
            bytes = verifyFile(await responseBytes(`https://raw.githubusercontent.com/openjdk/jdk17u/${lock.jdkReference.commit}/${pin.path}`, pin.bytes, fetch), pin);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        }
        verifyFile(bytes, pin);
    }
    const referenceRoot = path.join(REPO, 'out/kotlin-source-map-text-io/reference'); await assertNoSymlink(referenceRoot);
    for (const pin of lock.sources) {
        const filename = path.join(referenceRoot, pin.path); let bytes;
        try { bytes = await readRegular(filename, pin.bytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!bytes) {
            bytes = verifyFile(await responseBytes(`https://raw.githubusercontent.com/JetBrains/kotlin/${lock.source.commit}/${pin.path}`, pin.bytes, fetch), pin);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        }
        verifyFile(bytes, pin);
    }
    return { lock, lockBytes };
}
function receiptFor(input) {
    return { schemaVersion: 1, kind: 'request-source-map-text-io-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), primaryClosureSha256: input.lock.primaryClosureSha256,
        preparationToolSha256: input.lock.tools.find(pin => pin.path === 'prepare.mjs').sha256,
        originalRuntimeReferences: input.lock.sources, rootedMembership: verifySourceMapTree(input.lock), jdkReference: input.lock.jdkReference,
        files: input.lock.implementations.map(pin => ({ path: pin.outputPath, bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob })),
        sharedDependencies: input.lock.sharedDependencies, textContract: 'Request-owned working byte files, UTF8 read snapshots, buffered character output and separately error-recording print output.',
        originalRuntimeSourcesCompiled: false, requestStdoutInstalled: false, javaFacadeIntroduced: false,
        differentialValidated: false, fullParserRuntimeBuilt: false, sourceMapBuilderBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareSourceMapTextIo({ outputRoot }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(outputRoot); const input = await inputs(), receipt = receiptFor(input), commonSources = [];
    for (const pin of input.lock.implementations) {
        const filename = path.join(outputRoot, pin.outputPath); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, verifyFile(await readRegular(path.join(HERE, pin.path)), pin), { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'source-map-text-io-inputs.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: [], sharedDependencies: input.lock.sharedDependencies, receipt, receiptPath };
}
export async function verifySourceMapTextIo({ outputRoot, receiptPath }) {
    const input = await inputs(), receipt = receiptFor(input);
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin);
    assert.deepEqual(JSON.parse(await readRegular(receiptPath)), receipt); return receipt;
}
