import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { readSourceMapRuntimeLock, sourceMapRuntimeReceiptFor } from './prepare.mjs';
import { bindRuntime, bindConsumer, UTILS } from './transform.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOST_PATHS = ['compiler-port-entry/BrowserCompiler.kt', 'compiler-port-entry/BrowserCompilerPipeline.kt'];
const body = text => text.replace(/^import [^\r\n]+\r?\n/gm, '').split('\n').filter(line => line.trim()).join('\n');
const imports = text => [...text.matchAll(/^import ([^\r\n]+)\r?\n/gm)].map(match => match[1]);
const relevant = /\b(?:SourceMap|SourceMapParser|SourceMapLocationRemapper|SourceMapRuntime|requestSourceMapRuntime|installRequestSourceMapRuntime)\b/;

/** Late assembly validation; this is a conservative lexical closure, not a resolved IR call graph. */
export async function verifySourceMapRuntimeFinalSources({ profileRoot, sourceRoot, runtimeSourceRoot, sourceContentComponent,
    retainedSources, allowedAddedImports = [], allowedRequestHostSources = [] }) {
    profileRoot = path.resolve(profileRoot); await assertNoSymlink(profileRoot);
    assert(profileRoot.startsWith(path.join(REPO, 'out') + path.sep));
    const i = await readSourceMapRuntimeLock(), receiptPath = path.join(profileRoot, 'source-map-runtime-inputs.json');
    const receiptBytes = await readRegular(receiptPath), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.callerSnapshot.path, 'caller-snapshot.json');
    const snapshot = JSON.parse(verifyFile(await readRegular(path.join(profileRoot, receipt.callerSnapshot.path)), receipt.callerSnapshot));
    assert.deepEqual(snapshot.map(item => item.path), i.lock.callerClosure.map(pin => pin.path));
    const predecessorReceiptPath = path.resolve(sourceContentComponent.receiptPath), predecessorRoot = path.dirname(predecessorReceiptPath);
    assert.equal(sourceContentComponent.receiptPath, predecessorReceiptPath);
    assert.equal(predecessorReceiptPath, path.join(predecessorRoot, 'source-content-inputs.json')); await assertNoSymlink(predecessorRoot);
    const predecessorReceiptBytes = await readRegular(predecessorReceiptPath), predecessorReceipt = JSON.parse(predecessorReceiptBytes);
    assert.deepEqual(sourceContentComponent.receipt, predecessorReceipt);
    assert.deepEqual(sourceContentComponent.commonSources, predecessorReceipt.files.map(pin => path.join(predecessorRoot, pin.path)));
    assert.equal(predecessorReceipt.sourceLockSha256, i.lock.dependencies.find(pin => pin.path === '../js-ast-consumer-bindings/source-content/sources.lock.json').sha256);
    assert.deepEqual(predecessorReceipt.files.find(pin => pin.path === i.lock.predecessor.componentRelativePath), i.lock.predecessor.pin);
    const predecessorFilename = path.join(predecessorRoot, i.lock.predecessor.componentRelativePath);
    const predecessorBytes = verifyFile(await readRegular(predecessorFilename), i.lock.predecessor.pin);
    const binding = { component: i.lock.predecessor.component, componentRelativePath: i.lock.predecessor.componentRelativePath,
        filename: predecessorFilename, bytes: predecessorBytes.length, sha256: sha256(predecessorBytes), receiptPath: predecessorReceiptPath,
        receiptSha256: sha256(predecessorReceiptBytes), sourceLockSha256: predecessorReceipt.sourceLockSha256 };
    for (const [index, pin] of i.lock.callerClosure.entries()) {
        verifyFile(Buffer.from(snapshot[index].source, 'base64'), pin);
        assert.equal(snapshot[index].filename, pin.path === UTILS ? predecessorFilename : path.join(path.resolve(sourceRoot), pin.path));
    }
    const transformed = [];
    for (const pin of i.lock.sources) transformed.push(bindRuntime(pin.path, verifyFile(await readRegular(path.join(runtimeSourceRoot, pin.path)), pin)));
    transformed.push(bindConsumer(predecessorBytes));
    for (const [index, item] of transformed.entries()) verifyFile(item.bytes, i.lock.prepared[index]);
    assert.deepEqual(receipt, sourceMapRuntimeReceiptFor({ ...i, binding, transformed, callers: i.lock.selectedCallers, callerSnapshot: snapshot }));
    const helper = verifyFile(await readRegular(path.join(path.dirname(fileURLToPath(import.meta.url)), i.lock.runtime.path)), i.lock.runtime);
    const expected = new Map(receipt.files.map((pin, index) => [pin.path, { filename: path.join(profileRoot, pin.path),
        bytes: index < transformed.length ? transformed[index].bytes : helper }]));
    for (const pin of i.lock.callerClosure.filter(pin => i.lock.selectedCallers.includes(pin.path) && pin.path !== UTILS)) {
        const original = snapshot.find(item => item.path === pin.path);
        expected.set(pin.path, { filename: original.filename, bytes: Buffer.from(original.source, 'base64') });
    }
    assert(Array.isArray(allowedAddedImports) && new Set(allowedAddedImports).size === allowedAddedImports.length);
    for (const name of allowedAddedImports) assert(typeof name === 'string' && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\.\*)?(?: as [A-Za-z_]\w*)?$/.test(name));
    assert(Array.isArray(allowedRequestHostSources) && allowedRequestHostSources.length <= HOST_PATHS.length);
    for (const pin of allowedRequestHostSources) {
        assert(HOST_PATHS.includes(pin.path) && !expected.has(pin.path));
        assert(path.resolve(pin.filename).startsWith(path.join(REPO, 'out') + path.sep));
        const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        expected.set(pin.path, { filename: path.resolve(pin.filename), bytes });
    }
    assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 20000);
    const seen = new Set(), inspected = [], bindings = [], allowed = new Set(allowedAddedImports); let inspectedBytes = 0;
    for (const item of retainedSources) {
        if (item.compile === false) continue;
        assert(/^[A-Za-z0-9_./-]+\.kt$/.test(item.path) && !item.path.split('/').some(part => part === '..' || part === '.'));
        assert(!seen.has(item.path)); seen.add(item.path);
        const filename = path.resolve(item.filename); assert(filename.startsWith(path.join(REPO, 'out') + path.sep));
        const actual = await readRegular(filename); inspectedBytes += actual.length; assert(inspectedBytes <= 256 * 1024 * 1024);
        if (item.bytes !== undefined) assert.equal(actual.length, item.bytes);
        if (item.sha256 !== undefined) assert.equal(sha256(actual), item.sha256);
        inspected.push({ path: item.path, filename, bytes: actual.length, sha256: sha256(actual) });
        const canonical = expected.get(item.path);
        if (!canonical) { assert(!relevant.test(actual.toString()), 'Unexpected selected source-map runtime consumer: ' + item.path); continue; }
        assert.equal(filename, canonical.filename, 'Final source-map caller/output filename changed: ' + item.path);
        assert.equal(body(actual.toString()), body(canonical.bytes.toString()), 'Final source-map caller/output body changed: ' + item.path);
        const prior = imports(canonical.bytes.toString()), after = imports(actual.toString());
        assert.equal(new Set(after).size, after.length, 'Duplicate final source-map import');
        for (const name of prior) assert(after.includes(name), 'Canonical source-map import removed: ' + name);
        const addedImports = after.filter(name => !prior.includes(name));
        for (const name of addedImports) assert(allowed.has(name), 'Unknown added source-map import: ' + name);
        bindings.push({ path: item.path, filename, bytes: actual.length, sha256: sha256(actual), canonicalBytes: canonical.bytes.length,
            canonicalSha256: sha256(canonical.bytes), addedImports, source: actual.toString('base64') });
    }
    assert.deepEqual(bindings.map(item => item.path).sort(), [...expected.keys()].sort(), 'Missing final runtime outputs/callers');
    const finalRoot = path.join(profileRoot, 'final'); await assertNoSymlink(finalRoot); await mkdir(finalRoot, { recursive: true, mode: 0o700 });
    const finalReceipt = { schemaVersion: 1, kind: 'genuine-source-map-runtime-final-selection-guard', source: i.lock.source,
        preparationReceiptSha256: sha256(receiptBytes), sourceLockSha256: sha256(i.bytes), inspectedKotlinFiles: inspected.length, inspectedBytes,
        inspected, bindings, allowedAddedImports, allowedRequestHostSources,
        exactKnownGetJsCodeCallers: i.lock.selectedCallers, unexpectedRelevantConsumers: [],
        bodyComparison: 'Only import statements and assembly blank lines excluded; all canonical imports retained; unknown added imports rejected.',
        limitation: 'Exact five outputs and known three callers plus conservative source-map class/member lexical closure; unrelated getJsCode names are not resolved as typed calls.',
        originalGlobalStdoutParity: false, entryRuntimeInstalled: false, fullJsAstUtilsBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
    const finalReceiptPath = path.join(finalRoot, 'source-map-runtime-final.json'); await writeJson(finalReceiptPath, finalReceipt);
    return { receipt: finalReceipt, receiptPath: finalReceiptPath };
}
