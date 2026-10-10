#!/usr/bin/env node
/** Verify current source bindings and, optionally, every retained execution artifact. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { adaptKotlin } from './adapt.mjs';
import { verifyJsAstPreparation } from './prepare.mjs';
import { verifyNumberSources } from './numbers/build-probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const SOURCE = path.join(REPO, 'out/kotlin-compiler-port/sources');
const phases = ['extract-verified-host-dependencies', 'actual-original-mixed-kotlin-build', 'actual-original-java-build',
    'portable-common-jvm-build', 'actual-original-jvm-observe', 'portable-common-jvm-observe',
    'portable-common-wasmjs-klib', 'portable-common-wasmjs-module', 'portable-node-wasmjs-observe'];

export async function verifyEvidence(receipt, { artifactRoot } = {}) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'pinned-full-js-ast-original-jvm-common-wasm-differential');
    assert.deepEqual(receipt.source, lock.source);
    assert.equal(receipt.sourceLockSha256, sha256(lockBytes));
    assert.equal(receipt.checkToolSha256, sha256(await readRegular(path.join(HERE, 'check.mjs'))));
    assert.equal(receipt.buildFlagsSha256, sha256(await readRegular(path.join(HERE, '../build-flags.json'))));
    const integrity = JSON.parse(await readRegular(path.join(HERE, 'evidence/integrity.json')));
    assert.equal(integrity.schemaVersion, 1); assert.equal(integrity.kind, 'js-ast-preparation-integrity');
    assert.equal(integrity.sourceLockSha256, sha256(lockBytes));
    assert.equal(integrity.prepareToolSha256, sha256(await readRegular(path.join(HERE, 'prepare.mjs'))));
    assert.equal(integrity.testToolSha256, sha256(await readRegular(path.join(HERE, 'integrity.test.mjs'))));
    assert.deepEqual([integrity.passed, integrity.failed, integrity.skipped, integrity.exitCode], [8, 0, 0, 0]);
    assert.equal(integrity.fullCompilerBuilt, false); assert.equal(integrity.languageReadiness, false);
    assert.equal(receipt.fullCompilerBuilt, false); assert.equal(receipt.languageReadiness, false);
    assert.equal(lock.browserCompilerBuilt, false); assert.equal(lock.languageReadiness, false);
    assert.equal(lock.sources.length, 107); assert.equal(lock.portable.length, 69);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json'));
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes);
    assert.deepEqual(lock.sources, closure.files.filter(pin => pin.path.startsWith('js/js.ast/src/')));
    for (const pin of [...lock.sources, ...lock.referenceDependencies]) {
        assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
        verifyFile(await readRegular(path.join(SOURCE, relativePath(pin.path))), pin);
    }
    for (const pin of [...lock.portable, ...lock.tools, ...lock.commonDependencies, ...lock.licenses, ...lock.observers,
        lock.characterPolicy, lock.numberBoundary.sourceLock, lock.numberBoundary.evidence]) {
        verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    }
    await verifyNumberSources();
    const bootstrap = await verifyBootstrap();
    assert.deepEqual(receipt.bootstrap, { version: bootstrap.lock.version,
        artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) });
    const preparation = receipt.preparation;
    assert.equal(preparation.schemaVersion, 1);
    assert.equal(preparation.kind, 'official-java-js-ast-source-preparation');
    assert.deepEqual(preparation.source, lock.source);
    assert.equal(preparation.sourceLockSha256, sha256(lockBytes));
    assert.equal(preparation.primaryClosureSha256, lock.primaryClosureSha256);
    assert.equal(preparation.preparationToolSha256, sha256(await readRegular(path.join(HERE, 'prepare.mjs'))));
    for (const [field, expected] of Object.entries({ sourceFiles: lock.sources, portableFiles: lock.portable,
        characterPolicy: lock.characterPolicy, numberBoundary: lock.numberBoundary, licenses: lock.licenses, tools: lock.tools,
        commonDependencies: lock.commonDependencies.map(pin => ({ ...pin, filename: path.join(HERE, pin.path) })) })) {
        assert.deepEqual(preparation[field], expected);
    }
    for (const field of ['completeCompilerBuilt', 'differentialValidated', 'languageReadiness']) assert.equal(preparation[field], false);
    assert.equal(preparation.originalSourceUnmodified, true);
    const propertiesPin = lock.portable.find(pin => pin.path.endsWith('/JavaProperties.kt'));
    const properties = (await readRegular(path.join(HERE, propertiesPin.path))).toString();
    const names = new Set([...properties.matchAll(/^(?:var|val)\s+\w+\.(\w+):/gm)].map(match => match[1]));
    for (const name of ['currentNode', 'replaceMe', 'addPrevious']) names.add(name);
    assert.equal(names.size, 69);
    assert.deepEqual(preparation.propertyAliasImports, [...names].sort().map(name => 'org.jetbrains.kotlin.js.backend.ast.' + name)
        .concat(['org.jetbrains.kotlin.js.util.position', 'org.jetbrains.kotlin.js.util.line', 'org.jetbrains.kotlin.js.util.column']));
    const expectedFiles = [];
    for (const pin of lock.sources.filter(pin => pin.language === 'kotlin')) {
        const adapted = adaptKotlin(pin.path, await readRegular(path.join(SOURCE, pin.path)));
        expectedFiles.push({ path: pin.path, bytes: adapted.bytes.length, sha256: sha256(adapted.bytes), gitBlob: gitBlob(adapted.bytes),
            originalPath: pin.path, originalSha256: pin.sha256, transformations: adapted.transformations });
    }
    for (const pin of lock.portable) expectedFiles.push({ path: pin.outputPath, bytes: pin.bytes, sha256: pin.sha256,
        gitBlob: pin.gitBlob, originalPath: pin.originalPath, implementationPath: pin.path });
    assert.deepEqual(preparation.files, JSON.parse(JSON.stringify(expectedFiles)));
    assert.equal(receipt.observers.length, lock.observers.length);
    assert.deepEqual(receipt.observers.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 })),
        lock.observers.map(({ path: name, bytes, sha256 }) => ({ path: 'observers/' + name, bytes, sha256 })));
    assert.deepEqual(receipt.originalInputs.map(({ originalPath, originalSha256 }) => ({ originalPath, originalSha256 })),
        lock.sources.map(pin => ({ originalPath: pin.path, originalSha256: pin.sha256 })));
    assert.deepEqual(receipt.commands.map(command => command.phase), phases);
    assert(receipt.commands.every(command => command.exitCode === 0));
    assert.equal(receipt.dependencies.compilerAstClassesExtracted, false);
    assert(receipt.dependencies.classes.length > 0 && receipt.dependencies.classes.every(pin =>
        /^org\/jetbrains\/kotlin\/(com\/intellij\/|it\/unimi\/dsi\/fastutil\/)/.test(relativePath(pin.path))));
    for (const phase of ['actual-original-jvm-observe', 'portable-common-jvm-observe']) {
        const command = receipt.commands.find(item => item.phase === phase).command;
        assert.equal(command[0], 'java'); assert.equal(command[1], '-ea');
        const classpath = command[command.indexOf('-cp') + 1].split(path.delimiter);
        assert(!classpath.includes(bootstrap.artifacts.find(item => item.id === 'compiler').path));
        assert.equal(classpath.length, phase.startsWith('actual') ? 4 : 2);
        assert.equal(command.at(-1), 'org.jetbrains.kotlin.js.astprobe.JvmEntryKt');
    }
    const comparison = receipt.comparison;
    assert(Number.isSafeInteger(comparison.observations) && comparison.observations >= 1000);
    assert.deepEqual(comparison, { observations: comparison.observations, originalJvmEqualsCommonJvm: true,
        originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true, skipped: 0,
        successfulAndFailureCategoryRecordsSha256: comparison.successfulAndFailureCategoryRecordsSha256 });
    assert(/^[a-f0-9]{64}$/.test(comparison.successfulAndFailureCategoryRecordsSha256));
    assert.equal(receipt.browser.engine, 'Chromium'); assert.equal(receipt.browser.moduleWorker, true);
    assert.equal(receipt.browser.offlineAfterInitialization, true);
    for (const field of ['externalRequests', 'offlineRequests', 'pageErrors']) assert.deepEqual(receipt.browser[field], []);
    assert.equal(receipt.browser.recordsSha256, comparison.successfulAndFailureCategoryRecordsSha256);
    assert.equal(new Set(receipt.outputs.map(pin => relativePath(pin.path))).size, receipt.outputs.length);
    assert(receipt.outputs.some(pin => pin.path === 'wasm/js-ast.wasm'));
    for (const filename of ['original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json', 'portable-chromium.json',
        ...preparation.files.map(pin => 'common/' + pin.path)]) assert(receipt.outputs.some(pin => pin.path === filename));
    const negative = JSON.parse(await readRegular(path.join(HERE, 'evidence/host-list-factory-negative.json')));
    assert.equal(negative.kind, 'retained-negative-host-list-factory-differential'); assert.equal(negative.rawDifferences.length, 6);
    const callers = JSON.parse(await readRegular(path.join(HERE, 'evidence/host-list-factory-callers.json')));
    assert.equal(callers.sourceCommit, lock.source.commit); assert.equal(callers.fullCompilerBuilt, false);
    for (const caller of callers.callers) {
        assert.deepEqual(caller.source, closure.files.find(pin => pin.path === caller.source.path));
        verifyFile(await readRegular(path.join(SOURCE, caller.source.path)), caller.source);
    }
    if (artifactRoot) {
        artifactRoot = path.resolve(artifactRoot);
        assert(artifactRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(artifactRoot);
        for (const pin of receipt.outputs) {
            const bytes = await readRegular(path.join(artifactRoot, relativePath(pin.path)));
            assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Changed execution artifact: ' + pin.path);
        }
        const verified = await verifyJsAstPreparation(path.join(artifactRoot, 'common'));
        assert.deepEqual(verified.receipt, preparation);
        const raw = [];
        for (const filename of ['original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json', 'portable-chromium.json']) {
            raw.push(JSON.parse(await readRegular(path.join(artifactRoot, filename))));
        }
        assert.equal(raw[0].records.length, comparison.observations);
        assert.equal(sha256(Buffer.from(JSON.stringify(raw[0].records))), comparison.successfulAndFailureCategoryRecordsSha256);
        for (const observed of raw.slice(1)) assert.deepEqual(observed.records, raw[0].records);
        assert.deepEqual(receipt.rawFailures, { originalJvm: raw[0].failures, commonJvm: raw[1].failures,
            nodeWasm: raw[2].failures, offlineChromium: raw[3].failures });
        const old = [];
        for (const pin of negative.artifacts) {
            assert(relativePath(pin.path).startsWith('out/kotlin-js-ast/'));
            const bytes = await readRegular(path.join(REPO, pin.path));
            assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); old.push(JSON.parse(bytes));
        }
        const differences = old[0].records.flatMap((value, index) => value === old[2].records[index] ? [] :
            [{ index, originalJvm: value, nodeWasm: old[2].records[index] }]);
        assert.deepEqual(differences, negative.rawDifferences);
    }
    return { observations: comparison.observations, sourceBindingVerified: true, executionArtifactsVerified: !!artifactRoot,
        offlineChromiumWorker: true, retainedHostFactoryDifferences: negative.rawDifferences.length,
        fullCompilerBuilt: false, languageReadiness: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 2 && args[0] === '--artifacts'), 'Expected optional --artifacts <retained-output>');
    const receipt = JSON.parse(await readRegular(path.join(HERE, 'evidence/receipt.json')));
    console.log(JSON.stringify(await verifyEvidence(receipt, { artifactRoot: args[1] })));
}
