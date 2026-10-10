import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { verifyDescriptorPreparation } from '../descriptors/prepare.mjs';
import { frozenInputs } from '../k1-container-profile/check.mjs';
import { verifyVisitorVoidProfile } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export async function verifyVisitorVoidEvidence() {
    const manifest = JSON.parse(await readRegular(path.join(HERE, 'evidence/artifacts.json'), 8 * 1024 * 1024));
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'visitor-Void-profile-source-status-artifact-seal');
    const names = ['Probe.kt', 'StatementProbe.kt', 'README.md', 'prepare.mjs', 'probe.mjs', 'integrity.test.mjs',
        'transform.mjs', 'sources.lock.json', 'verify.mjs', 'evidence/runtime.json', 'evidence/runtime-status.json', 'evidence/guards-status.json'];
    assert.deepEqual(manifest.unitFiles.map(pin => pin.path).sort(), names.sort());
    for (const pin of manifest.unitFiles) {
        const bytes = await readRegular(path.join(HERE, relativePath(pin.path)), 32 * 1024 * 1024);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    }
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    const artifactRoot = path.join(REPO, relativePath(manifest.artifactRoot)); assert(artifactRoot.startsWith(path.join(REPO, 'out') + path.sep));
    const runtimeBytes = await readRegular(path.join(HERE, 'evidence/runtime.json'), 32 * 1024 * 1024), runtime = JSON.parse(runtimeBytes);
    assert.deepEqual(runtimeBytes, await readRegular(path.join(artifactRoot, 'receipt.json'), 32 * 1024 * 1024));
    assert.equal(runtime.sourceLockSha256, sha256(await readRegular(path.join(HERE, 'sources.lock.json'))));
    assert.equal(runtime.buildToolSha256, sha256(await readRegular(path.join(HERE, 'probe.mjs'))));
    assert.deepEqual(manifest.artifacts, runtime.artifacts);
    for (const pin of runtime.artifacts) {
        const bytes = await readRegular(path.join(artifactRoot, relativePath(pin.path)), 32 * 1024 * 1024);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    }
    for (const name of ['runtime', 'guards']) {
        const status = JSON.parse(await readRegular(path.join(HERE, 'evidence/' + name + '-status.json')));
        assert.equal(status.status, 'exited'); assert.equal(status.exitCode, 0); assert(status.pid > 0 && status.elapsedSeconds > 0);
    }
    assert.equal(manifest.guardsPassed, 7);
    for (const key of ['fullActualSixSourcesJvmCompiled', 'unchangedGeneratedBaseAndCompleteVisitorCompiled', 'originalJvmEqualsCommonJvm',
        'allFourteenNullableBodiesPreserved', 'threeSourceOwnerNullMessagesObserved']) assert.equal(runtime[key], true);
    assert.equal(runtime.actualReceivers, 17); assert.equal(runtime.observations, 459);
    for (const key of ['rawOutputNormalized', 'javaDescriptorImplementationFamilyClosed', 'fullCompilerBuilt', 'languageReadiness']) assert.equal(runtime[key], false);
    assert.equal(runtime.browserRuntime, 'not-run'); assert.equal(runtime.wasmRuntime, 'bounded-standard-function-statements-only');
    assert(runtime.commands.length > 0); for (const command of runtime.commands) assert.equal(command.exitCode, 0);
    const original = await readRegular(path.join(artifactRoot, 'original-observations.txt'));
    assert.deepEqual(await readRegular(path.join(artifactRoot, 'common-observations.txt')), original);
    assert.equal(original.toString().trimEnd().split('\n').length, 459);
    const projection = runtime.statementProjection;
    assert.equal(projection.statements, 14); assert.equal(projection.observations, 378);
    assert.equal(projection.commonJvmEqualsNodeWasmAndOriginalSelectedRecords, true);
    assert.equal(projection.unsupportedHelperBodiesNotProjected.length, 3);
    assert.equal(projection.fullDescriptorVisitorGraphWasmExecuted, false); assert.equal(projection.normalizedText, false);
    const statementJvm = await readRegular(path.join(artifactRoot, 'statement-common-jvm-observations.txt'));
    assert.deepEqual(await readRegular(path.join(artifactRoot, 'statement-common-wasm-observations.txt')), statementJvm);
    const owners = projection.statementMappings.map(item => item.owner); assert.equal(new Set(owners).size, 14);
    const selected = original.toString().split('\n').filter(line => owners.some(owner => line.startsWith(owner + ':'))).join('\n') + '\n';
    assert.equal(statementJvm.toString(), selected); assert.equal(statementJvm.toString().trimEnd().split('\n').length, 378);
    const recipes = lock.recipes.filter(recipe => !/shouldNotBeCalled|unsupportedInIrBasedDescriptor/.test(recipe.originalBody));
    assert.deepEqual(owners, recipes.map(recipe => recipe.owner));
    const expectedStatements = 'package org.jetbrains.kotlin.portable.visitorvoid.statements\n\n' +
        'typealias VoidCallback = (Any, Nothing?) -> Nothing?\ntypealias VoidStatement = Any.(VoidCallback?) -> Unit\n\n' +
        recipes.map((recipe, index) => {
            const body = recipe.prepared.slice(recipe.prepared.indexOf('{'));
            const calls = [...body.matchAll(/\.((?:visit)\w+)\(this, null\)/g)];
            assert.equal(calls.length, recipe.owner.endsWith('.ErrorModuleDescriptor') ? 0 : 1);
            const mapped = body.replace(/\.(?:visit)\w+\(this, null\)/g, '.invoke(this, null)');
            const observation = projection.statementMappings[index];
            assert.equal(observation.preparedDeclarationSha256, sha256(Buffer.from(recipe.prepared)));
            assert.equal(observation.originalBodySha256, sha256(Buffer.from(recipe.originalBody)));
            assert.equal(observation.observerBodySha256, sha256(Buffer.from(mapped)));
            assert.equal(observation.actualMethod, calls[0]?.[1] ?? null);
            return 'fun Any.statement' + index + '(visitor: VoidCallback?) ' + mapped;
        }).join('\n\n') + '\n\nval statementBodies: List<Pair<String, VoidStatement>> = listOf(' +
        recipes.map((recipe, index) => JSON.stringify(recipe.owner) + ' to Any::statement' + index).join(',') + ')\n';
    assert.equal((await readRegular(path.join(artifactRoot, 'VoidStatements.kt'))).toString(), expectedStatements);
    for (const record of runtime.commonCompilationImports) {
        const source = await readRegular(path.join(artifactRoot, 'profile', relativePath(record.path)));
        assert.equal(sha256(source), record.sourceSha256); assert.equal(record.import, 'org.jetbrains.kotlin.portable.descriptors.*');
        const text = source.toString(), declaration = /^package[^\r\n]+/m.exec(text); assert(declaration);
        const end = declaration.index + declaration[0].length;
        const expected = Buffer.from(text.slice(0, end) + '\nimport ' + record.import + '\n' + text.slice(end));
        assert.equal(sha256(expected), record.preparedJvmSha256);
        assert.deepEqual(await readRegular(path.join(artifactRoot, 'common-jvm', record.path)), expected);
    }
    assert.equal(runtime.commonCompilationImports.length, 6);
    const descriptorRoot = path.join(artifactRoot, 'descriptor-predecessor'), checked = await verifyDescriptorPreparation(descriptorRoot);
    const preparedDescriptors = { outputRoot: descriptorRoot, receipt: checked.receipt, sourceFiles: checked.sourceFiles, propertyAliasImport: checked.propertyAliasImport };
    const priorLock = JSON.parse(await readRegular(path.join(HERE, '../descriptor-visitor-contract/sources.lock.json')));
    const frozen = await frozenInputs(path.join(REPO, 'out/kotlin-compiler-port/builds/consumer-bindings-whole-1791638978998014789'));
    assert.deepEqual(frozen.binding, runtime.historicalSelection);
    const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
    const retainedSources = frozen.retainedSources.map(pin => {
        const previous = priorLock.preparedOutputs.find(item => item.path === pin.path);
        if (previous) return { path: pin.path, filename: path.join(artifactRoot, 'visitor-predecessor', pin.path), bytes: previous.bytes, sha256: previous.sha256 };
        const original = priorLock.originals.find(item => item.path === pin.path);
        if (original) return { path: pin.path, filename: path.join(sourceRoot, pin.path), bytes: original.bytes, sha256: original.sha256 };
        const name = pin.path === 'compiler-port-descriptors/generated/DeclarationDescriptor.kt' ? 'DeclarationDescriptor.kt' :
            pin.path === 'compiler-port-descriptors/generated/DeclarationDescriptorVisitor.kt' ? 'DeclarationDescriptorVisitor.kt' : null;
        if (!name) return pin;
        const generated = checked.receipt.files.find(item => item.path === name);
        return { path: pin.path, filename: generated.absolutePath, bytes: generated.bytes, sha256: generated.sha256 };
    });
    assert.deepEqual(await readRegular(path.join(artifactRoot, 'common-dependencies/DescriptorProperties.kt')),
        await readRegular(checked.receipt.files.find(pin => pin.path === 'DescriptorProperties.kt').absolutePath));
    assert.deepEqual(await readRegular(path.join(artifactRoot, 'common-dependencies/ModuleDescriptor.kt')),
        await readRegular(path.join(artifactRoot, 'visitor-predecessor/core/descriptors/src/org/jetbrains/kotlin/descriptors/ModuleDescriptor.kt')));
    const previousRoot = path.join(artifactRoot, 'visitor-predecessor'), receiptPath = path.join(previousRoot, 'receipt.json');
    const descriptorVisitorComponent = { receiptPath, receipt: JSON.parse(await readRegular(receiptPath, 32 * 1024 * 1024)),
        commonSources: priorLock.preparedOutputs.map(pin => path.join(previousRoot, pin.path)) };
    const verified = await verifyVisitorVoidProfile({ sourceRoot, outputRoot: path.join(artifactRoot, 'profile'), preparedDescriptors, descriptorVisitorComponent, retainedSources });
    assert.deepEqual(verified.receipt, runtime.preparation);
    return { unitFiles: manifest.unitFiles.length + 1, artifacts: runtime.artifacts.length, actualReceivers: 17, originalCommonJvmObservations: 459,
        primitiveStatementWasmObservations: 378, guardsPassed: 7, javaDescriptorImplementationFamilyClosed: false, fullCompilerBuilt: false, languageReadiness: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(JSON.stringify(await verifyVisitorVoidEvidence())); } catch (error) { console.error(error); process.exitCode = 1; }
}
