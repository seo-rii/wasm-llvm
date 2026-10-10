import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyDiagnosticSourceDsl } from '../diagnostic-source-dsl/prepare.mjs';
import { BACKEND, PREDECESSOR_PATH, COMPONENT_PATH, REPLACEMENTS, transformBackendExceptionText, rendererLambda } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');

async function inputs({ sourceRoot, preparedSourceDsl }) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.kind, 'backend-diagnostic-jvm-exception-name-string-protocol');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(lock.original.path, BACKEND); assert.deepEqual(lock.replacements, REPLACEMENTS);
    assert.equal(sha256(await readRegular(path.join(HERE, 'transform.mjs'))), lock.transformSha256);
    const primary = await readRegular(path.join(HERE, '../closure.lock.json'));
    assert.equal(sha256(primary), lock.primaryClosureSha256);
    assert.deepEqual(lock.original, JSON.parse(primary).files.find(pin => pin.path === BACKEND));
    const original = verifyFile(await readRegular(path.join(path.resolve(sourceRoot), BACKEND)), lock.original);
    const sourceDslBytes = await readRegular(path.join(HERE, lock.predecessor.sourceLockPath));
    assert.equal(sha256(sourceDslBytes), lock.predecessor.sourceLockSha256);
    assert.deepEqual(JSON.parse(sourceDslBytes).source, lock.source);
    for (const pin of lock.predecessor.tools) {
        const bytes = await readRegular(path.join(HERE, '../diagnostic-source-dsl', pin.path));
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Source DSL tool changed');
    }
    assert(preparedSourceDsl?.receiptPath && preparedSourceDsl.commonSources && preparedSourceDsl.receipt, 'Genuine source DSL predecessor required');
    const checked = await verifyDiagnosticSourceDsl(path.dirname(preparedSourceDsl.receiptPath));
    assert.deepEqual(checked.receipt, preparedSourceDsl.receipt, 'Source DSL object differs from on-disk receipt');
    assert.equal(checked.receipt.sourceLockSha256, lock.predecessor.sourceLockSha256);
    assert.deepEqual(checked.receipt.tools, lock.predecessor.tools);
    const declared = checked.receipt.outputs.find(pin => pin.path === PREDECESSOR_PATH);
    assert.deepEqual(declared, lock.predecessor.output, 'Source DSL canonical backend variant changed');
    assert.equal(declared.bindings.length, 6, 'Source DSL six genuine diagnostic delegates required');
    const selected = preparedSourceDsl.commonSources.filter(filename => filename.endsWith('/' + PREDECESSOR_PATH));
    assert.equal(selected.length, 1, 'Source DSL backend variant must occur exactly once');
    const filename = path.resolve(selected[0]), bytes = await readRegular(filename);
    assert.equal(bytes.length, declared.bytes); assert.equal(sha256(bytes), declared.sha256, 'Prepared canonical backend bytes changed');
    assert.equal(sha256(rendererLambda(bytes)), lock.originalLambdaSha256, 'Predecessor altered actual renderer body');
    return { lock, lockBytes, original, bytes, binding: { filename, logicalPath: COMPONENT_PATH, predecessorRelativePath: PREDECESSOR_PATH,
        bytes: bytes.length, sha256: sha256(bytes), receiptSha256: checked.receiptSha256,
        sourceLockSha256: lock.predecessor.sourceLockSha256, tools: lock.predecessor.tools } };
}

function makeReceipt(input, toolHash) {
    const common = transformBackendExceptionText(input.bytes);
    assert.equal(common.length, input.lock.preparedBytes); assert.equal(sha256(common), input.lock.preparedSha256);
    return { schemaVersion: 1, kind: 'backend-diagnostic-exception-name-text-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolHash,
        transformSha256: input.lock.transformSha256, original: input.lock.original, predecessorBinding: input.binding,
        files: [{ path: COMPONENT_PATH, bytes: common.length, sha256: sha256(common) }], replacedPreparedPaths: [COMPONENT_PATH], replacements: REPLACEMENTS,
        retainedSourceDslBindings: input.lock.predecessor.output.bindings, originalLambdaSha256: input.lock.originalLambdaSha256,
        commonLambdaSha256: sha256(rendererLambda(common)), exceptionNameProtocol: 'Existing exact JVM-qualified name String, with message branch preceding exception-name matching',
        throwableToProtocolGenerator: 'separate, not changed or verified here', trapOrThrowableModelsAdded: false,
        fullDiagnosticTableWasmExecution: false, fullCompilerBuilt: false, languageReadiness: false };
}

export async function prepareBackendExceptionText(options) {
    const input = await inputs(options), outputRoot = path.resolve(options.outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    for (const root of [path.resolve(options.sourceRoot), path.dirname(options.preparedSourceDsl.receiptPath)])
        assert(outputRoot !== root && !outputRoot.startsWith(root + path.sep) && !root.startsWith(outputRoot + path.sep), 'Backend text input/output overlap');
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const common = transformBackendExceptionText(input.bytes);
    const receipt = makeReceipt(input, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const filename = path.join(outputRoot, COMPONENT_PATH); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, common, { flag: 'wx', mode: 0o600 });
    const reference = path.join(outputRoot, 'reference-original', BACKEND); await mkdir(path.dirname(reference), { recursive: true, mode: 0o700 });
    await writeFile(reference, input.original, { flag: 'wx', mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources: [filename], replacedOriginalPaths: [], replacedPreparedPaths: [COMPONENT_PATH], predecessorBindings: [input.binding], receipt, receiptPath };
}

export async function verifyBackendExceptionTextInputs(options) { return inputs(options); }

export async function verifyBackendExceptionText({ sourceRoot, preparedSourceDsl, profileRoot }) {
    const input = await inputs({ sourceRoot, preparedSourceDsl }); profileRoot = path.resolve(profileRoot);
    const receiptBytes = await readRegular(path.join(profileRoot, 'receipt.json')), receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt, makeReceipt(input, sha256(await readRegular(fileURLToPath(import.meta.url)))), 'Backend exception text receipt changed');
    assert.deepEqual(await readRegular(path.join(profileRoot, COMPONENT_PATH)), transformBackendExceptionText(input.bytes), 'Backend exception text output changed');
    assert.deepEqual(await readRegular(path.join(profileRoot, 'reference-original', BACKEND)), input.original, 'Backend original reference changed');
    return { receipt, receiptSha256: sha256(receiptBytes), replacedPreparedPaths: [COMPONENT_PATH] };
}
