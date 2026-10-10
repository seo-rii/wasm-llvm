import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { prepareDiagnosticSourceDsl } from '../diagnostic-source-dsl/prepare.mjs';
import { frozenInputs } from '../k1-container-profile/check.mjs';
import { BACKEND, COMPONENT_PATH, PREDECESSOR_PATH, REPLACEMENTS, transformBackendExceptionText, rendererLambda } from './transform.mjs';
import { prepareBackendExceptionText, verifyBackendExceptionTextInputs, verifyBackendExceptionText } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
let fixturePromise;
async function base() {
    if (!fixturePromise) fixturePromise = (async () => {
        const parent = path.join(REPO, 'out/kotlin-backend-text-guards'); await mkdir(parent, { recursive: true });
        const root = await mkdtemp(path.join(parent, 'run-')), frozen = await frozenInputs();
        const preparedSourceDsl = await prepareDiagnosticSourceDsl({ sourceRoot, outputRoot: path.join(root, 'dsl'), retainedSources: frozen.retainedSources });
        return { sourceRoot, root, preparedSourceDsl };
    })();
    return fixturePromise;
}
async function fixture() {
    const input = await base(), root = await mkdtemp(path.join(input.root, 'case-'));
    const copied = path.join(root, 'predecessor'); await cp(path.dirname(input.preparedSourceDsl.receiptPath), copied, { recursive: true });
    const preparedSourceDsl = { ...input.preparedSourceDsl,
        receiptPath: path.join(copied, 'receipt.json'), receipt: JSON.parse(await readRegular(path.join(copied, 'receipt.json'))),
        commonSources: input.preparedSourceDsl.receipt.commonPaths.map(name => path.join(copied, name)) };
    return { sourceRoot, root, preparedSourceDsl, outputRoot: path.join(root, 'layer') };
}

test('verified canonical DSL variant retains six delegates and changes exactly two expressions', async () => {
    const input = await fixture(), canonical = await readRegular(input.preparedSourceDsl.commonSources.find(name => name.endsWith('/' + PREDECESSOR_PATH)));
    const result = await prepareBackendExceptionText(input), common = await readRegular(result.commonSources[0]);
    let expected = canonical.toString(); for (const [before, after] of REPLACEMENTS) expected = expected.replace(before, after);
    assert.equal(common.toString(), expected); assert.equal(sha256(rendererLambda(common)), lock.commonLambdaSha256);
    assert.equal(result.receipt.retainedSourceDslBindings.length, 6); assert.deepEqual(result.replacedPreparedPaths, [COMPONENT_PATH]);
    assert.deepEqual(result.replacedOriginalPaths, []); assert.equal(result.receipt.trapOrThrowableModelsAdded, false);
    await verifyBackendExceptionText({ ...input, profileRoot: input.outputRoot });
});

test('missing/duplicate selected predecessor component is rejected', async () => {
    const input = await fixture(); const filename = input.preparedSourceDsl.commonSources.find(name => name.endsWith('/' + PREDECESSOR_PATH));
    input.preparedSourceDsl.commonSources.push(filename); await assert.rejects(verifyBackendExceptionTextInputs(input), /exactly once/);
    input.preparedSourceDsl.commonSources = input.preparedSourceDsl.commonSources.filter(name => name !== filename);
    await assert.rejects(verifyBackendExceptionTextInputs(input), /exactly once/);
});

test('changed genuine renderer body or diagnostic delegate in prepared predecessor fails closed', async () => {
    for (const [before, after] of [['null reference access', 'changed explanation'], ['error1<String>()', 'error1<Int>()']]) {
        const input = await fixture(), filename = input.preparedSourceDsl.commonSources.find(name => name.endsWith('/' + PREDECESSOR_PATH));
        const text = (await readRegular(filename)).toString(); assert(text.includes(before)); await writeFile(filename, text.replace(before, after));
        await assert.rejects(verifyBackendExceptionTextInputs(input));
    }
});

test('late annotation import is refused as a canonical predecessor', async () => {
    const input = await fixture(), filename = input.preparedSourceDsl.commonSources.find(name => name.endsWith('/' + PREDECESSOR_PATH));
    const text = (await readRegular(filename)).toString(); await writeFile(filename, text.replace('package org.jetbrains.kotlin.backend.common\n', 'package org.jetbrains.kotlin.backend.common\nimport kotlin.jvm.*\n'));
    await assert.rejects(verifyBackendExceptionTextInputs(input));
});

test('stale or fabricated receipt object and disk changes cannot pass replay', async () => {
    const input = await fixture(); input.preparedSourceDsl.receipt.sourceLockSha256 = '0'.repeat(64);
    await assert.rejects(verifyBackendExceptionTextInputs(input), /object differs/);
    await writeFile(input.preparedSourceDsl.receiptPath, JSON.stringify(input.preparedSourceDsl.receipt));
    await assert.rejects(verifyBackendExceptionTextInputs(input));
});

test('changed original source pins, repeated transforms and additional expression sites are rejected', async () => {
    const input = await fixture(), copyRoot = path.join(input.root, 'original-copy'), original = await readRegular(path.join(sourceRoot, BACKEND));
    await mkdir(path.dirname(path.join(copyRoot, BACKEND)), { recursive: true }); await writeFile(path.join(copyRoot, BACKEND), Buffer.concat([original, Buffer.from('\n')]));
    await assert.rejects(verifyBackendExceptionTextInputs({ ...input, sourceRoot: copyRoot }), /Pinned source/);
    assert.throws(() => transformBackendExceptionText(transformBackendExceptionText(original)), /expression changed/);
    assert.throws(() => transformBackendExceptionText(Buffer.concat([original, Buffer.from('\n// StackOverflowError::class.java.name\n')])), /expression changed/);
});

test('output bytes and receipt claims cannot survive independent replay after tampering', async () => {
    const input = await fixture(), result = await prepareBackendExceptionText(input);
    const original = await readRegular(result.commonSources[0]);
    await writeFile(result.commonSources[0], Buffer.concat([original, Buffer.from('\n')]));
    await assert.rejects(verifyBackendExceptionText({ ...input, profileRoot: input.outputRoot }), /output changed/);
    await writeFile(result.commonSources[0], original);
    const receipt = JSON.parse(await readRegular(result.receiptPath)); receipt.languageReadiness = true; await writeFile(result.receiptPath, JSON.stringify(receipt));
    await assert.rejects(verifyBackendExceptionText({ ...input, profileRoot: input.outputRoot }), /receipt changed/);
});
