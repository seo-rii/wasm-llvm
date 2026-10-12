import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { bindNativeLoweringPhaseBoundary, PHASE_BOUNDARIES } from './phase-boundary.mjs';
import { verifyNativeJsOutputFinalSources } from './final.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const ASSERTION = 'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert';
const HELPER = 'compiler-port-lowering-phase-factories/LoweringPassFactory.kt';
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
async function pin(filename) { return { filename, ...identity(await readRegular(filename, 64 * 1024 * 1024)) }; }

export async function runNativePhaseComposition(outputRoot, contextHelper = '/tmp/kotlin-native-phase-context.mjs') {
    outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out/kotlin-native-phase-focused-')));
    await mkdir(outputRoot, { mode: 0o700 });
    const start = performance.now(), inputs = [], passed = [], rejected = [];
    const originalHelperPin = await pin(contextHelper), helperCopy = path.join(outputRoot, 'native-phase-context.mjs');
    await copyFile(contextHelper, helperCopy); assert.equal((await pin(helperCopy)).sha256, originalHelperPin.sha256);
    inputs.push(originalHelperPin);
    const { prepareRecordedNativePhaseContext } = await import(pathToFileURL(helperCopy).href);
    const jobFile = '/tmp/wasm-kotlin-class-phase-literal-whole-job.json', job = JSON.parse(await readRegular(jobFile));
    const status = JSON.parse(await readRegular(job.status)); assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 1);
    const buildRoot = job.output, receiptFile = path.join(buildRoot, 'compiler-build-receipt.json');
    const wholeBytes = await readRegular(receiptFile, 64 * 1024 * 1024), whole = JSON.parse(wholeBytes);
    assert.equal(whole.status, 'failed'); assert.deepEqual(whole.commands, []);
    assert.equal(whole.failure, 'Pinned source content mismatch: ' + PHASE_BOUNDARIES[0]);
    for (const filename of [jobFile, job.status, job.log, job.runner, receiptFile]) inputs.push(await pin(filename));
    for (const name of ['final.mjs', 'phase-boundary.mjs', 'sources.lock.json', 'update-recipe.mjs', 'phase-composition.mjs', 'README.md']) inputs.push(await pin(path.join(HERE, name)));
    const { TARGET: SERVICE } = await import('../service-loader-profile/prepare.mjs');
    const rows = whole.serviceLoaderProfileReceipt.selection.sources.filter(row => row.path !== SERVICE)
        .map(({ path, filename, bytes, sha256 }) => ({ path, filename, bytes, sha256 }));
    assert.equal(rows.length, 3550);
    async function checkActual() { for (let n = 0; n < rows.length; n += 24) {
        const batch = await Promise.allSettled(rows.slice(n, n + 24).map(async row => assert.deepEqual(await pin(row.filename), { filename: row.filename, bytes: row.bytes, sha256: row.sha256 })));
        for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
    } }
    await checkActual();
    const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
    const context = await prepareRecordedNativePhaseContext({ sourceRoot, outputRoot: path.join(outputRoot, 'context'),
        buildRoot, priorHead: job.head, wholeReceipt: whole });
    const properties = whole.propertyImports.imports;
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    const bindOptions = { sourceRoot, boundary: context.phaseOptions, retainedSources: rows,
        recordedPropertyImports: properties, requiredBoundaries: lock.requiredBoundaries, source: lock.source };
    const options = { sourceRoot, outputRoot: context.nativeContextRoot, receiptPath: context.preparedNative.receiptPath,
        preparedBackendProfile: context.backend, preparedProfile: context.preparedNative, retainedSources: rows,
        verifiedModuleBoundary: { outputRoot: path.join(buildRoot, 'components/moduleRequirePathsReceipt'), final: whole.moduleRequirePathsFinalReceipt },
        verifiedLoweringPhaseBoundary: context.phaseOptions, allowedAddedImports: ['kotlin.jvm.*', ...properties, ASSERTION] };
    let serial = 0;
    const native = changes => verifyNativeJsOutputFinalSources({ ...options, ...changes,
        finalOutputRoot: path.join(context.nativeContextRoot, 'focused-final-' + (++serial)) });
    async function rejects(name, action, reason) {
        let failure;
        try { await action(); } catch (error) { failure = error; }
        assert(failure, 'Negative accepted: ' + name);
        assert(reason.test(String(failure.message)), 'Wrong failure reason for ' + name + ': ' + failure.message);
        assert(!/EEXIST|ENOENT/.test(String(failure.message)), 'Filesystem failure cannot prove a guard');
        rejected.push({ name, reason: reason.source, actual: failure.message });
    }
    console.log('phase: actual public phase binding and native final positive');
    const phase = await bindNativeLoweringPhaseBoundary(bindOptions); assert.equal(phase.receipt.checked.length, 6);
    passed.push('actual-six-phase-output-binding');
    const first = await native(); assert.equal(first.receipt.inspectedFiles, 3550);
    assert.equal(first.receipt.loweringPhaseFactoryBinding.checked.length, 6);
    assert.equal(first.receipt.retainedBoundaryBindings.filter(row => row.adaptation?.component === 'loweringPhaseFactoriesReceipt').length, 2);
    assert.equal(first.receipt.retainedBoundaryBindings.length, 21); assert.equal(first.receipt.existingSplitBindings.length, 4);
    assert.deepEqual(first.receipt.incoming, []); passed.push('actual-native-final-positive');
    console.log('phase: reason-matched optional phase binding negatives');
    await rejects('unbound-phase-overlay', () => native({ verifiedLoweringPhaseBoundary: undefined }), /Pinned source content mismatch: .*JsLoweringPhases/);
    await rejects('missing-external-phase-digest', () => bindNativeLoweringPhaseBoundary({ ...bindOptions, boundary: { ...context.phaseOptions, expectedReceiptSha256: undefined } }), /External phase preparation receipt digest required/);
    await rejects('wrong-external-phase-digest', () => bindNativeLoweringPhaseBoundary({ ...bindOptions, boundary: { ...context.phaseOptions, expectedReceiptSha256: '0'.repeat(64) } }), /Phase receipt digest changed/);
    await rejects('foreign-canonical-source-root', () => bindNativeLoweringPhaseBoundary({ ...bindOptions, boundary: { ...context.phaseOptions, sourceRoot: outputRoot } }), /Native and phase canonical source roots differ/);
    await rejects('missing-actual-phase-helper', () => bindNativeLoweringPhaseBoundary({ ...bindOptions, retainedSources: rows.filter(row => row.path !== HELPER) }), /Missing phase final source/);
    await rejects('only-two-overlap-outputs', () => bindNativeLoweringPhaseBoundary({ ...bindOptions, retainedSources: rows.filter(row => PHASE_BOUNDARIES.includes(row.path)) }), /Missing phase final source/);
    const js = rows.find(row => row.path === PHASE_BOUNDARIES[0]), copy = path.join(outputRoot, 'identical-js-phase.kt');
    await copyFile(js.filename, copy);
    await rejects('identical-phase-owner-switch', () => bindNativeLoweringPhaseBoundary({ ...bindOptions, retainedSources: rows.map(row => row === js ? { ...row, filename: copy } : row) }), /Wrong phase final owner/);
    await rejects('forged-live-phase-row-hash', () => bindNativeLoweringPhaseBoundary({ ...bindOptions, retainedSources: rows.map(row => row === js ? { ...row, sha256: '0'.repeat(64) } : row) }), /Phase final source hash changed/);
    const nativeBefore = await readRegular(context.preparedNative.receiptPath);
    async function forgedPrior(name, edit, reason) {
        const receipt = JSON.parse(nativeBefore), selected = receipt.retainedBoundaries.find(row => row.originalPath === js.path);
        edit(selected); const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
        assert(context.preparedNative.receiptPath.startsWith(outputRoot + path.sep));
        try {
            await writeFile(context.preparedNative.receiptPath, bytes);
            await rejects(name, () => native({ preparedProfile: { ...context.preparedNative, receipt, receiptSha256: sha256(bytes) } }), reason);
        } finally { await writeFile(context.preparedNative.receiptPath, nativeBefore); }
    }
    await forgedPrior('rehashed-prior-canonical-phase-body', row => {
        const bytes = Buffer.concat([Buffer.from(row.source, 'base64'), Buffer.from('\n// forged prior body\n')]);
        Object.assign(row, identity(bytes), { source: bytes.toString('base64') });
    }, /Pinned source content mismatch: .*JsLoweringPhases/);
    await forgedPrior('forged-prior-phase-owner', row => { row.filename = copy; }, /Prior native phase owner changed/);
    const module = whole.moduleRequirePathsFinalReceipt;
    await rejects('unbound-current-module-graph', () => native({ verifiedModuleBoundary: { ...options.verifiedModuleBoundary,
        final: { ...module, final: { ...module.final, inputs: module.final.inputs.slice(1) } } } }), /Module proof does not bind current actual graph/);
    const source = 'package rejected\nimport org.jetbrains.kotlin.ir.backend.js.transformers.irToJs.' + lock.declarations[0].name + '\n';
    const incomingFile = path.join(outputRoot, 'incoming-native-output.kt'), incomingBytes = Buffer.from(source);
    await writeFile(incomingFile, incomingBytes, { flag: 'wx', mode: 0o600 });
    await rejects('actual-new-native-output-consumer', () => native({ retainedSources: [...rows,
        { path: 'injected/Incoming.kt', filename: incomingFile, ...identity(incomingBytes) }] }), /Actual selected native JS output consumer/);
    const { TARGET } = await import('./prepare.mjs'), originalFile = context.preparedNative.originalReferenceSources[0], originalBytes = await readRegular(originalFile);
    await rejects('excluded-native-output-reintroduction', () => native({ retainedSources: [...rows,
        { path: TARGET, filename: originalFile, ...identity(originalBytes) }] }), /Native JS output original reintroduced/);
    console.log('phase: restored actual native final');
    const restored = await native(); assert.deepEqual(restored.receipt, first.receipt); passed.push('restored-actual-native-positive');
    await checkActual();
    for (const input of inputs) assert.deepEqual(await pin(input.filename), input, 'Focused input changed');
    assert.deepEqual(await readRegular(context.preparedNative.receiptPath), nativeBefore);
    const receipt = { schemaVersion: 1, kind: 'native-phase-actual-composition-focused-integrity', result: 'pass',
        elapsedSeconds: (performance.now() - start) / 1000, inputs, historicalSources: rows, actualSelectedSources: 3550,
        failedActualCompilerCommands: 0, historicalFilesReadOnly: true, passed, rejected, nativeContextLineage: context.nativeContextLineage,
        currentPhase: phase.receipt, nativeFinal: restored.receipt, currentModuleProofCopiedFromFailedActual: true,
        priorCanonicalPhaseBodyAndOwnerRestored: true, legacyBranchStatus: 'Existing historical no-phase positive remains preserved; optional branch is absent by default and its original boundary checks are unchanged.',
        newCompilerOrRuntimeCommandExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
    await writeJson(path.join(outputRoot, 'final-options.json'), options);
    console.log(JSON.stringify({ result: 'pass', outputRoot, actualSources: 3550, rejected: rejected.length, elapsedSeconds: receipt.elapsedSeconds }));
    return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 3, 'Usage: phase-composition.mjs NEW_OUTPUT_ROOT');
    await runNativePhaseComposition(process.argv[2]);
}
