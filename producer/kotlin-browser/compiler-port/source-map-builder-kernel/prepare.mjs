import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { adaptKotlin } from '../js-ast/adapt.mjs';
import { BUILDER, CONSUMER, PREFIX, bindSourceMapBuilder } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export async function builderSharedDependencies(sourceRoot) {
    const ast = JSON.parse(await readRegular(path.join(HERE, '../js-ast/sources.lock.json')));
    const pins = [];
    for (const pin of ast.sources.filter(pin => pin.language === 'kotlin')) {
        const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
        const bytes = adaptKotlin(pin.path, original).bytes;
        pins.push({ component: 'jsAstReceipt', path: pin.path, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
    }
    pins.push(...ast.portable.map(pin => ({ component: 'jsAstReceipt', path: pin.outputPath, bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob })));
    const json = JSON.parse(await readRegular(path.join(HERE, '../source-map-json/sources.lock.json')));
    pins.push(...json.prepared.map(pin => ({ component: 'sourceMapJsonReceipt', path: pin.path, bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob })));
    const io = JSON.parse(await readRegular(path.join(HERE, '../source-map-text-io/sources.lock.json')));
    pins.push(...io.implementations.map(pin => ({ component: 'sourceMapTextIoReceipt', path: pin.outputPath, bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob })));
    pins.push(...io.sharedDependencies.filter(pin => pin.component !== 'jsAstReceipt'));
    for (const pin of ast.commonDependencies) pins.push({ component: pin.path.includes('/collections/') ? 'collectionsReceipt' : 'assertionReceipt',
        path: pin.path.includes('/collections/') ? 'compiler-port-collections/SmartList.kt' : 'compiler-port-assertions/CompilerAssertions.kt',
        bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob });
    assert.equal(new Set(pins.map(pin => pin.path)).size, pins.length);
    return pins;
}
export async function readSourceMapBuilderLock(sourceRoot) {
    const bytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(bytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'genuine-source-map-builder-kernel');
    assert.deepEqual(lock.source, closure.source); assert.equal(lock.primaryClosureSha256, sha256(closureBytes));
    assert.deepEqual(lock.sources, [BUILDER, CONSUMER].map(name => closure.files.find(pin => pin.path === name)));
    for (const pin of [...lock.tools, ...lock.observers, ...lock.dependencies, lock.host]) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    for (const pin of lock.referenceDependencies) assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
    assert.deepEqual(lock.sharedDependencies, await builderSharedDependencies(sourceRoot));
    for (const field of ['callerIntegrated','fullCompilerBuilt','languageReadiness']) assert.equal(lock[field], false);
    assert.equal(lock.identityContract, 'Stable equals/hashCode; no arbitrary effectful hash evaluation-count parity.');
    return { bytes, lock };
}
async function inputs(sourceRoot) {
    const i = await readSourceMapBuilderLock(sourceRoot), transformed = [];
    for (const pin of i.lock.sources) transformed.push(bindSourceMapBuilder(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)));
    for (const [index, value] of transformed.entries()) verifyFile(value.bytes, i.lock.prepared[index]);
    return { ...i, transformed };
}
function receiptFor(i) {
    return { schemaVersion: 1, kind: 'genuine-source-map-builder-kernel-preparation', source: i.lock.source,
        sourceLockSha256: sha256(i.bytes), primaryClosureSha256: i.lock.primaryClosureSha256,
        preparationToolSha256: i.lock.tools.find(pin => pin.path === 'prepare.mjs').sha256,
        originalInputs: i.lock.sources, tools: i.lock.tools, sharedDependencies: i.lock.sharedDependencies,
        files: [...i.lock.prepared.map((pin, index) => ({ ...pin, changes: i.transformed[index].changes })), i.lock.hostOutput],
        identityContract: i.lock.identityContract,
        hostContract: 'Explicit optional generated filename, request separator, nullable real AST reader supplier and mandatory banner/throwable diagnostics; builder owns reader close only.',
        originalSourceUnmodified: true, originalMethodsRemoved: false, javaFacadeIntroduced: false,
        differentialValidated: false, nativeStacktraceTextParity: false, callerIntegrated: false,
        pathResolverBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
}
function roots(sourceRoot, outputRoot) {
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
}
export async function prepareSourceMapBuilder({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const i = await inputs(sourceRoot), receipt = receiptFor(i), commonSources = [];
    const buffers = [...i.transformed.map(value => value.bytes), verifyFile(await readRegular(path.join(HERE, i.lock.host.path)), i.lock.host)];
    for (const [index, pin] of receipt.files.entries()) {
        const filename = path.join(outputRoot, relativePath(pin.path)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, buffers[index], { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'source-map-builder-kernel-inputs.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: [BUILDER, CONSUMER], sharedDependencies: receipt.sharedDependencies, receipt, receiptPath };
}
export async function verifySourceMapBuilder({ sourceRoot, outputRoot, receiptPath }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const i = await inputs(sourceRoot), receipt = receiptFor(i);
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, relativePath(pin.path))), pin);
    assert.equal(path.resolve(receiptPath), path.join(outputRoot, 'source-map-builder-kernel-inputs.json'));
    assert.deepEqual(JSON.parse(await readRegular(receiptPath)), receipt); return receipt;
}
