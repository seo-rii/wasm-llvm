#!/usr/bin/env node
/** Seals self-contained actual identity receipts without recompiling or changing source. */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const options = {}; const references = []; const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
    assert(['--output-root', '--index-reference-root'].includes(args[index]) && args[index + 1], 'Invalid identity seal option');
    const filename = path.resolve(args[index + 1]); assert(filename.startsWith(path.join(REPO, 'out') + path.sep));
    if (args[index] === '--index-reference-root') references.push(filename);
    else { assert(!options.outputRoot); options.outputRoot = filename; }
}
assert(options.outputRoot);
const root = options.outputRoot;
const browserBytes = await readRegular(path.join(root, 'browser-receipt.json'));
const browser = JSON.parse(browserBytes); assert.equal(browser.result, 'pass');
const buildBytes = await readRegular(path.join(root, 'differential-receipt.json'));
const build = JSON.parse(buildBytes); assert.equal(sha256(buildBytes), browser.buildReceiptSha256);
assert.equal(browser.sourceLockSha256, sha256(await readRegular(path.join(HERE, 'sources.lock.json'))));
assert.equal(browser.preparation.preparationToolSha256, sha256(await readRegular(path.join(HERE, 'prepare.mjs'))));
assert.equal(browser.buildVerificationToolSha256, sha256(await readRegular(path.join(HERE, 'build-probe.mjs'))));
assert.equal(browser.browserVerificationToolSha256, sha256(await readRegular(path.join(HERE, 'browser-probe.mjs'))));
assert.equal(build.hashReferenceLockSha256, sha256(await readRegular(path.join(HERE, 'hash-references.lock.json'))));
assert.equal(build.hashAndAttributes.result, 'pass'); assert.equal(build.hashAndAttributes.notRun, 0);
const guardBytes = await readRegular(path.join(root, 'integrity-guards.json')); const guards = JSON.parse(guardBytes);
assert.equal(guards.result, 'pass'); assert.equal(guards.sourceLockSha256, browser.sourceLockSha256);
assert.equal(guards.testSourceSha256, sha256(await readRegular(path.join(HERE, 'integrity.test.mjs'))));
const guardOutput = await readRegular(path.join(root, 'integrity-guards.txt'));
assert.equal(guards.output.bytes, guardOutput.length); assert.equal(guards.output.sha256, sha256(guardOutput));
const referenceChain = []; let current = build;
for (const directory of references) {
    assert(current.indexReuse, 'A reference receipt was supplied without a reuse edge');
    const bytes = await readRegular(path.join(directory, 'differential-receipt.json')); const reference = JSON.parse(bytes);
    assert.equal(sha256(bytes), current.indexReuse.receiptSha256);
    assert.equal(reference.result, 'index-pass'); assert.equal(reference.comparison.failed, 0);
    assert.deepEqual(reference.preparation.sourceFiles, browser.preparation.sourceFiles);
    assert.deepEqual(reference.preparation.adapter, browser.preparation.adapter);
    assert.deepEqual(reference.preparation.patch, browser.preparation.patch);
    assert.equal(reference.sourceBuildFlagsSha256, build.sourceBuildFlagsSha256);
    assert.deepEqual(reference.bootstrap.artifacts, browser.bootstrap.artifacts);
    for (const pin of reference.observerSources.filter(pin => pin.path !== 'HashProbe.kt')) {
        assert.equal(sha256(await readRegular(path.join(HERE, pin.path))), pin.sha256);
    }
    referenceChain.push({ receiptSha256: sha256(bytes), sourceLockSha256: reference.sourceLockSha256,
        verificationToolSha256: reference.verificationToolSha256, sourceBuildFlagsSha256: reference.sourceBuildFlagsSha256,
        indexObservationSha256: reference.comparison.originalSha256,
        actualIndexCommands: reference.commands.filter(item => !item.phase.includes('hash-attribute') && !item.phase.includes('type-and-attribute')),
        parentIndexReceiptSha256: reference.indexReuse?.receiptSha256 ?? null,
        unchangedProductionIndexSourcesVerified: true, unchangedIndexObserversVerified: true,
        helperSourceEqualityToSelectedCommit: 'unproved bootstrap reference' });
    current = reference;
}
assert.equal(current.indexReuse ?? null, null, 'All index reference receipt edges must be supplied');
assert(referenceChain.at(-1).actualIndexCommands.some(item => item.phase === 'portable-index-wasmjs-binary-build'));
const receipt = { ...browser,
    kind: 'official-compiler-reference-identity-source-and-browser-differential',
    rawBrowserReceiptSha256: sha256(browserBytes), rawBuildReceiptSha256: sha256(buildBytes),
    sealingToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), sourceBuildFlagsSha256: build.sourceBuildFlagsSha256,
    hashReferences: build.hashReferences, hashReferenceLockSha256: build.hashReferenceLockSha256,
    indexReferenceExecutionChain: referenceChain, guards,
    scopes: { indexOriginalJvmPortableJvmBrowserWasm: { required: browser.comparison.required, passed: browser.comparison.passed,
            failed: browser.comparison.failed, notRun: browser.comparison.notRun },
        selectedTypeAndAttributeOriginalPortableJvm: { required: build.hashAndAttributes.required, passed: build.hashAndAttributes.passed,
            failed: build.hashAndAttributes.failed, notRun: build.hashAndAttributes.notRun },
        selectedTypeAndAttributeWasm: { result: 'not-run', requiredSourceGroups: build.hashAndAttributes.files.length, notRun: build.hashAndAttributes.files.length },
        fullWasmSerializerAndFragment: { result: 'not-run', requiredSourceGroups: 2, notRun: 2 },
        browserCompiler: { result: 'not-built', readiness: false } },
    host: { os: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? null, ramBytes: os.totalmem() },
    verificationHistory: [
        { phase: 'first original type-source reference', result: 'not-run', reason: 'Real sealed ConeTypeProjection sibling and current two-argument IR factory API were required; observer corrected.' },
        { phase: 'second original type-source reference', result: 'not-run', reason: 'Real ConeClassifierLookupTag must be compiled beside the selected sealed marker; exact unchanged ConeLookupTags source added to reference only.' },
        { phase: 'first Chromium launch', result: 'failed-before-probe', reason: 'Disk had zero free bytes; Chromium startup exited with SIGTRAP before the Worker or Wasm unit initialized.' },
        { phase: 'guard fixture setup during disk exhaustion', result: 'failed-before-guards', reason: 'Temporary directory construction failed; guards passed after task-owned failed-build source copies were removed.' },
    ],
    limitations: [...browser.limitations,
        'Remaining whole-file host calls reported by actual C assembly include ConeTypes javaClass comparisons and Wasm fragment putIfAbsent/computeIfAbsent, in addition to serializer Java I/O.',
        'The actual WasmSerializer and WasmCompiledModuleFragment source substitutions are pinned, but these full classes were not independently executed by this unit corpus.'] };
const destination = path.join(HERE, 'evidence/original-common-differential.json'); await writeJson(destination, receipt);
console.log(JSON.stringify({ destination, result: receipt.result, indexCases: receipt.comparison.passed,
    hashAndAttributesJvmCases: receipt.hashAndAttributes.passed, guards: guards.passed, readiness: false }));
