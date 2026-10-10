import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { verifyDescriptorPreparation } from '../descriptors/prepare.mjs';
import { frozenInputs } from '../k1-container-profile/check.mjs';
import { OUTPUT, inspectVisitorConsumers } from './transform.mjs';
import { verifyDescriptorVisitorContracts } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export async function verifyVisitorEvidence() {
    const manifest = JSON.parse(await readRegular(path.join(HERE, 'evidence/artifacts.json'), 8 * 1024 * 1024));
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'descriptor-visitor-source-status-artifact-seal');
    const required = ['GuardProbe.kt', 'Probe.kt', 'README.md', 'check.mjs', 'integrity.test.mjs', 'prepare.mjs',
        'sources.lock.json', 'transform.mjs', 'verify.mjs', 'evidence/runtime.json', 'evidence/runtime-status.json', 'evidence/guards-status.json'];
    assert.deepEqual(manifest.unitFiles.map(pin => pin.path).sort(), required.sort());
    for (const pin of manifest.unitFiles) {
        relativePath(pin.path); const bytes = await readRegular(path.join(HERE, pin.path), 32 * 1024 * 1024);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Changed unit file: ' + pin.path);
    }
    const runtime = JSON.parse(await readRegular(path.join(HERE, 'evidence/runtime.json'), 32 * 1024 * 1024));
    assert.deepEqual(await readRegular(path.join(REPO, relativePath(manifest.artifactRoot), 'receipt.json')),
        await readRegular(path.join(HERE, 'evidence/runtime.json')));
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(runtime.sourceLockSha256, sha256(lockBytes));
    assert.equal(runtime.buildToolSha256, sha256(await readRegular(path.join(HERE, 'check.mjs'))));
    const artifactRoot = path.join(REPO, relativePath(manifest.artifactRoot));
    assert(artifactRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert.deepEqual(manifest.artifacts, runtime.outputs);
    for (const pin of manifest.artifacts) {
        relativePath(pin.path); const bytes = await readRegular(path.join(artifactRoot, pin.path), 32 * 1024 * 1024);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Changed probe artifact: ' + pin.path);
    }
    for (const name of ['runtime', 'guards']) {
        const status = JSON.parse(await readRegular(path.join(HERE, 'evidence/' + name + '-status.json')));
        assert.equal(status.status, 'exited'); assert.equal(status.exitCode, 0); assert(status.pid > 0 && status.elapsedSeconds > 0);
    }
    assert.equal(manifest.guardsPassed, 8);
    for (const key of ['originalJvmEqualsCommonJvm', 'actualNullableBaseModuleJvmEqualsOriginalJvm',
        'allTwentyNineNullableBodiesPreservedByExactSpans', 'originalVoidBodiesUnchanged']) assert.equal(runtime[key], true);
    assert.equal(runtime.originalNonnullGenericReceiversExecuted, 12); assert.equal(runtime.nullableFirReceiversExecuted, 2);
    assert.equal(runtime.portableVoidTypeMappingClosed, false);
    assert.equal(runtime.actualModuleImplPortableTypecheck, 'expected-failure-unclosed-Void');
    assert.equal(runtime.generatedVisitorReturnContract.unchangedReturns, 'R');
    assert.equal(runtime.generatedVisitorReturnContract.exactTwelveGenericBodiesActualReceiverJvmProjection, true);
    assert(runtime.generatedVisitorReturnContract.preservedVoidDiagnostics.length > 0);
    assert.equal(runtime.nullEntryProjection.statements, 12); assert.equal(runtime.nullEntryProjection.observations, 24);
    assert.equal(runtime.nullEntryProjection.originalActualReceiversNullMatchesCommonJvmAndNodeWasm, true);
    assert.equal(runtime.nullEntryProjection.commonJvmEqualsNodeWasm, true);
    for (const value of [runtime.nullEntryProjection.normalizedText, runtime.rawOutputNormalized, runtime.legacyDefaultImplsMessageParity,
        runtime.fullCompilerBuilt, runtime.languageReadiness]) assert.equal(value, false);
    assert.equal(runtime.browserRuntime, 'not-run');
    const original = await readRegular(path.join(artifactRoot, 'original-observations.txt'));
    for (const name of ['common-observations.txt', 'nullable-base-observations.txt'])
        assert.deepEqual(await readRegular(path.join(artifactRoot, name)), original);
    assert.equal(original.toString().trimEnd().split('\n').length, runtime.observations);
    const entryJvm = await readRegular(path.join(artifactRoot, 'entry-common-jvm-observations.txt'));
    assert.deepEqual(await readRegular(path.join(artifactRoot, 'entry-common-wasm-observations.txt')), entryJvm);
    const selectedEntry = text => text.split('\n').filter(line => line.startsWith('entry-check:')).join('\n');
    assert.equal(selectedEntry(entryJvm.toString()), selectedEntry(original.toString()));
    const negativePhases = ['unclosed-full-real-sources-generated-Visitor-Void-negative-jvm-build',
        'unclosed-module-impl-Void-mapping-negative-jvm-build', 'previous-nonnull-module-against-nullable-base-negative-jvm-build'];
    for (const phase of negativePhases) assert.equal(runtime.commands.find(command => command.phase === phase)?.exitCode, 1);
    assert.equal(runtime.commands.filter(command => command.exitCode !== 0).length, 3);
    const negativeErrors = await Promise.all(negativePhases.map(async phase =>
        (await readRegular(path.join(artifactRoot, phase + '-stderr.txt'))).toString().split('\n').filter(line => line.includes('error:'))));
    assert.deepEqual(negativeErrors[0], runtime.generatedVisitorReturnContract.preservedVoidDiagnostics);
    assert.equal(negativeErrors[0].length, 13);
    for (const line of negativeErrors[0]) assert(line.endsWith("error: null cannot be a value of a non-null type 'Void'."));
    assert.equal(negativeErrors[1].length, 1);
    assert(negativeErrors[1][0].startsWith('original/core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/ModuleDescriptorImpl.kt:28:1: error:'));
    assert.equal(negativeErrors[2].length, 1);
    assert(negativeErrors[2][0].includes("error: 'accept' overrides nothing."));
    const descriptorRoot = path.join(artifactRoot, 'descriptor-predecessor');
    const checked = await verifyDescriptorPreparation(descriptorRoot);
    const preparedDescriptors = { outputRoot: descriptorRoot, receipt: checked.receipt, sourceFiles: checked.sourceFiles };
    const frozen = await frozenInputs(path.join(REPO, 'out/kotlin-compiler-port/builds/ast-dsl-whole-1791633110599192554'));
    const historical = [];
    for (const pin of frozen.retainedSources) {
        const source = await readRegular(pin.filename); assert.equal(source.length, pin.bytes); assert.equal(sha256(source), pin.sha256);
        historical.push({ path: pin.path, source });
    }
    assert.deepEqual({ ...frozen.binding, ...inspectVisitorConsumers(historical, lock.contracts) }, runtime.historicalSelectedSourceAudit);
    const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
    const retainedSources = frozen.retainedSources.map(pin => {
        const original = lock.originals.find(item => item.path === pin.path);
        if (original) return { path: pin.path, filename: path.join(sourceRoot, pin.path), bytes: original.bytes, sha256: original.sha256 };
        const generatedName = pin.path === OUTPUT ? 'DeclarationDescriptor.kt' :
            pin.path === 'compiler-port-descriptors/generated/DeclarationDescriptorVisitor.kt' ? 'DeclarationDescriptorVisitor.kt' : null;
        if (!generatedName) return pin;
        const generated = checked.receipt.files.find(item => item.path === generatedName);
        return { path: pin.path, filename: generated.absolutePath, bytes: generated.bytes, sha256: generated.sha256 };
    });
    const verified = await verifyDescriptorVisitorContracts({ sourceRoot, profileRoot: path.join(artifactRoot, 'profile'), preparedDescriptors, retainedSources });
    assert.deepEqual(verified.receipt, runtime.preparation);
    return { unitFiles: manifest.unitFiles.length, artifacts: manifest.artifacts.length, observations: runtime.observations,
        exactEntryWasmObservations: 24, preservedNegatives: 3, guardsPassed: 8, fullCompilerBuilt: false, languageReadiness: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(JSON.stringify(await verifyVisitorEvidence())); }
    catch (error) { console.error(error); process.exitCode = 1; }
}
