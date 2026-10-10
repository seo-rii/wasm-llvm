import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyEvidence } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(await readFile(path.join(HERE, 'evidence/receipt.json')));
test('Current source-bound evidence preserves its explicit profile limits', async () => {
    const result = await verifyEvidence(receipt);
    assert.equal(result.observations, 1041); assert.equal(result.fullCompilerBuilt, false);
    assert.equal(result.executionArtifactsVerified, false); assert.equal(result.retainedHostFactoryDifferences, 6);
});
test('Whole compiler and public readiness claims cannot be inferred from AST evidence', async () => {
    for (const field of ['fullCompilerBuilt', 'languageReadiness']) {
        await assert.rejects(verifyEvidence({ ...receipt, [field]: true }), { name: 'AssertionError' });
    }
});
test('Stale source and build-tool identities reject recorded success', async () => {
    for (const field of ['sourceLockSha256', 'checkToolSha256', 'buildFlagsSha256']) {
        await assert.rejects(verifyEvidence({ ...receipt, [field]: '0'.repeat(64) }), { name: 'AssertionError' });
    }
});
test('Preparation cannot falsely claim its own differential or lose shared input binding', async () => {
    for (const [field, value] of [['differentialValidated', true], ['commonDependencies', []], ['propertyAliasImports', []]]) {
        const changed = structuredClone(receipt); changed.preparation[field] = value;
        await assert.rejects(verifyEvidence(changed), { name: 'AssertionError' });
    }
});
test('Unrun host comparisons and a browser that fetched while offline reject', async () => {
    for (const field of ['originalJvmEqualsCommonJvm', 'originalJvmEqualsNodeWasm', 'originalJvmEqualsOfflineChromium']) {
        const changed = structuredClone(receipt); changed.comparison[field] = false;
        await assert.rejects(verifyEvidence(changed), { name: 'AssertionError' });
    }
    const changed = structuredClone(receipt); changed.browser.offlineRequests = ['js-ast.wasm'];
    await assert.rejects(verifyEvidence(changed), { name: 'AssertionError' });
});
