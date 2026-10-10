#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256 } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

/** Validate source binding; optionally re-hash the retained concrete executions. */
export async function verifyEvidence(receipt, { artifactRoot } = {}) {
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'official-fir-serial-storage-differential');
    assert.equal(receipt.status, 'passed');
    assert.deepEqual(receipt.source, lock.source);
    assert.equal(receipt.sourceLockSha256, sha256(lockBytes));
    assert.equal(receipt.sourceClosureLockSha256, lock.sourceClosureLockSha256);
    assert.deepEqual(receipt.sources, lock.sources);
    assert.deepEqual(receipt.referenceDependencies, lock.referenceDependencies);
    assert.deepEqual(receipt.observers, lock.observers);
    for (const pin of [lock.adapter, lock.patch, lock.generator, ...lock.observers]) {
        const bytes = await readRegular(path.join(here, relativePath(pin.path)));
        if (pin.bytes !== undefined) assert.equal(bytes.length, pin.bytes);
        assert.equal(sha256(bytes), pin.sha256);
    }
    assert.equal(receipt.checkToolSha256, sha256(await readRegular(path.join(here, 'check.mjs'))));
    assert.equal(receipt.prepareToolSha256, sha256(await readRegular(path.join(here, 'prepare.mjs'))));
    assert.equal(receipt.buildFlagsSha256, sha256(await readRegular(path.join(here, '../build-flags.json'))));
    assert(receipt.observations.length >= 50 && receipt.observations.every(value => typeof value === 'string' && value.endsWith(':ok')));
    assert.equal(new Set(receipt.observations).size, receipt.observations.length);
    assert.deepEqual(receipt.comparison, {
        required: receipt.observations.length, passed: receipt.observations.length,
        failed: 0, skipped: 0, notRun: 0, originalJvmEqualsCommonJvm: true, originalJvmEqualsWasm: true,
    });
    assert.equal(receipt.commands.length, 7);
    assert(receipt.commands.every(command => command.exitCode === 0));
    assert.equal(receipt.traversal.fullFirExecution, false);
    assert.equal(receipt.traversal.sha256, lock.traversal.sha256);
    assert.equal(receipt.traversal.substitutions.length, 4);
    for (const kind of ['originalJvm', 'commonJvm', 'wasmJs']) assert.equal(receipt.rawTraversal[kind].length, 2);
    assert.equal(receipt.browserExecution, 'not-run');
    assert.equal(receipt.browserCompilerBuilt, false);
    assert.equal(receipt.readiness, false);
    assert(receipt.outputs.length >= 7);
    assert.equal(new Set(receipt.outputs.map(pin => relativePath(pin.path))).size, receipt.outputs.length);
    if (artifactRoot) {
        artifactRoot = path.resolve(artifactRoot);
        assert(artifactRoot.startsWith(path.join(repository, 'out') + path.sep));
        await assertNoSymlink(artifactRoot);
        for (const pin of receipt.outputs) {
            const bytes = await readRegular(path.join(artifactRoot, relativePath(pin.path)));
            assert.equal(bytes.length, pin.bytes);
            assert.equal(sha256(bytes), pin.sha256, 'Changed execution artifact: ' + pin.path);
        }
    }
    return { comparison: receipt.comparison, artifactsVerified: !!artifactRoot, browserCompilerBuilt: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 2 && args[0] === '--artifacts'), 'Expected optional --artifacts <retained-output>');
    const receipt = JSON.parse(await readRegular(path.join(here, 'evidence/fir-storage-differential.json')));
    console.log(JSON.stringify(await verifyEvidence(receipt, { artifactRoot: args[1] })));
}
